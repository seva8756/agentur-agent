import { z } from 'zod';
import { FileStore } from '../memory/fileStore';
import { saveDecision } from '../memory/decisions';
import { rememberFact } from '../memory/facts';
import { ChatMessage } from '../telegram/telegramTypes';
import { logger } from '../utils/logger';
import { extractItemAfterPhrase } from './matcher';
import { AtomicSkillAction, MicroSkill, SkillAction } from './schema';
import { buildTemplateVars, renderTemplate, TemplateVars } from './template';

const listSchema = z.object({ items: z.array(z.object({ text: z.string(), createdAt: z.string() })) });

export type SkillRuntimeOptions = {
  httpAllowedOrigins: string[];
  httpTimeoutMs: number;
  httpMaxRequestBytes: number;
  httpMaxResponseBytes: number;
};

const defaultOptions: SkillRuntimeOptions = {
  httpAllowedOrigins: [],
  httpTimeoutMs: 10000,
  httpMaxRequestBytes: 131072,
  httpMaxResponseBytes: 1048576,
};

export async function runSkill(
  store: FileStore,
  skill: MicroSkill,
  message: ChatMessage,
  options: Partial<SkillRuntimeOptions> = {},
): Promise<string | null> {
  const runtimeOptions = { ...defaultOptions, ...options };
  const replies: string[] = [];
  const vars = buildTemplateVars(skill, message);
  const actions = flattenActions(skill.action);

  for (const action of actions) {
    const reply = await runAtomicAction(store, skill, message, action, vars, runtimeOptions);
    if (reply) replies.push(reply);
  }

  return replies.length ? replies.join('\n') : null;
}

function flattenActions(action: SkillAction): AtomicSkillAction[] {
  return action.type === 'chain' ? action.actions : [action];
}

async function runAtomicAction(
  store: FileStore,
  skill: MicroSkill,
  message: ChatMessage,
  action: AtomicSkillAction,
  vars: TemplateVars,
  options: SkillRuntimeOptions,
): Promise<string | null> {
  if (action.type === 'reply_static') return action.text;
  if (action.type === 'reply_template') return renderTemplate(action.template, vars);
  if (action.type === 'remember_fact') {
    await rememberFact(store, message.text, `skill:${skill.id}`);
    return null;
  }
  if (action.type === 'save_decision') {
    await saveDecision(store, message.text, `skill:${skill.id}`);
    return null;
  }
  if (action.type === 'append_to_list') {
    const phrases = skill.trigger.type === 'message_contains' ? skill.trigger.phrases : [];
    const item = extractItemAfterPhrase(message.text, phrases) || message.text;
    const list = await store.readJson(listSchema, { items: [] }, 'chat', 'lists', `${action.listName}.json`);
    await store.writeJson(
      { items: [...list.items, { text: item, createdAt: new Date().toISOString() }] },
      'chat',
      'lists',
      `${action.listName}.json`,
    );
    vars.item = item;
    return action.confirmationText ? renderTemplate(action.confirmationText, vars) : `Добавил: ${item}.`;
  }
  if (action.type === 'http_request') {
    return runHttpAction(action, vars, options);
  }
  return null;
}

async function runHttpAction(
  action: Extract<AtomicSkillAction, { type: 'http_request' }>,
  vars: TemplateVars,
  options: SkillRuntimeOptions,
): Promise<string | null> {
  const url = renderTemplate(action.url, vars);
  const parsed = new URL(url);
  if (!isOriginAllowed(parsed.origin, options.httpAllowedOrigins)) {
    logger.warn('Blocked skill HTTP request to non-allowed origin', { origin: parsed.origin });
    return `HTTP-запрос навыка заблокирован настройками безопасности для домена ${parsed.origin}.`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.httpTimeoutMs);
  try {
    const headers = Object.fromEntries(
      Object.entries(action.headers ?? {}).map(([key, value]) => [key, renderTemplate(value, vars)]),
    );
    const body = action.bodyTemplate ? renderTemplate(action.bodyTemplate, vars) : undefined;
    if (body && Buffer.byteLength(body, 'utf8') > options.httpMaxRequestBytes) {
      logger.warn('Blocked skill HTTP request with oversized body', { maxBytes: options.httpMaxRequestBytes });
      return `HTTP-действие заблокировано: тело запроса больше ${options.httpMaxRequestBytes} байт.`;
    }
    const response = await fetch(url, {
      method: action.method,
      headers,
      body,
      signal: controller.signal,
    });
    const responseText = await readResponseTextLimited(response, options.httpMaxResponseBytes);
    const responseJson = parseJson(responseText);
    const responseObjectVars = responseJson && typeof responseJson === 'object' && !Array.isArray(responseJson)
      ? responseJson as Record<string, unknown>
      : {};
    const responseVars = {
      ...vars,
      ...responseObjectVars,
      status: response.status,
      ok: response.ok,
      responseText,
      responseJson,
      body: responseText,
      json: responseJson,
    };
    if (action.responseTemplate) {
      const rendered = renderTemplate(action.responseTemplate, responseVars);
      if (rendered) return rendered;
      logger.warn('Skill HTTP response template rendered empty', { status: response.status });
      return response.ok
        ? 'HTTP-действие выполнилось, но шаблон ответа вернул пустой текст.'
        : `HTTP-действие вернуло ${response.status}.`;
    }
    if (action.confirmationText) return renderTemplate(action.confirmationText, responseVars);
    return response.ok ? null : `HTTP-действие вернуло ${response.status}.`;
  } catch (error) {
    if (error instanceof SkillHttpLimitError) {
      logger.warn('Blocked oversized skill HTTP response', { maxBytes: error.maxBytes });
      return `HTTP-действие заблокировано: ответ больше ${error.maxBytes} байт.`;
    }
    logger.warn('Skill HTTP request failed', error);
    return 'HTTP-действие не выполнилось.';
  } finally {
    clearTimeout(timeout);
  }
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SkillHttpLimitError(maxBytes);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

class SkillHttpLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Skill HTTP response exceeds ${maxBytes} bytes`);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
