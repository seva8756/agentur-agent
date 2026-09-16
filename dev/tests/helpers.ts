import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig, AppConfig } from '../../src/config';
import { FileStore, initializeDataDir } from '../../src/memory/fileStore';
import { AgentScheduler } from '../../src/scheduler/scheduler';
import { skillPackageSchema, SkillPackage } from '../../src/skills/schema';
import { ChatMessage } from '../../src/messaging/types';
import { providerChatId } from '../../src/messaging/chatAddress';

export const TELEGRAM_CHAT_ID = providerChatId('telegram', '-1001');
export const TELEGRAM_CHAT_ID_2 = providerChatId('telegram', '-1002');
export const TELEGRAM_DENIED_CHAT_ID = providerChatId('telegram', '-1003');

export function testConfig(dataDir: string): AppConfig {
  return loadConfig({
    TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI',
    TELEGRAM_ALLOWED_CHAT_ID: '-1001',
    TELEGRAM_BOT_USERNAME: 'agentbot',
    LLM_BASE_URL: 'https://api.openai.com/v1',
    LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'test-model',
    LLM_SUPPORTS_TOOLS: 'false',
    AGENT_DATA_DIR: dataDir,
  });
}

export function telegramError(errorCode: number, message: string): Error {
  return Object.assign(new Error(message), { error_code: errorCode });
}

export function telegramBadRequest(message: string): Error {
  return telegramError(400, message);
}

export async function tempStore(): Promise<{ dir: string; store: FileStore; config: AppConfig; scheduler: AgentScheduler }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-agent-'));
  const store = new FileStore(dir);
  await initializeDataDir(store);
  const config = testConfig(dir);
  const scheduler = new AgentScheduler(store, { sendMessage: async () => undefined, askAgent: async () => 'ok', runSkillTool: async () => null });
  return { dir, store, config, scheduler };
}

export function msg(partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: 1,
    chatId: TELEGRAM_CHAT_ID,
    fromId: 'u1',
    text: 'hello',
    date: new Date(),
    ...partial,
  };
}

export function packageSkill(partial: Partial<SkillPackage> & {
  id: string;
  title: string;
  pluginJs?: string;
  tools?: SkillPackage['tools'];
}): SkillPackage {
  const firstTool = Object.keys(partial.tools ?? { main: { description: 'Main tool' } })[0] ?? 'main';
  return skillPackageSchema.parse({
    enabled: false,
    runtime: 'quickjs',
    source: 'chat_generated',
    version: 1,
    triggers: [],
    tools: { main: { description: 'Main tool', schema: { type: 'object', properties: {} } } },
    permissions: { httpOrigins: [], storage: true, secrets: [] },
    createdAt: new Date().toISOString(),
    skillMd: `# ${partial.title}`,
    pluginJs: `export default { tools: { async ${firstTool}(ctx, args) { return { ok: true, reply: ctx.text }; } } };`,
    ...partial,
    description: partial.description ?? `Use when the user asks for ${partial.title}.`,
  });
}

export const skillSchema = {
  parse(value: any): SkillPackage {
    if (value.pluginJs) return packageSkill(value);
    const toolName = 'main';
    const trigger = value.trigger ? { ...value.trigger, tool: toolName } : undefined;
    const permissions = {
      httpOrigins: value.permissions?.httpOrigins ?? collectActionOrigins(value.action),
      storage: true,
      secrets: value.secrets ?? [],
    };
    const pluginJs = value.code
      ? `export default { tools: { async main(ctx, args) { const fn = (${value.code}); return fn(ctx); } } };`
      : pluginForAction(value.action, value.secrets ?? []);
    return packageSkill({
      id: value.id,
      title: value.title,
      description: value.description,
      enabled: value.enabled ?? false,
      triggers: trigger ? [trigger] : [],
      tools: { [toolName]: { description: value.title, schema: { type: 'object', properties: {} } } },
      permissions,
      createdAt: value.createdAt ?? new Date().toISOString(),
      pluginJs,
    });
  },
};

function collectActionOrigins(action: any): string[] {
  const actions = action?.type === 'chain' ? action.actions : action ? [action] : [];
  return actions
    .filter((item: any) => item.type === 'http_request')
    .map((item: any) => new URL(item.url).origin);
}

function pluginForAction(action: any, secrets: string[]): string {
  return `export default { tools: { async main(ctx, args) {
    const getPath = (value, path) => String(path).split('.').reduce((current, part) => current && typeof current === 'object' ? current[part] : undefined, value);
    const render = (template, vars) => String(template || '').replace(/\\{\\{\\s*([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, (_m, key) => {
      const value = getPath(vars, key);
      if (value === undefined || value === null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
    const baseVars = { text: ctx.text, item: ctx.item, username: ctx.user.username || '', displayName: ctx.user.displayName || '', secrets: {} };
    for (const key of ${JSON.stringify(secrets)}) baseVars.secrets[key] = await ctx.api.secrets.get(key);
    const run = async (action) => {
      if (!action) return null;
      if (action.type === 'reply_static') return action.text;
      if (action.type === 'reply_template') return render(action.template, baseVars);
      if (action.type === 'remember_fact') { await ctx.api.memory.rememberFact(ctx.text); return null; }
      if (action.type === 'save_decision') { await ctx.api.memory.saveDecision(ctx.text); return null; }
      if (action.type === 'append_to_list') { await ctx.api.lists.append(action.listName, baseVars.item || ctx.text); return action.confirmationText ? render(action.confirmationText, baseVars) : 'Добавил: ' + (baseVars.item || ctx.text) + '.'; }
      if (action.type === 'http_request') {
        const res = await ctx.api.http.request({ method: action.method || 'GET', url: render(action.url, baseVars), headers: action.headers || {}, body: action.bodyTemplate ? render(action.bodyTemplate, baseVars) : undefined });
        const vars = { ...baseVars, ...((res.json && typeof res.json === 'object' && !Array.isArray(res.json)) ? res.json : {}), status: res.status, ok: res.ok, responseText: res.body, body: res.body, json: res.json };
        return action.responseTemplate ? render(action.responseTemplate, vars) : (action.confirmationText ? render(action.confirmationText, vars) : null);
      }
      return null;
    };
    const action = ${JSON.stringify(action ?? null)};
    const actions = action && action.type === 'chain' ? action.actions : [action];
    const replies = [];
    for (const item of actions) {
      try {
        const reply = await run(item);
        if (reply) replies.push(reply);
      } catch (error) {
        replies.push(error && error.message ? String(error.message) : String(error));
      }
    }
    return { ok: true, reply: replies.length ? replies.join('\\n') : null };
  } } };`;
}
