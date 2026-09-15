import { getQuickJS, QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import { z } from 'zod';
import { createBase64Artifact, createTextArtifact, readArtifactMeta, readArtifactText } from '../memory/artifactStore';
import { saveDecision } from '../memory/decisions';
import { FileStore } from '../memory/fileStore';
import { rememberFact } from '../memory/facts';
import { readSecrets } from '../memory/secrets';
import { ChatMessage } from '../messaging/types';
import { safeHttpRequest } from '../tools/safeHttp';
import { logger } from '../utils/logger';
import { normalizeSkillRunResultInput, SkillRunResult, skillRunResultSchema, textSkillResult } from './result';
import type { SkillRuntimeOptions } from './runtime';
import { SkillPackage } from './schema';

const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;
const SCRIPT_MEMORY_BYTES = 8 * 1024 * 1024;
const SCRIPT_MAX_STACK_BYTES = 512 * 1024;
const SCRIPT_MAX_OUTPUT_BYTES = 3145728;
const SCRIPT_MAX_STATE_BYTES = 1048576;
const SCRIPT_MAX_HTTP_CALLS = 16;
const SCRIPT_MAX_MCP_CALLS = 24;
const SCRIPT_MAX_SLEEP_MS = 1000;
const SCRIPT_MAX_LOGS = 32;
const SCRIPT_MAX_LOG_BYTES = 500;

const listSchema = z.object({ items: z.array(z.object({ text: z.string(), createdAt: z.string() })) });

const forbiddenPatterns: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brequire\s*\(/, label: 'require' },
  { pattern: /\bprocess\b/, label: 'process' },
  { pattern: /\bimport\s*(?:\(|[^([])/, label: 'import' },
  { pattern: /\beval\s*\(/, label: 'eval' },
  { pattern: /\bFunction\s*\(/, label: 'Function' },
  { pattern: /\bfetch\s*\(/, label: 'fetch' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
  { pattern: /\bWorker\b/, label: 'Worker' },
  { pattern: /\bfs\b/, label: 'fs' },
  { pattern: /\bchild_process\b/, label: 'child_process' },
  { pattern: /\bDeno\b/, label: 'Deno' },
  { pattern: /\bBun\b/, label: 'Bun' },
  { pattern: /\bwhile\s*\(\s*true\s*\)/, label: 'while(true)' },
  { pattern: /\bfor\s*\(\s*;\s*;\s*\)/, label: 'for(;;)' },
];

export function validateScriptedSkill(skill: SkillPackage): string[] {
  const errors: string[] = [];
  if (Buffer.byteLength(skill.pluginJs, 'utf8') > 12000) errors.push('plugin.js is too large');
  for (const item of forbiddenPatterns) {
    if (item.pattern.test(skill.pluginJs)) errors.push(`forbidden token: ${item.label}`);
  }
  if (!buildPluginSource(skill.pluginJs)) errors.push('plugin.js must export/default an object with tools');
  for (const trigger of skill.triggers) {
    if (!(trigger.tool in skill.tools)) errors.push(`trigger references unknown tool: ${trigger.tool}`);
  }
  return errors;
}

export async function runPackageTool(
  store: FileStore,
  skill: SkillPackage,
  toolName: string,
  args: Record<string, unknown>,
  message: ChatMessage,
  options: SkillRuntimeOptions,
): Promise<SkillRunResult | null> {
  if (!(toolName in skill.tools)) {
    return textSkillResult(`Навык ${skill.title} не содержит tool ${toolName}.`);
  }
  const validation = validateScriptedSkill(skill);
  if (validation.length) {
    await auditScriptRun(store, skill, toolName, 'validation_failed', { errors: validation });
    return textSkillResult(`Навык ${skill.title} не прошёл проверку: ${validation.join(', ')}.`);
  }

  try {
    const result = await executeQuickJs(store, skill, toolName, args, message, options);
    await auditScriptRun(store, skill, toolName, 'ok', { result: result.value, logs: result.logs });
    return result.value;
  } catch (error) {
    logger.warn('Skill package tool failed', { skillId: skill.id, toolName, error });
    await auditScriptRun(store, skill, toolName, 'failed', {
      error: humanError(error),
      logs: error instanceof ScriptedSkillError ? error.logs : [],
    });
    return textSkillResult(`Навык ${skill.title} не выполнился.`);
  }
}

async function executeQuickJs(
  store: FileStore,
  skill: SkillPackage,
  toolName: string,
  args: Record<string, unknown>,
  message: ChatMessage,
  options: SkillRuntimeOptions,
): Promise<{ value: SkillRunResult | null; logs: string[] }> {
  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
  let httpCalls = 0;
  let mcpCalls = 0;
  const scriptState = await readScriptState(store, skill);
  let scriptStateDirty = false;

  const allSecrets = await readSecrets(store);
  const allowedSecrets: Record<string, string> = {};
  for (const key of skill.permissions.secrets) {
    if (key in allSecrets) allowedSecrets[key] = allSecrets[key]!;
  }

  const deferreds: Array<{ dispose: () => void }> = [];
  const logs: string[] = [];
  let vmAlive = true;

  try {
    vm.runtime.setMemoryLimit(SCRIPT_MEMORY_BYTES);
    vm.runtime.setMaxStackSize(SCRIPT_MAX_STACK_BYTES);
    vm.runtime.setInterruptHandler(() => Date.now() > deadline);

    setGlobalJson(vm, '__ctxJson', buildScriptContext(skill, message));
    setGlobalJson(vm, '__argsJson', args);
    setGlobalString(vm, '__toolName', toolName);

    setPromiseHostFunction(vm, deferreds, '__hostHttpRequest', async (requestHandle) => {
      const request = parseHostJson(vm.getString(requestHandle)) as { method?: string; url?: string; headers?: Record<string, string>; body?: string };
      try {
        if (Date.now() > deadline) throw new Error('script timeout');
        if (httpCalls >= SCRIPT_MAX_HTTP_CALLS) throw new Error('too many HTTP calls');
        httpCalls += 1;
        const body = typeof request.body === 'string' ? request.body : undefined;
        const effectiveOrigins = computeEffectiveHttpOrigins(skill.permissions.httpOrigins, options.httpAllowedOrigins);
        const value = await safeHttpRequest(
          {
            url: String(request.url ?? ''),
            method: request.method ?? 'GET',
            headers: request.headers ?? {},
            body,
          },
          {
            allowedOrigins: effectiveOrigins,
            blockedHosts: options.httpBlockedHosts,
            allowedPrivateHosts: options.httpAllowedPrivateHosts,
            timeoutMs: options.httpTimeoutMs,
            maxRequestBytes: options.httpMaxRequestBytes,
            maxResponseBytes: options.httpMaxResponseBytes,
          },
        );
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);

    setPromiseHostFunction(vm, deferreds, '__hostMcpListServers', async () => {
      try {
        if (!options.mcp) throw new Error('MCP is not enabled');
        if (Date.now() > deadline) throw new Error('script timeout');
        const value = await options.mcp.listAllowedServers({ store, chatId: message.chatId });
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostMcpListTools', async (serverIdHandle) => {
      try {
        if (!options.mcp) throw new Error('MCP is not enabled');
        if (Date.now() > deadline) throw new Error('script timeout');
        const rawServerId = vm.getString(serverIdHandle).trim();
        const value = await options.mcp.listAllowedTools({
          store,
          chatId: message.chatId,
          serverId: rawServerId || undefined,
        });
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostMcpCallTool', async (serverIdHandle, toolNameHandle, argsHandle) => {
      try {
        if (!options.mcp) throw new Error('MCP is not enabled');
        if (Date.now() > deadline) throw new Error('script timeout');
        if (mcpCalls >= SCRIPT_MAX_MCP_CALLS) throw new Error('too many MCP calls');
        mcpCalls += 1;
        const value = await options.mcp.callTool({
          store,
          chatId: message.chatId,
          serverId: assertMcpName(vm.getString(serverIdHandle), 'serverId'),
          toolName: assertMcpName(vm.getString(toolNameHandle), 'toolName'),
          args: parseHostJson(vm.getString(argsHandle)) as Record<string, unknown>,
          timeoutMs: options.mcpTimeoutMs ?? 20000,
          maxResponseBytes: options.mcpMaxResponseBytes ?? 262144,
        });
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostMcpReadResource', async (serverIdHandle, uriHandle) => {
      try {
        if (!options.mcp) throw new Error('MCP is not enabled');
        if (Date.now() > deadline) throw new Error('script timeout');
        if (mcpCalls >= SCRIPT_MAX_MCP_CALLS) throw new Error('too many MCP calls');
        mcpCalls += 1;
        const value = await options.mcp.readResource({
          store,
          chatId: message.chatId,
          serverId: assertMcpName(vm.getString(serverIdHandle), 'serverId'),
          uri: vm.getString(uriHandle),
          timeoutMs: options.mcpTimeoutMs ?? 20000,
          maxResponseBytes: options.mcpMaxResponseBytes ?? 262144,
        });
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);

    setSyncHostFunction(vm, '__hostStorageGet', (keyHandle) => {
      assertStorageAllowed(skill);
      const key = assertStorageKey(vm.getString(keyHandle));
      return JSON.stringify(scriptState[key] ?? null);
    });
    setSyncHostFunction(vm, '__hostStorageSet', (keyHandle, valueHandle) => {
      assertStorageAllowed(skill);
      const key = assertStorageKey(vm.getString(keyHandle));
      const value = parseHostJson(vm.getString(valueHandle));
      if (value === null) delete scriptState[key];
      else scriptState[key] = value;
      scriptStateDirty = true;
      return JSON.stringify(true);
    });
    setSyncHostFunction(vm, '__hostStorageDelete', (keyHandle) => {
      assertStorageAllowed(skill);
      const key = assertStorageKey(vm.getString(keyHandle));
      delete scriptState[key];
      scriptStateDirty = true;
      return JSON.stringify(true);
    });
    setPromiseHostFunction(vm, deferreds, '__hostListGet', async (nameHandle) => {
      const name = assertListName(vm.getString(nameHandle));
      const list = await store.readJson(listSchema, { items: [] }, 'chat', 'lists', `${name}.json`);
      return JSON.stringify(list.items);
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostListAppend', async (nameHandle, itemHandle) => {
      const name = assertListName(vm.getString(nameHandle));
      const item = vm.getString(itemHandle);
      const list = await store.readJson(listSchema, { items: [] }, 'chat', 'lists', `${name}.json`);
      const next = { items: [...list.items, { text: item, createdAt: new Date().toISOString() }] };
      await store.writeJson(next, 'chat', 'lists', `${name}.json`);
      return JSON.stringify(next.items);
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostListClear', async (nameHandle) => {
      const name = assertListName(vm.getString(nameHandle));
      await store.writeJson({ items: [] }, 'chat', 'lists', `${name}.json`);
      return JSON.stringify(true);
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostRememberFact', async (textHandle) => {
      await rememberFact(store, vm.getString(textHandle), `skill:${skill.id}`);
      return JSON.stringify(true);
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostSaveDecision', async (textHandle) => {
      await saveDecision(store, vm.getString(textHandle), `skill:${skill.id}`);
      return JSON.stringify(true);
    }, () => vmAlive);
    setSyncHostFunction(vm, '__hostSecretGet', (keyHandle) => {
      const key = vm.getString(keyHandle);
      return JSON.stringify(allowedSecrets[key] ?? null);
    });
    setSyncHostFunction(vm, '__hostLog', (messageHandle) => {
      const messageText = vm.getString(messageHandle).slice(0, SCRIPT_MAX_LOG_BYTES);
      if (logs.length < SCRIPT_MAX_LOGS) logs.push(messageText);
      logger.info('Skill package log', { skillId: skill.id, toolName, message: messageText });
      return JSON.stringify(true);
    });
    setPromiseHostFunction(vm, deferreds, '__hostSleep', async (msHandle) => {
      const ms = Math.max(0, Math.min(SCRIPT_MAX_SLEEP_MS, Math.floor(vm.getNumber(msHandle))));
      await new Promise((resolve) => setTimeout(resolve, ms));
      return JSON.stringify(true);
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostArtifactCreateText', async (specHandle) => {
      try {
        const spec = parseHostJson(vm.getString(specHandle)) as { filename?: unknown; mimeType?: unknown; text?: unknown };
        const value = await createTextArtifact(store, {
          filename: String(spec.filename ?? ''),
          mimeType: String(spec.mimeType ?? 'text/plain'),
          text: String(spec.text ?? ''),
        }, { kind: 'skill', id: skill.id });
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostArtifactCreateBase64', async (specHandle) => {
      try {
        const spec = parseHostJson(vm.getString(specHandle)) as { filename?: unknown; mimeType?: unknown; base64?: unknown };
        const value = await createBase64Artifact(store, {
          filename: String(spec.filename ?? ''),
          mimeType: String(spec.mimeType ?? 'application/octet-stream'),
          base64: String(spec.base64 ?? ''),
        }, { kind: 'skill', id: skill.id });
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostArtifactGetMeta', async (artifactIdHandle) => {
      try {
        const value = await readArtifactMeta(store, vm.getString(artifactIdHandle));
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);
    setPromiseHostFunction(vm, deferreds, '__hostArtifactReadText', async (artifactIdHandle) => {
      try {
        const value = await readArtifactText(store, vm.getString(artifactIdHandle));
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        return JSON.stringify({ ok: false, error: humanError(error) });
      }
    }, () => vmAlive);

    const pluginSource = buildPluginSource(skill.pluginJs);
    if (!pluginSource) throw new Error('plugin.js is not runnable');
    const evalResult = vm.evalCode(wrapPlugin(pluginSource), `${skill.id}/plugin.js`);
    if (evalResult.error) {
      const error = vm.dump(evalResult.error);
      evalResult.error.dispose();
      throw new Error(`QuickJS error: ${formatQuickJsError(error)}`);
    }

    const resultText = await readSettledString(vm, evalResult.value, deadline);
    evalResult.value.dispose();
    if (Buffer.byteLength(resultText, 'utf8') > SCRIPT_MAX_OUTPUT_BYTES) {
      throw new Error(`script output exceeds ${SCRIPT_MAX_OUTPUT_BYTES} bytes`);
    }
    const resultJson = parseHostJson(resultText);
    if (isScriptErrorResult(resultJson)) throw new Error(resultJson.__error);
    if (scriptStateDirty) await writeScriptState(store, skill, scriptState);
    const value = skillRunResultSchema.parse(normalizeSkillRunResultInput(resultJson));
    return { value: hasScriptResultOutput(value) ? value : null, logs };
  } catch (error) {
    throw error instanceof ScriptedSkillError ? error : new ScriptedSkillError(humanError(error), logs);
  } finally {
    vmAlive = false;
    try { drainPendingJobs(vm); } catch { /* dispose path */ }
    for (const deferred of deferreds.reverse()) {
      try { deferred.dispose(); } catch { /* ignore */ }
    }
    try { vm.dispose(); } catch (error) {
      logger.warn('QuickJS context disposal failed after skill package run', { skillId: skill.id, error: humanError(error) });
    }
  }
}

function hasScriptResultOutput(value: SkillRunResult): boolean {
  return Boolean(value.reply?.trim() || value.send?.length || value.data !== undefined || value.error);
}

class ScriptedSkillError extends Error {
  constructor(message: string, readonly logs: string[]) {
    super(message);
  }
}

function setGlobalJson(vm: QuickJSContext, name: string, value: unknown): void {
  setGlobalString(vm, name, JSON.stringify(value));
}

function setGlobalString(vm: QuickJSContext, name: string, value: string): void {
  const handle = vm.newString(value);
  vm.setProp(vm.global, name, handle);
  handle.dispose();
}

function setSyncHostFunction(
  vm: QuickJSContext,
  name: string,
  fn: (...args: QuickJSHandle[]) => string,
): void {
  const handle = vm.newFunction(name, (...args) => vm.newString(fn(...args)));
  vm.setProp(vm.global, name, handle);
  handle.dispose();
}

function setPromiseHostFunction(
  vm: QuickJSContext,
  deferreds: Array<{ dispose: () => void }>,
  name: string,
  fn: (...args: QuickJSHandle[]) => Promise<string>,
  isAlive: () => boolean,
): void {
  const handle = vm.newFunction(name, (...args) => {
    const deferred = vm.newPromise();
    deferreds.push(deferred);
    fn(...args).then(
      (value) => {
        if (!isAlive()) return;
        try {
          const valueHandle = vm.newString(value);
          deferred.resolve(valueHandle);
          valueHandle.dispose();
        } catch { /* vm disposed */ }
      },
      (error) => {
        if (!isAlive()) return;
        try {
          const errorHandle = vm.newError(error);
          deferred.reject(errorHandle);
          errorHandle.dispose();
        } catch { /* vm disposed */ }
      },
    );
    return deferred.handle;
  });
  vm.setProp(vm.global, name, handle);
  handle.dispose();
}

async function readSettledString(vm: QuickJSContext, handle: QuickJSHandle, deadline: number): Promise<string> {
  while (Date.now() <= deadline) {
    const state = vm.getPromiseState(handle);
    if (state.type === 'fulfilled') {
      const value = state.value;
      const text = vm.getString(value);
      if (!state.notAPromise) value.dispose();
      return text;
    }
    if (state.type === 'rejected') {
      const error = vm.dump(state.error);
      state.error.dispose();
      throw new Error(`QuickJS rejected: ${formatQuickJsError(error)}`);
    }
    executePendingJobs(vm, 16);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('script timeout');
}

function drainPendingJobs(vm: QuickJSContext): void {
  for (let i = 0; i < 16; i += 1) {
    const result = executePendingJobs(vm, 32);
    if (result === 0) return;
  }
}

function executePendingJobs(vm: QuickJSContext, maxJobs: number): number {
  const result: unknown = vm.runtime.executePendingJobs(maxJobs);
  if (typeof result === 'number') return result;
  if (!result || typeof result !== 'object') return 0;
  if ('error' in result) {
    const errorHandle = (result as { error?: QuickJSHandle }).error;
    const error = errorHandle ? vm.dump(errorHandle) : 'unknown pending job error';
    errorHandle?.dispose();
    throw new Error(`QuickJS pending job failed: ${formatQuickJsError(error)}`);
  }
  const disposable = result as { unwrap: () => number; dispose: () => void };
  const value = disposable.unwrap();
  disposable.dispose();
  return value;
}

function buildPluginSource(code: string): string | null {
  const source = code.trim()
    .replace(/^export\s+default\s+/, '')
    .replace(/^module\.exports\s*=\s*/, '')
    .replace(/;\s*$/, '');
  if (!source) return null;
  return source;
}

function wrapPlugin(pluginSource: string): string {
  return `
(async () => {
  const baseCtx = JSON.parse(__ctxJson);
  const args = JSON.parse(__argsJson);
  const toolName = String(__toolName);
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const httpRequest = async (request) => {
    const spec = typeof request === 'string' ? { url: request } : (request || {});
    const body = hasOwn(spec, 'body')
      ? (typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body))
      : undefined;
    const response = JSON.parse(await __hostHttpRequest(JSON.stringify({
      method: String(spec.method || 'GET'),
      url: String(spec.url || ''),
      headers: spec.headers || {},
      body
    })));
    if (!response.ok) throw new Error(response.error || 'HTTP request failed');
    return response.value;
  };
  const api = Object.freeze({
    http: Object.freeze({
      request: httpRequest,
      get: async (url, options = {}) => httpRequest({ ...options, method: 'GET', url }),
      post: async (url, body, options = {}) => httpRequest({ ...options, method: 'POST', url, body }),
      put: async (url, body, options = {}) => httpRequest({ ...options, method: 'PUT', url, body }),
      patch: async (url, body, options = {}) => httpRequest({ ...options, method: 'PATCH', url, body }),
      delete: async (url, options = {}) => httpRequest({ ...options, method: 'DELETE', url }),
    }),
    storage: Object.freeze({
      get: (key) => JSON.parse(__hostStorageGet(String(key))),
      set: (key, value) => JSON.parse(__hostStorageSet(String(key), JSON.stringify(value))),
      delete: (key) => JSON.parse(__hostStorageDelete(String(key))),
    }),
    lists: Object.freeze({
      list: async (name) => JSON.parse(await __hostListGet(String(name))),
      append: async (name, item) => JSON.parse(await __hostListAppend(String(name), String(item))),
      clear: async (name) => JSON.parse(await __hostListClear(String(name))),
    }),
    memory: Object.freeze({
      rememberFact: async (text) => JSON.parse(await __hostRememberFact(String(text))),
      saveDecision: async (text) => JSON.parse(await __hostSaveDecision(String(text))),
    }),
    artifacts: Object.freeze({
      createText: async (spec) => {
        const response = JSON.parse(await __hostArtifactCreateText(JSON.stringify(spec || {})));
        if (!response.ok) throw new Error(response.error || 'artifact createText failed');
        return response.value;
      },
      createBase64: async (spec) => {
        const response = JSON.parse(await __hostArtifactCreateBase64(JSON.stringify(spec || {})));
        if (!response.ok) throw new Error(response.error || 'artifact createBase64 failed');
        return response.value;
      },
      get: async (artifactId) => {
        const response = JSON.parse(await __hostArtifactGetMeta(String(artifactId)));
        if (!response.ok) throw new Error(response.error || 'artifact get failed');
        return response.value;
      },
      readText: async (artifactId) => {
        const response = JSON.parse(await __hostArtifactReadText(String(artifactId)));
        if (!response.ok) throw new Error(response.error || 'artifact readText failed');
        return response.value;
      },
    }),
    mcp: Object.freeze({
      listServers: async () => {
        const response = JSON.parse(await __hostMcpListServers());
        if (!response.ok) throw new Error(response.error || 'MCP listServers failed');
        return response.value;
      },
      listTools: async (serverId = '') => {
        const response = JSON.parse(await __hostMcpListTools(String(serverId || '')));
        if (!response.ok) throw new Error(response.error || 'MCP listTools failed');
        return response.value;
      },
      callTool: async (serverId, toolName, args = {}) => {
        const response = JSON.parse(await __hostMcpCallTool(String(serverId), String(toolName), JSON.stringify(args || {})));
        if (!response.ok) throw new Error(response.error || 'MCP callTool failed');
        return response.value;
      },
      readResource: async (serverId, uri) => {
        const response = JSON.parse(await __hostMcpReadResource(String(serverId), String(uri)));
        if (!response.ok) throw new Error(response.error || 'MCP readResource failed');
        return response.value;
      },
    }),
    secrets: Object.freeze({
      get: (key) => JSON.parse(__hostSecretGet(String(key))),
    }),
    log: (message) => JSON.parse(__hostLog(String(message))),
    sleep: async (ms) => JSON.parse(await __hostSleep(Number(ms))),
  });
  const ctx = Object.freeze({ ...baseCtx, api });
  const plugin = (${pluginSource});
  if (!plugin || typeof plugin !== 'object' || !plugin.tools || typeof plugin.tools !== 'object') {
    throw new Error('plugin must export an object with tools');
  }
  const tool = plugin.tools[toolName];
  if (typeof tool !== 'function') throw new Error('tool not found: ' + toolName);
  try {
    const result = await tool.call(plugin, ctx, args);
    return JSON.stringify(result || {});
  } catch (error) {
    return JSON.stringify({ __error: error && error.message ? String(error.message) : String(error) });
  }
})()
`;
}

function buildScriptContext(skill: SkillPackage, message: ChatMessage) {
  return {
    text: message.text,
    item: extractScriptItem(message),
    now: new Date().toISOString(),
    user: {
      id: message.fromId ?? null,
      username: message.username ?? null,
      displayName: message.displayName ?? null,
    },
    chat: {
      id: message.chatId,
      type: message.chatType ?? null,
    },
    message: {
      id: message.messageId,
      date: message.date.toISOString(),
    },
  };
}

function extractScriptItem(message: ChatMessage): string {
  const trimmed = message.text.trim();
  const firstSpaceIndex = trimmed.search(/\s/);
  return firstSpaceIndex >= 0 ? trimmed.slice(firstSpaceIndex).trim() : '';
}

async function readScriptState(store: FileStore, skill: SkillPackage): Promise<Record<string, unknown>> {
  return store.readJson(z.record(z.unknown()), {}, 'skills', 'state', `${skill.id}.json`);
}

async function writeScriptState(store: FileStore, skill: SkillPackage, state: Record<string, unknown>): Promise<void> {
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded, 'utf8') > SCRIPT_MAX_STATE_BYTES) {
    throw new Error(`script state exceeds ${SCRIPT_MAX_STATE_BYTES} bytes`);
  }
  await store.writeJson(state, 'skills', 'state', `${skill.id}.json`);
}

function assertStorageAllowed(skill: SkillPackage): void {
  if (!skill.permissions.storage) throw new Error('storage permission is not granted');
}

function assertStorageKey(key: string): string {
  if (!/^[a-z0-9_.:-]{1,80}$/i.test(key)) throw new Error(`invalid storage key: ${key}`);
  return key;
}

function assertListName(name: string): string {
  if (!/^[a-z0-9_-]{1,80}$/i.test(name)) throw new Error(`invalid list name: ${name}`);
  return name;
}

function assertMcpName(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_.:-]{0,127}$/i.test(value)) throw new Error(`invalid MCP ${label}: ${value}`);
  return value;
}

async function auditScriptRun(store: FileStore, skill: SkillPackage, toolName: string, status: string, details: unknown): Promise<void> {
  await store.appendJsonl(
    { skillId: skill.id, toolName, status, details, createdAt: new Date().toISOString() },
    'skills',
    'audit',
    `${skill.id}.jsonl`,
  );
}

function parseHostJson(text: string): unknown {
  return JSON.parse(text);
}

function isScriptErrorResult(value: unknown): value is { __error: string } {
  return Boolean(
    value
    && typeof value === 'object'
    && '__error' in value
    && typeof (value as { __error?: unknown }).__error === 'string',
  );
}

export function computeEffectiveHttpOrigins(skillOrigins: string[], globalOrigins: string[]): string[] {
  if (skillOrigins.includes('*')) return [...new Set(globalOrigins)];
  if (globalOrigins.includes('*')) return [...new Set(skillOrigins)];
  return [...new Set(skillOrigins.filter((origin) => globalOrigins.includes(origin)))];
}

function humanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatQuickJsError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}
