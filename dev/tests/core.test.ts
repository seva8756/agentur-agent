import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Bot } from 'grammy';
import { ChatRuntimeManager } from '../../src/agent/chatRuntime';
import { loadConfig, AppConfig } from '../../src/config';
import { allocateContextStages, buildChatContext, conservativeTokenEstimator } from '../../src/agent/context';
import { limitOutput } from '../../src/agent/outputLimiter';
import { decideReply } from '../../src/agent/replyPolicy';
import { generateAgentReply, generateAgentResult } from '../../src/agent/respond';
import { runToolLoop } from '../../src/llm/toolLoop';
import { FileStore, initializeDataDir } from '../../src/memory/fileStore';
import { readIdentity, writeIdentity } from '../../src/memory/identity';
import { readChatSettings, setReplyMode } from '../../src/memory/chatSettings';
import { smoothMood, defaultMood, writeMood } from '../../src/memory/moodDiary';
import { appendRecentMessage } from '../../src/memory/recentMessages';
import { createTextArtifact, readArtifactText } from '../../src/memory/artifactStore';
import { AgentScheduler } from '../../src/scheduler/scheduler';
import { runCronJob } from '../../src/scheduler/jobRuntime';
import { cronJobSchema } from '../../src/scheduler/schema';
import { enableSkill, disableSkill, saveDraftSkill, loadDraftSkills, loadEnabledSkills, deleteSkill } from '../../src/skills/loader';
import { matchSkill, matchesCommand } from '../../src/skills/matcher';
import { skillResultText, textSkillResult } from '../../src/skills/result';
import { skillPackageSchema, SkillPackage } from '../../src/skills/schema';
import { runSkill, runSkillTool } from '../../src/skills/runtime';
import { ToolRegistry } from '../../src/tools/registry';
import { AgentTool, ToolContext, toOpenAITool } from '../../src/tools/types';
import { createCronJobTool } from '../../src/tools/implementations/createCronJob';
import { createSkillPackageDraftTool } from '../../src/tools/implementations/createSkillPackageDraft';
import { createArtifactTool } from '../../src/tools/implementations/createArtifact';
import { readArtifactTool } from '../../src/tools/implementations/readArtifact';
import { createSendPayloadTool, sendPayloadTool } from '../../src/tools/implementations/sendPayload';
import { runSkillToolTool } from '../../src/tools/implementations/runSkillTool';
import { listSkillPackagesTool } from '../../src/tools/implementations/listSkillPackages';
import { buildContextPolicy } from '../../src/agent/context/policy';
import { routeMessage } from '../../src/telegram/messageRouter';
import { handleAgentCommand } from '../../src/telegram/commands';
import { markdownToTelegramHtml } from '../../src/telegram/formatting';
import { sendMarkdown, sendSkillResult, truncateForTelegram } from '../../src/telegram/send';
import { ChatMessage } from '../../src/telegram/telegramTypes';
import { formatLocalTime } from '../../src/utils/time';

function testConfig(dataDir: string): AppConfig {
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

async function tempStore(): Promise<{ dir: string; store: FileStore; config: AppConfig; scheduler: AgentScheduler }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-agent-'));
  const store = new FileStore(dir);
  await initializeDataDir(store);
  const config = testConfig(dir);
  const scheduler = new AgentScheduler(store, { sendMessage: async () => undefined, askAgent: async () => 'ok', runSkillTool: async () => null });
  return { dir, store, config, scheduler };
}

function msg(partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: 1,
    chatId: '-1001',
    fromId: 'u1',
    text: 'hello',
    date: new Date(),
    ...partial,
  };
}

function packageSkill(partial: Partial<SkillPackage> & {
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
    whenToUse: partial.whenToUse ?? `Use when the user asks for ${partial.title}.`,
  });
}

describe('config', () => {
  it('limits Telegram send payload items to the Telegram maximum', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-agent-config-'));
    const config = testConfig(dir);
    expect(config.telegramSendMaxItems).toBe(10);
    expect(() => loadConfig({
      TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI',
      TELEGRAM_ALLOWED_CHAT_ID: '-1001',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_API_KEY: 'sk-test',
      LLM_MODEL: 'test-model',
      TELEGRAM_SEND_MAX_ITEMS: '11',
      AGENT_DATA_DIR: dir,
    })).toThrow(/TELEGRAM_SEND_MAX_ITEMS/);
  });
});

const microSkillSchema = {
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
      whenToUse: value.whenToUse,
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

describe('single-chat filtering', () => {
  it('ignores and does not store messages from other chats', async () => {
    const { store, config, scheduler } = await tempStore();
    const reply = await routeMessage(msg({ chatId: '-999', text: '@agentbot ping' }), {
      config,
      botUsername: 'agentbot',
      store,
      scheduler,
      tools: new ToolRegistry(),
      llm: { chat: async () => 'pong', minimalCheck: async () => 'ok', toolCheck: async () => false },
    });
    expect(reply).toBeNull();
    const recent = await store.readJsonl(z.any(), 'chat', 'recent.jsonl');
    expect(recent).toHaveLength(0);
  });

  it('uses separate stores per chat when allowlist is empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-agent-multi-'));
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI',
      TELEGRAM_ALLOWED_CHAT_ID: '',
      TELEGRAM_BOT_USERNAME: '',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_API_KEY: 'sk-test',
      LLM_MODEL: 'test-model',
      LLM_SUPPORTS_TOOLS: 'false',
      AGENT_DATA_DIR: dir,
    });
    const manager = new ChatRuntimeManager(
      config,
      { chat: async () => 'ok', minimalCheck: async () => 'ok', toolCheck: async () => false },
      new ToolRegistry(),
      async () => undefined,
    );
    const first = await manager.getRuntime('-1001');
    const second = await manager.getRuntime('-1002');
    expect(first?.store.rootDir).not.toEqual(second?.store.rootDir);
    await first?.store.writeJson({ value: 1 }, 'chat', 'marker.json');
    await expect(fs.access(second!.store.resolve('chat', 'marker.json'))).rejects.toThrow();
  });

  it('allows multiple configured chats and does not create stores for denied chats', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-agent-allowlist-'));
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI',
      TELEGRAM_ALLOWED_CHAT_ID: '-1001, -1002',
      TELEGRAM_BOT_USERNAME: '',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_API_KEY: 'sk-test',
      LLM_MODEL: 'test-model',
      LLM_SUPPORTS_TOOLS: 'false',
      AGENT_DATA_DIR: dir,
    });
    const manager = new ChatRuntimeManager(
      config,
      { chat: async () => 'ok', minimalCheck: async () => 'ok', toolCheck: async () => false },
      new ToolRegistry(),
      async () => undefined,
    );

    const first = await manager.getRuntime('-1001');
    const second = await manager.getRuntime('-1002');
    const denied = await manager.getRuntime('-1003');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(denied).toBeNull();
    expect(first?.store.rootDir).not.toEqual(second?.store.rootDir);
    const deniedDir = path.join(dir, 'chats', Buffer.from('-1003', 'utf8').toString('base64url'));
    await expect(fs.access(deniedDir)).rejects.toThrow();
  });

  it('does not store silent background messages by default', async () => {
    const { store, config, scheduler } = await tempStore();
    const reply = await routeMessage(msg({ text: 'просто фоновая переписка' }), {
      config,
      botUsername: 'agentbot',
      store,
      scheduler,
      tools: new ToolRegistry(),
      llm: { chat: async () => 'pong', minimalCheck: async () => 'ok', toolCheck: async () => false },
    });
    expect(reply).toBeNull();
    expect(await store.readJsonl(z.any(), 'chat', 'recent.jsonl')).toHaveLength(0);
  });

  it('stores silent background messages for full-capture chats', async () => {
    const { store, config, scheduler } = await tempStore();
    const captureConfig = { ...config, telegramFullCaptureChatIds: ['-1001'] };
    const reply = await routeMessage(msg({ text: 'просто фоновая переписка' }), {
      config: captureConfig,
      botUsername: 'agentbot',
      store,
      scheduler,
      tools: new ToolRegistry(),
      llm: { chat: async () => 'pong', minimalCheck: async () => 'ok', toolCheck: async () => false },
    });
    expect(reply).toBeNull();
    expect(await store.readJsonl(z.any(), 'chat', 'recent.jsonl')).toHaveLength(1);
  });

  it('summarizes and clears interaction messages outside full-capture chats', async () => {
    const { store, config, scheduler } = await tempStore();
    const compactConfig = { ...config, interactionSummaryEveryMessages: 2 };
    const deps = {
      config: compactConfig,
      botUsername: 'agentbot',
      store,
      scheduler,
      tools: new ToolRegistry(),
      llm: { chat: async () => 'pong', minimalCheck: async () => 'ok', toolCheck: async () => false },
    };
    await routeMessage(msg({ messageId: 1, text: '@agentbot ping' }), deps);
    await routeMessage(msg({ messageId: 2, text: '@agentbot ping again' }), deps);
    expect(await store.readJsonl(z.any(), 'chat', 'recent.jsonl')).toHaveLength(0);
    expect(await store.readJsonl(z.any(), 'chat', 'interaction-summaries.jsonl')).toHaveLength(1);
  });

  it('smart mode stores background messages and can proactively reply', async () => {
    const { store, config, scheduler } = await tempStore();
    await setReplyMode(store, 'smart');
    await writeMood(store, { warmth: 0.8, tension: 0.7, humor: 0.1, updatedAt: new Date().toISOString() });
    let calls = 0;
    const reply = await routeMessage(msg({ text: 'Кто-нибудь может быстро помочь с ошибкой деплоя?' }), {
      config,
      botUsername: 'agentbot',
      store,
      scheduler,
      tools: new ToolRegistry(),
      llm: {
        chat: async (messages) => {
          calls += 1;
          if (calls === 1) expect(String(messages[0]?.content)).toContain('tension=0.70');
          return calls === 1 ? '{"reply":true,"reason":"help request"}' : 'Могу помочь: пришли текст ошибки.';
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });
    expect(skillResultText(reply)).toContain('Могу помочь');
    expect(await store.readJsonl(z.any(), 'chat', 'recent.jsonl')).toHaveLength(1);
  });

  it('does not fall back to generic LLM reply when a matched skill returns no text', async () => {
    const { store, config, scheduler } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'silent_memory',
      title: 'Silent memory',
      enabled: false,
      trigger: { type: 'command', command: 'silent_memory' },
      action: { type: 'remember_fact', extractionHint: 'remember full message' },
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'silent_memory');
    const reply = await routeMessage(msg({ text: '/silent_memory это факт' }), {
      config,
      botUsername: 'agentbot',
      store,
      scheduler,
      tools: new ToolRegistry(),
      llm: {
        chat: async () => {
          throw new Error('LLM should not be called after matched silent skill');
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });
    expect(reply).toBeNull();
  });
});

describe('reply policy', () => {
  it('replies on mention, reply, and /agentur but not casual chat', () => {
    expect(decideReply(msg({ text: 'hey @agentbot' }), 'agentbot').shouldReply).toBe(true);
    expect(decideReply(msg({ text: 'hey @agentbot_test' }), 'agentbot').shouldReply).toBe(false);
    expect(decideReply(msg({ replyToBot: true }), 'agentbot').shouldReply).toBe(true);
    expect(decideReply(msg({ text: '/agentur status' }), 'agentbot').shouldReply).toBe(true);
    expect(decideReply(msg({ text: '/agentur@agentbot status' }), 'agentbot').shouldReply).toBe(true);
    expect(decideReply(msg({ text: '/agents status' }), 'agentbot').shouldReply).toBe(false);
    expect(decideReply(msg({ text: 'бот, помоги' }), 'agentbot').shouldReply).toBe(false);
    expect(decideReply(msg({ text: 'люди, как дела?' }), 'agentbot').shouldReply).toBe(false);
  });
});

describe('telegram formatting', () => {
  it('truncates outgoing Telegram text with an explicit marker', () => {
    const value = truncateForTelegram('x'.repeat(5000), 4096);
    expect(value.length).toBeLessThanOrEqual(4096);
    expect(value.endsWith('...[сообщение обрезано]')).toBe(true);
  });

  it('escapes raw text that breaks Telegram Markdown', () => {
    const html = markdownToTelegramHtml('Добавь SKILL_HTTP_ALLOWED_ORIGINS=* и x < y');
    expect(html).toContain('SKILL_HTTP_ALLOWED_ORIGINS=*');
    expect(html).toContain('x &lt; y');
  });

  it('keeps a safe subset of markdown formatting', () => {
    const html = markdownToTelegramHtml('**Важно**: `SKILL_HTTP_ALLOWED_ORIGINS` [docs](https://example.com?a=1&b=2)');
    expect(html).toContain('<b>Важно</b>');
    expect(html).toContain('<code>SKILL_HTTP_ALLOWED_ORIGINS</code>');
    expect(html).toContain('<a href="https://example.com?a=1&amp;b=2">docs</a>');
  });

  it('escapes fenced code blocks', () => {
    const html = markdownToTelegramHtml('```ts\nif (x < y) return a & b;\n```');
    expect(html).toBe('<pre><code>if (x &lt; y) return a &amp; b;</code></pre>');
  });

  it('sends compatible media payloads as one Telegram media group', async () => {
    const { store } = await tempStore();
    const sendMediaGroup = vi.fn(async (_chatId: string, media: unknown[]) => media.map((_item, index) => ({
      message_id: index + 1,
      date: 1,
      chat: { id: -1001, type: 'supergroup' },
    })));
    const sendDocument = vi.fn();
    const bot = {
      api: {
        sendMediaGroup,
        sendDocument,
        sendPhoto: vi.fn(),
        sendVideo: vi.fn(),
        sendMessage: vi.fn(),
      },
    } as unknown as Bot;

    await sendSkillResult(bot, store, '-1001', {
      ok: true,
      reply: 'Файлы приложил.',
      send: [
        { kind: 'file', url: 'https://cdn.example.com/a.csv', filename: 'a.csv' },
        { kind: 'file', url: 'https://cdn.example.com/b.csv', filename: 'b.csv' },
      ],
    }, undefined, 10);

    expect(sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(sendDocument).not.toHaveBeenCalled();
    const media = sendMediaGroup.mock.calls[0][1] as Array<{ type: string; caption?: string }>;
    expect(media).toHaveLength(2);
    expect(media[0].type).toBe('document');
    expect(media[0].caption).toContain('Файлы приложил.');
  });

  it('sends markdown as HTML via sendMessage', async () => {
    const sendMessage = vi.fn(async (_chatId: string, _text: string, _options?: unknown) => ({ message_id: 1, date: 1, chat: { id: -1001, type: 'supergroup' } }));
    const bot = {
      api: {
        sendMessage,
      },
    } as unknown as Bot;

    await sendMarkdown(bot, '-1001', '**важно**', 42);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const args = sendMessage.mock.calls[0];
    expect(args[0]).toBe('-1001');
    expect(args[1]).toContain('<b>важно</b>');
    expect(args[2]).toMatchObject({ parse_mode: 'HTML', message_thread_id: 42 });
  });

  it('falls back to plain text when HTML sendMessage rejects', async () => {
    let sendCount = 0;
    const sendMessage = vi.fn(async (_chatId: string, _text: string, _options?: unknown) => {
      sendCount += 1;
      if (sendCount === 1) throw new Error('HTML rejected');
      return { message_id: 3, date: 1, chat: { id: -1001, type: 'supergroup' } };
    });
    const bot = {
      api: {
        sendMessage,
      },
    } as unknown as Bot;

    await sendMarkdown(bot, '-1001', '**важно**');

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const plainCall = sendMessage.mock.calls[1];
    expect(plainCall[1]).toBe('**важно**');
    expect(plainCall[2]).toMatchObject({ message_thread_id: undefined });
    expect(plainCall[2]).not.toHaveProperty('parse_mode');
  });
});

describe('context budget', () => {
  it('injects current local time into context', async () => {
    const { store } = await tempStore();
    await writeMood(store, { warmth: 0.2, tension: 0.7, humor: 0.1, updatedAt: new Date().toISOString() });
    const context = await buildChatContext(store, 'который час?', {
      contextWindowTokens: 32000,
      contextBudgetTokens: 12000,
      replyMaxTokens: 900,
      timezone: 'Europe/Moscow',
    });
    expect(String(context.messages[1]?.content)).toContain('Current local time');
    expect(String(context.messages[1]?.content)).toContain('Europe/Moscow');
    expect(String(context.messages[0]?.content)).toContain('Mood diary');
    expect(String(context.messages[0]?.content)).toContain('tension=0.70');
    expect(String(context.messages[0]?.content)).toContain('Шутки лучше минимизировать');
    expect(formatLocalTime('Europe/Moscow').length).toBeGreaterThan(10);
  });

  it('injects uncensored language mode into system prompt', async () => {
    const { store, config, scheduler } = await tempStore();
    const answer = await handleAgentCommand('/agentur censor-mode off', {
      store,
      config,
      scheduler,
      llm: { chat: async () => 'ok', minimalCheck: async () => 'ok', toolCheck: async () => false },
    });
    expect(answer).toContain('Режим цензуры: выключен');
    expect((await readChatSettings(store)).profanityMode).toBe('uncensored');
    const context = await buildChatContext(store, 'ответь резко', {
      contextWindowTokens: 32000,
      contextBudgetTokens: 12000,
      replyMaxTokens: 900,
      timezone: 'Europe/Moscow',
    });
    expect(String(context.messages[0]?.content)).toContain('Language mode: uncensored');
    expect(String(context.messages[0]?.content)).toContain('Мат разрешён');
  });

  it('includes usernames in recent chat context for mentions', async () => {
    const { store } = await tempStore();
    await appendRecentMessage(store, {
      id: 1,
      chatId: '-1001',
      userId: '42',
      username: 'seva',
      displayName: 'Сева',
      text: 'посмотри задачу',
      date: new Date().toISOString(),
      isBot: false,
    });
    const context = await buildChatContext(store, 'кому ответить?', {
      contextWindowTokens: 32000,
      contextBudgetTokens: 12000,
      replyMaxTokens: 900,
      timezone: 'Europe/Moscow',
    });
    expect(String(context.messages[0]?.content)).toContain('@username');
    expect(String(context.messages[2]?.content)).toContain('Сева (@seva): посмотри задачу');
  });

  it('includes recent attachment metadata in agent context', async () => {
    const { store } = await tempStore();
    await appendRecentMessage(store, {
      id: 1,
      chatId: '-1001',
      text: 'Готово, приложил CSV.',
      date: new Date().toISOString(),
      isBot: true,
      attachments: [{
        kind: 'file',
        artifactId: 'art_existing_csv',
        filename: 'random_users.csv',
      }],
    });
    const context = await buildChatContext(store, 'пришли тот же файл', {
      contextWindowTokens: 32000,
      contextBudgetTokens: 12000,
      replyMaxTokens: 900,
      timezone: 'Europe/Moscow',
    });
    const memory = String(context.messages[2]?.content);
    expect(memory).toContain('artifact=art_existing_csv');
    expect(memory).toContain('filename=random_users.csv');
    expect(memory).not.toContain('caption=');
  });

  it('trims a large recent message only when memory budget requires it', async () => {
    const { store } = await tempStore();
    await appendRecentMessage(store, {
      id: 1,
      chatId: '-1001',
      userId: '42',
      username: 'seva',
      displayName: 'Сева',
      text: 'x'.repeat(5000),
      date: new Date().toISOString(),
      isBot: false,
    });
    const context = await buildChatContext(store, 'что было?', {
      contextWindowTokens: 5000,
      contextBudgetTokens: 1400,
      replyMaxTokens: 200,
      timezone: 'Europe/Moscow',
    });
    const memory = context.messages.map((message) => String(message.content)).join('\n');
    expect(memory).toContain('[truncated]');
    expect(memory).not.toContain('x'.repeat(4000));
  });

  it('keeps separate memory slots for summary facts decisions and recent', async () => {
    const { store } = await tempStore();
    await store.writeText('summary '.repeat(2000), 'chat', 'summary.md');
    await store.writeJson([{ id: 'fact_1', text: 'важный факт', createdAt: new Date().toISOString() }], 'chat', 'facts.json');
    await store.writeJson([{ id: 'decision_1', text: 'важное решение', createdAt: new Date().toISOString() }], 'chat', 'decisions.json');
    await appendRecentMessage(store, {
      id: 1,
      chatId: '-1001',
      userId: '42',
      username: 'seva',
      displayName: 'Сева',
      text: 'свежая реплика',
      date: new Date().toISOString(),
      isBot: false,
    });

    const context = await buildChatContext(store, 'что помнишь?', {
      contextWindowTokens: 5000,
      contextBudgetTokens: 1400,
      replyMaxTokens: 200,
      timezone: 'Europe/Moscow',
    });
    const memory = context.messages.map((message) => String(message.content)).join('\n');
    expect(memory).toContain('summary');
    expect(memory).toContain('важный факт');
    expect(memory).toContain('важное решение');
    expect(memory).toContain('свежая реплика');
  });

  it('prioritizes a long user over memory', () => {
    const allocation = allocateContextStages(
      [
        { kind: 'system', content: 'system prompt' },
        { kind: 'time', content: 'time' },
        { kind: 'skills', content: '' },
        { kind: 'user', content: 'юзер '.repeat(800) },
        { kind: 'memory', content: 'memory '.repeat(800) },
      ],
      { contextWindowTokens: 5000, contextBudgetTokens: 1400, replyMaxTokens: 300 },
    );
    expect(allocation.takes.memory).toBeLessThan(allocation.takes.user);
  });

  it('lets user overflow beyond soft budget but keeps memory inside it', () => {
    const allocation = allocateContextStages(
      [
        { kind: 'system', content: 'system prompt' },
        { kind: 'time', content: 'time' },
        { kind: 'skills', content: '' },
        { kind: 'user', content: 'юзер '.repeat(3000) },
        { kind: 'memory', content: 'memory '.repeat(3000) },
      ],
      { contextWindowTokens: 8000, contextBudgetTokens: 1200, replyMaxTokens: 400 },
    );
    expect(allocation.userOverflowTokens).toBeGreaterThan(0);
    expect(allocation.takes.memory).toBeLessThanOrEqual(allocation.softBudgetTokens);
  });

  it('clips soft budget to hard window when budget exceeds model window', () => {
    const allocation = allocateContextStages(
      [
        { kind: 'system', content: 'system prompt' },
        { kind: 'time', content: 'time' },
        { kind: 'skills', content: '' },
        { kind: 'user', content: 'hello' },
        { kind: 'memory', content: 'memory '.repeat(1000) },
      ],
      { contextWindowTokens: 1200, contextBudgetTokens: 10000, replyMaxTokens: 300 },
    );
    expect(allocation.softBudgetTokens).toBe(allocation.usableHardTokens);
  });

  it('uses fixed 30k stage budgets for the 50k default context window', () => {
    const numericEstimator = {
      estimateText: (text: string) => Number.parseInt(text, 10) || 0,
      trimTextToTokens: (text: string) => text,
    };
    const allocation = allocateContextStages(
      [
        { kind: 'system', content: '100000' },
        { kind: 'time', content: '100000' },
        { kind: 'skills', content: '100000' },
        { kind: 'user', content: '14000' },
        { kind: 'memory', content: '100000' },
      ],
      { contextWindowTokens: 50000, contextBudgetTokens: 30000, replyMaxTokens: 1400 },
      numericEstimator,
    );

    expect(allocation.softBudgetTokens).toBe(30000);
    expect(allocation.takes.system).toBe(4000);
    expect(allocation.takes.time).toBe(150);
    expect(allocation.takes.skills).toBe(5000);
    expect(allocation.takes.user).toBe(14000);
    expect(allocation.takes.memory).toBe(6850);
  });

  it('does not count image data URLs as text tokens', () => {
    const textOnly = conservativeTokenEstimator.estimateText('Что на картинке?');
    expect(textOnly).toBeLessThan(20);
  });

  it('attaches current image to VLM request without enabling tools', async () => {
    const { store, config, scheduler } = await tempStore();
    let sawImage = false;
    let sawTools = false;
    const reply = await generateAgentReply({
      input: 'Что на картинке?',
      image: { dataUrl: 'data:image/png;base64,AAAA' },
      config: { ...config, llmSupportsTools: true },
      store,
      tools: new ToolRegistry(),
      toolContext: { store, scheduler, timezone: 'Europe/Moscow' },
      llm: {
        chat: async (messages, options) => {
          sawTools = Boolean(options?.tools);
          const last = messages.at(-1);
          sawImage = Array.isArray(last?.content) && last.content.some((part) =>
            typeof part === 'object' && part !== null && 'type' in part && part.type === 'image_url'
          );
          return 'На картинке тест.';
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });
    expect(reply).toBe('На картинке тест.');
    expect(sawImage).toBe(true);
    expect(sawTools).toBe(false);
  });

  it('falls back to text reply when image input is rejected by provider', async () => {
    const { store, config, scheduler } = await tempStore();
    let calls = 0;
    const reply = await generateAgentReply({
      input: 'Что на картинке?',
      image: { dataUrl: 'data:image/png;base64,AAAA' },
      config,
      store,
      tools: new ToolRegistry(),
      toolContext: { store, scheduler, timezone: 'Europe/Moscow' },
      llm: {
        chat: async (messages) => {
          calls += 1;
          if (calls === 1) {
            expect(Array.isArray(messages.at(-1)?.content)).toBe(true);
            throw { error: { message: '/mnt/models/glm is not a multimodal model' } };
          }
          expect(String(messages.at(-1)?.content)).toContain('configured model is not a multimodal model');
          return 'Не смог проанализировать картинку: текущая модель не принимает изображения.';
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });
    expect(calls).toBe(2);
    expect(reply).toContain('не принимает изображения');
  });

  it('retries with reduced context when the provider rejects an oversized prompt', async () => {
    const { store, config, scheduler } = await tempStore();
    let calls = 0;
    let fallbackSawNotice = false;
    let fallbackSawTools = false;
    const reply = await generateAgentReply({
      input: 'ответь по доступному контексту',
      config: { ...config, contextBudgetTokens: 6000, llmSupportsTools: true },
      store,
      tools: new ToolRegistry(),
      toolContext: { store, scheduler, timezone: 'Europe/Moscow' },
      llm: {
        chat: async (messages, options) => {
          calls += 1;
          if (calls === 1) {
            throw {
              status: 400,
              message: "This model's maximum context length is 202752 tokens. However, your prompt contains too many tokens.",
            };
          }
          fallbackSawNotice = messages.some((message) =>
            typeof message.content === 'string' && message.content.includes('exceeded the available context window')
          );
          fallbackSawTools = Boolean(options?.tools);
          return 'Контекста не хватило, поэтому отвечаю по доступной части.';
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });
    expect(calls).toBe(2);
    expect(fallbackSawNotice).toBe(true);
    expect(fallbackSawTools).toBe(false);
    expect(reply).toContain('Контекста не хватило');
  });

  it('drops image input on context-limit fallback', async () => {
    const { store, config, scheduler } = await tempStore();
    let calls = 0;
    let fallbackSawImage = false;
    const reply = await generateAgentReply({
      input: 'Что на картинке?',
      image: { dataUrl: 'data:image/png;base64,AAAA' },
      config,
      store,
      tools: new ToolRegistry(),
      toolContext: { store, scheduler, timezone: 'Europe/Moscow' },
      llm: {
        chat: async (messages) => {
          calls += 1;
          if (calls === 1) {
            throw {
              status: 400,
              error: { message: 'context_length_exceeded: prompt contains too many tokens' },
            };
          }
          fallbackSawImage = messages.some((message) =>
            Array.isArray(message.content) && message.content.some((part) =>
              typeof part === 'object' && part !== null && 'type' in part && part.type === 'image_url'
            )
          );
          return 'Картинку пришлось опустить из-за лимита контекста.';
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });
    expect(calls).toBe(2);
    expect(fallbackSawImage).toBe(false);
    expect(reply).toContain('лимита контекста');
  });

  it('returns multiple queued media sends and uses the model final reply as the first caption', async () => {
    const { store, config, scheduler } = await tempStore();
    const result = await generateAgentResult({
      input: 'сделай аккаунт и пришли файл',
      config,
      store,
      tools: new ToolRegistry(),
      toolContext: { store, scheduler, timezone: 'Europe/Moscow' },
      llm: {
        chat: async (_messages, options) => {
          options?.toolContext?.outbox?.push({
            ok: true,
            reply: 'Skill summary',
            send: [{
              kind: 'file',
              url: 'https://cdn.example.com/users.csv',
              caption: 'Skill caption',
              filename: 'users.csv',
            }],
          });
          options?.toolContext?.outbox?.push({
            ok: true,
            reply: 'Second skill summary',
            send: [{
              kind: 'file',
              url: 'https://cdn.example.com/audit.csv',
              caption: 'Audit caption',
              filename: 'audit.csv',
            }],
          });
          return 'Создал аккаунт и приложил CSV.';
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });

    expect(result?.reply).toBe('Создал аккаунт и приложил CSV.');
    expect(result?.send).toEqual([{
      kind: 'file',
      url: 'https://cdn.example.com/users.csv',
      caption: 'Создал аккаунт и приложил CSV.',
      filename: 'users.csv',
    }, {
      kind: 'file',
      url: 'https://cdn.example.com/audit.csv',
      caption: 'Audit caption',
      filename: 'audit.csv',
    }]);
  });

  it('includes enabled micro-skills for semantic tool selection', async () => {
    const { store, config, scheduler } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'jsonbin_fetch',
      title: 'Fetch JSONBin data',
      whenToUse: 'Use when the user asks to fetch or show JSONBin data.',
      enabled: false,
      trigger: { type: 'command', command: 'jsonbin' },
      action: { type: 'reply_static', text: 'json' },
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'jsonbin_fetch');
    let sawSkillsContext = false;
    await generateAgentReply({
      input: 'выведи мне джесон бин',
      config: { ...config, llmSupportsTools: true },
      store,
      tools: new ToolRegistry(),
      toolContext: { store, scheduler, timezone: 'Europe/Moscow' },
      llm: {
        chat: async (messages) => {
          sawSkillsContext = messages.some((message) =>
            typeof message.content === 'string'
            && message.content.includes('run_skill_tool')
            && message.content.includes('jsonbin_fetch')
            && message.content.includes('when_to_use=Use when the user asks to fetch or show JSONBin data.')
          );
          return 'ok';
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });
    expect(sawSkillsContext).toBe(true);
  });
});

describe('file store', () => {
  it('writes and reads JSON atomically', async () => {
    const { store } = await tempStore();
    await store.writeJson({ a: 1 }, 'x.json');
    await store.writeJson({ a: 2 }, 'x.json');
    expect(await store.readJson(z.object({ a: z.number() }), { a: 0 }, 'x.json')).toEqual({ a: 2 });
  });
});

describe('artifacts', () => {
  it('creates and reads chat-local text artifacts', async () => {
    const { store } = await tempStore();
    const meta = await createTextArtifact(store, {
      filename: 'index.html',
      mimeType: 'text/html',
      text: '<h1>Hello</h1>',
    }, { kind: 'agent' });
    expect(meta.filename).toBe('index.html');
    const read = await readArtifactText(store, meta.id);
    expect(read.text).toBe('<h1>Hello</h1>');
    expect(read.truncated).toBe(false);
  });

  it('lets agent tools create, read, and queue artifact payloads', async () => {
    const { store, scheduler } = await tempStore();
    const context: ToolContext = { store, scheduler, timezone: 'Europe/Moscow', outbox: [] };
    const created = JSON.parse(await createArtifactTool.execute({
      filename: 'note.txt',
      mimeType: 'text/plain',
      text: 'hello',
    }, context));
    const read = JSON.parse(await readArtifactTool.execute({ artifactId: created.artifact.id, mode: 'text' }, context));
    expect(read.text).toBe('hello');
    const queued = JSON.parse(await sendPayloadTool.execute({
      send: [{
        kind: 'file',
        source: { type: 'artifact', artifactId: created.artifact.id },
      }],
    }, context));
    expect(queued.send[0].source).toEqual({ type: 'artifact', artifactId: created.artifact.id });
    expect(context.outbox?.[0]?.send).toEqual(queued.send);
  });

  it('enforces configured send_payload item limits before queueing', async () => {
    const { store, scheduler } = await tempStore();
    const context: ToolContext = { store, scheduler, timezone: 'Europe/Moscow', outbox: [] };
    const tool = createSendPayloadTool(2);
    const send = [
      { kind: 'message' as const, text: 'one' },
      { kind: 'message' as const, text: 'two' },
      { kind: 'message' as const, text: 'three' },
    ];
    expect(() => tool.schema.parse({ send })).toThrow();
    await tool.execute({ send: send.slice(0, 2) }, context);
    await expect(tool.execute({ send: [send[2]] }, context)).rejects.toThrow(/2/);
  });
});

describe('chat identity', () => {
  it('sets identity through command and injects it into system prompt', async () => {
    const { store, config, scheduler } = await tempStore();
    const answer = await handleAgentCommand('/agentur identity set Ты ворчливый, но полезный дворецкий.', {
      store,
      config,
      scheduler,
      llm: { chat: async () => 'ok', minimalCheck: async () => 'ok', toolCheck: async () => false },
    });
    expect(answer).toContain('Identity сохранена');
    expect(await readIdentity(store)).toContain('дворецкий');
    const context = await buildChatContext(store, 'привет', {
      contextWindowTokens: 32000,
      contextBudgetTokens: 12000,
      replyMaxTokens: 900,
      timezone: 'Europe/Moscow',
    });
    expect(String(context.messages[0]?.content)).toContain('дворецкий');
    expect(String(context.messages[0]?.content)).toContain('не переписывается под настроение');
  });

  it('trims identity to configured limit', async () => {
    const { store } = await tempStore();
    await writeIdentity(store, 'abcdef', 3);
    expect(await readIdentity(store)).toBe('abc');
  });
});

describe('mood', () => {
  it('smooths signal into current values', () => {
    const next = smoothMood(defaultMood, { warmth: 1, tension: 1, humor: 0 }, 0.5);
    expect(next.warmth).toBeCloseTo(0.75);
    expect(next.tension).toBeCloseTo(0.55);
    expect(next.humor).toBeCloseTo(0.1);
  });
});

describe('micro-skills', () => {
  it('validates schema', () => {
    const skill = microSkillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping list',
      enabled: false,
      trigger: { type: 'command', command: 'buy' },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    });
    expect(skill.id).toBe('shopping_list');
  });

  it('validates scripted skill schema', () => {
    const skill = microSkillSchema.parse({
      id: 'counter',
      title: 'Counter',
      enabled: false,
      trigger: { type: 'command', command: 'count' },
      code: 'async (ctx) => ({ reply: ctx.text })',
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect('pluginJs' in skill).toBe(true);
  });

  it('matches slash commands against command triggers', () => {
    const skill = microSkillSchema.parse({
      id: 'jsonbin_fetch',
      title: 'Fetch JSONBin data',
      enabled: true,
      trigger: { type: 'command', command: 'jsonbin' },
      action: { type: 'reply_static', text: 'ok' },
      createdAt: new Date().toISOString(),
    });
    expect(matchesCommand('/jsonbin', 'jsonbin')).toBe(true);
    expect(matchesCommand('/jsonbin@agentbot arg', '/jsonbin')).toBe(true);
    expect(matchesCommand('/jsonbin_extra', 'jsonbin')).toBe(false);
    expect(matchSkill(msg({ text: '/jsonbin' }), [skill])?.skill.id).toBe('jsonbin_fetch');
  });

  it('enables and disables JSON skill', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping list',
      enabled: false,
      trigger: { type: 'command', command: 'buy' },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    });
    await saveDraftSkill(store, skill);
    expect(await enableSkill(store, 'shopping_list')).not.toBeNull();
    expect(await loadEnabledSkills(store)).toHaveLength(1);
    expect(await disableSkill(store, 'shopping_list')).toBe(true);
  });

  it('deletes skill drafts and enabled copies', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping list',
      enabled: false,
      trigger: { type: 'command', command: 'buy' },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    });
    await saveDraftSkill(store, skill);
    await enableSkill(store, 'shopping_list');
    expect(await deleteSkill(store, 'shopping_list')).toBe(true);
    expect(await loadDraftSkills(store)).toHaveLength(0);
    expect(await loadEnabledSkills(store)).toHaveLength(0);
    expect(await deleteSkill(store, 'shopping_list')).toBe(false);
  });

  it('resolves skill commands by visible title', async () => {
    const { store } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping List',
      enabled: false,
      trigger: { type: 'command', command: 'buy' },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    }));
    expect((await enableSkill(store, 'Shopping List'))?.id).toBe('shopping_list');
    expect(await disableSkill(store, 'Shopping List')).toBe(true);
    await enableSkill(store, 'shopping_list');
    expect(await deleteSkill(store, 'Shopping List')).toBe(true);
    expect(await loadEnabledSkills(store)).toHaveLength(0);
  });

  it('executes enabled micro-skill tool by visible title', async () => {
    const { store } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'cat_image',
      title: 'Generate Cat Image',
      enabled: false,
      trigger: { type: 'command', command: 'cat' },
      action: { type: 'reply_template', template: 'generated for {{text}}' },
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'Generate Cat Image');
    const result = await runSkillToolTool.execute(
      { skillId: 'Generate Cat Image', toolName: 'main', args: {}, input: 'сгенерь котика' },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(JSON.parse(result)).toEqual({
      ok: true,
      skillId: 'cat_image',
      title: 'Generate Cat Image',
      toolName: 'main',
      reply: 'generated for сгенерь котика',
      data: null,
      send: null,
      error: null,
    });
  });

  it('returns structured no-output result from micro-skill tool', async () => {
    const { store } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'silent_check',
      title: 'Silent Check',
      enabled: false,
      trigger: { type: 'command', command: 'silent' },
      action: { type: 'remember_fact', extractionHint: 'whole message' },
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'Silent Check');
    const result = await runSkillToolTool.execute(
      { skillId: 'Silent Check', toolName: 'main', args: {}, input: 'проверить условие' },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(JSON.parse(result)).toEqual({
      ok: true,
      skillId: 'silent_check',
      title: 'Silent Check',
      toolName: 'main',
      reply: null,
      data: null,
      send: null,
      error: null,
    });
  });

  it('returns media payload from micro-skill tool without queueing it automatically', async () => {
    const { store } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'photo_tool',
      title: 'Photo Tool',
      enabled: false,
      trigger: { type: 'command', command: 'photo' },
      code: `async () => ({
        send: { kind: 'photo', url: 'https://cdn.example.com/cat.png', caption: 'Кот' }
      })`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'Photo Tool');
    const context: ToolContext = { store, timezone: 'Europe/Moscow', outbox: [] };
    const result = await runSkillToolTool.execute(
      { skillId: 'Photo Tool', toolName: 'main', args: {}, input: 'сгенерь кота' },
      context,
    );
    expect(JSON.parse(result)).toEqual({
      ok: true,
      skillId: 'photo_tool',
      title: 'Photo Tool',
      toolName: 'main',
      reply: 'Кот',
      data: null,
      send: [{ kind: 'photo', url: 'https://cdn.example.com/cat.png', caption: 'Кот' }],
      error: null,
    });
    expect(context.outbox).toEqual([]);
  });

  it('runs scripted skill in sandbox with scoped storage', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'counter',
      title: 'Counter',
      enabled: true,
      trigger: { type: 'command', command: 'count' },
      code: `async (ctx) => {
        const current = await ctx.api.storage.get('count') || 0;
        await ctx.api.storage.set('count', current + 1);
        return { reply: ctx.text + ':' + (current + 1) };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/count' })))).toBe('/count:1');
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/count' })))).toBe('/count:2');
  });

  it('passes extracted ctx.item and stores scripted logs in audit', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'item_logger',
      title: 'Item Logger',
      enabled: true,
      trigger: { type: 'command', command: 'item' },
      code: `async (ctx) => {
        ctx.api.log('item=' + ctx.item);
        return { reply: ctx.item };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/item hello world' })))).toBe('hello world');
    const audit = await store.readJsonl(z.object({
      details: z.object({
        logs: z.array(z.string()).optional(),
      }).passthrough(),
    }).passthrough(), 'skills', 'audit', 'item_logger.jsonl');
    expect(audit.at(-1)?.details.logs).toEqual(['item=hello world']);
  });

  it('supports scripted media send results with public URLs', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'media_sender',
      title: 'Media Sender',
      enabled: true,
      trigger: { type: 'command', command: 'media' },
      code: `async () => ({
        reply: 'Документ готов',
        send: {
          kind: 'file',
          url: 'https://cdn.example.com/report.pdf',
          caption: 'Отчёт',
          filename: 'report.pdf'
        }
      })`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    const result = await runSkill(store, skill, msg({ text: '/media' }));
    expect(result?.reply).toBe('Документ готов');
    expect(result?.send).toEqual([{
      kind: 'file',
      url: 'https://cdn.example.com/report.pdf',
      caption: 'Отчёт',
      filename: 'report.pdf',
    }]);
  });

  it('supports scripted artifact send results', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'html_sender',
      title: 'HTML Sender',
      enabled: true,
      trigger: { type: 'command', command: 'html' },
      code: `async (ctx) => {
        const artifact = await ctx.api.artifacts.createText({
          filename: 'index.html',
          mimeType: 'text/html',
          text: '<h1>Hi</h1>'
        });
        return {
          reply: 'HTML готов',
          send: {
            kind: 'file',
            source: { type: 'artifact', artifactId: artifact.id },
            caption: 'index.html'
          }
        };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    const result = await runSkill(store, skill, msg({ text: '/html' }));
    const artifactId = result?.send?.[0]?.kind !== 'message' && result?.send?.[0]?.source?.type === 'artifact'
      ? result.send[0].source.artifactId
      : '';
    expect(artifactId).toMatch(/^art_/);
    expect((await readArtifactText(store, artifactId)).text).toBe('<h1>Hi</h1>');
    expect(result?.send).toEqual([{
      kind: 'file',
      source: { type: 'artifact', artifactId },
      caption: 'index.html',
    }]);
  });

  it('allows root helper methods without exposing them as tools', async () => {
    const { store } = await tempStore();
    const skill = packageSkill({
      id: 'helper_skill',
      title: 'Helper Skill',
      enabled: true,
      triggers: [{ type: 'command', command: 'helper', tool: 'main' }],
      tools: { main: { description: 'Main tool', schema: { type: 'object', properties: {} } } },
      pluginJs: `export default {
        formatReply(value) {
          return 'helper:' + String(value).trim().toUpperCase();
        },
        tools: {
          async main(ctx) {
            return { ok: true, reply: this.formatReply(ctx.item) };
          }
        }
      };`,
    });

    expect(skillResultText(await runSkill(store, skill, msg({ text: '/helper hello' })))).toBe('helper:HELLO');
    expect(skillResultText(await runSkillTool(store, skill, 'formatReply', { value: 'hello' }, msg({ text: '/helper hello' })))).toContain('не содержит tool');
  });

  it('rejects scripted media send results with non-public URLs', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'unsafe_media_sender',
      title: 'Unsafe Media Sender',
      enabled: true,
      trigger: { type: 'command', command: 'unsafe' },
      code: `async () => ({
        send: { kind: 'photo', url: 'data:image/png;base64,AAAA', caption: 'bad' }
      })`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/unsafe' })))).toBe('Навык Unsafe Media Sender не выполнился.');
  });

  it('lets scripted skills delete scoped storage keys', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'storage_delete',
      title: 'Storage Delete',
      enabled: true,
      trigger: { type: 'command', command: 'drop' },
      code: `async (ctx) => {
        ctx.api.storage.set('token', 'value');
        ctx.api.storage.delete('token');
        ctx.api.storage.set('legacy', 'value');
        ctx.api.storage.set('legacy', null);
        return { reply: String(ctx.api.storage.get('token')) + ':' + String(ctx.api.storage.get('legacy')) };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/drop' })))).toBe('null:null');
  });

  it('lets scripted skills use generic HTTP methods with request limits', async () => {
    const { store } = await tempStore();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      return new Response(JSON.stringify({
        method: init?.method,
        path: new URL(requestUrl).pathname,
        body: init?.body,
        header: init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>)['x-test']
          : null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const skill = microSkillSchema.parse({
        id: 'scripted_http_patch',
        title: 'Scripted HTTP PATCH',
        enabled: true,
        trigger: { type: 'command', command: 'patch' },
        code: `async (ctx) => {
          const res = await ctx.api.http.request({
            method: 'PATCH',
            url: 'https://api.example/items/1',
            headers: { 'x-test': 'ok' },
            body: { text: ctx.text }
          });
          return { reply: res.json.method + ':' + res.json.path + ':' + res.json.header + ':' + res.json.body };
        }`,
        permissions: { httpOrigins: ['https://api.example'] },
        version: 1,
        createdAt: new Date().toISOString(),
      });
      const reply = await runSkill(store, skill, msg({ text: '/patch hi' }), {
        httpAllowedOrigins: ['*'],
        httpTimeoutMs: 1000,
        httpMaxRequestBytes: 128,
        httpMaxResponseBytes: 1024,
      });
      expect(skillResultText(reply)).toContain('PATCH:/items/1:ok:{"text":"/patch hi"}');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('blocks oversized scripted HTTP request bodies before sending', async () => {
    const { store } = await tempStore();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const skill = microSkillSchema.parse({
        id: 'scripted_oversized_http_body',
        title: 'Scripted Oversized HTTP Body',
        enabled: true,
        trigger: { type: 'command', command: 'big' },
        code: `async (ctx) => {
          await ctx.api.http.post('https://api.example/hook', '0123456789');
          return { reply: 'sent' };
        }`,
        permissions: { httpOrigins: ['https://api.example'] },
        version: 1,
        createdAt: new Date().toISOString(),
      });
      const reply = await runSkill(store, skill, msg({ text: '/big' }), {
        httpAllowedOrigins: ['*'],
        httpTimeoutMs: 1000,
        httpMaxRequestBytes: 5,
        httpMaxResponseBytes: 1024,
      });
      expect(skillResultText(reply)).toBe('Навык Scripted Oversized HTTP Body не выполнился.');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('does not enable scripted skill that fails static validation', async () => {
    const { store } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'bad_script',
      title: 'Bad Script',
      enabled: false,
      trigger: { type: 'command', command: 'bad' },
      code: 'async () => ({ reply: String(process.env.SECRET) })',
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    await expect(enableSkill(store, 'bad_script')).rejects.toThrow('forbidden token');
    expect(await loadEnabledSkills(store)).toHaveLength(0);
  });

  it('creates skill drafts through tool', async () => {
    const { store } = await tempStore();
    const result = await createSkillPackageDraftTool.execute(
      {
        title: 'Echo Script',
        whenToUse: 'Use when the user asks to echo text.',
        skillMd: '# Echo Script\n\nUse when the user asks to echo text.',
        pluginJs: 'export default { tools: { async echo(ctx) { return { ok: true, reply: ctx.text }; } } };',
        tools: { echo: { description: 'Echo text', schema: { type: 'object', properties: {} } } },
        triggers: [{ type: 'command', command: '/echo', tool: 'echo' }],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('Создан черновик навыка');
    const drafts = await loadDraftSkills(store);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.whenToUse).toBe('Use when the user asks to echo text.');
  });

  it('keeps skill drafts semantic-only by default and mentions optional command binding', async () => {
    const { store } = await tempStore();
    const result = await createSkillPackageDraftTool.execute(
      {
        title: 'Semantic Echo',
        whenToUse: 'Use when the user asks to echo text.',
        skillMd: '# Semantic Echo\n\nUse when the user asks to echo text.',
        pluginJs: 'export default { tools: { async echo(ctx) { return { ok: true, reply: ctx.text }; } } };',
        tools: { echo: { description: 'Echo text', schema: { type: 'object', properties: {} } } },
        triggers: [],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('Триггеры: semantic only');
    expect(result).toContain('Если нужна отдельная Telegram-команда');
    const drafts = await loadDraftSkills(store);
    expect(drafts[0]?.triggers).toEqual([]);
  });

  it('normalizes explicit slash string triggers as commands when creating one-tool skill drafts', async () => {
    const { store } = await tempStore();
    const result = await createSkillPackageDraftTool.execute(
      {
        title: 'Balance Check',
        whenToUse: 'Use when the user asks for balance.',
        skillMd: '# Balance Check\n\nUse when the user asks for balance.',
        pluginJs: 'export default { tools: { async check() { return { ok: true, reply: "ok" }; } } };',
        tools: { check: { description: 'Check balance', schema: { type: 'object', properties: {} } } },
        triggers: ['/balance', '/баланс'],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('Создан черновик навыка');
    const [draft] = await loadDraftSkills(store);
    expect(draft?.triggers).toEqual([
      { type: 'command', command: 'balance', tool: 'check' },
      { type: 'command', command: 'баланс', tool: 'check' },
    ]);
  });

  it('rejects non-slash plain string triggers', async () => {
    const { store } = await tempStore();
    await expect(createSkillPackageDraftTool.execute(
      {
        title: 'Balance Check',
        whenToUse: 'Use when the user asks for balance.',
        skillMd: '# Balance Check\n\nUse when the user asks for balance.',
        pluginJs: 'export default { tools: { async check() { return { ok: true, reply: "ok" }; } } };',
        tools: { check: { description: 'Check balance', schema: { type: 'object', properties: {} } } },
        triggers: ['баланс'],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    )).rejects.toThrow('Plain string triggers must be explicit slash commands');
  });

  it('rejects message_contains triggers', () => {
    expect(() => skillPackageSchema.parse({
      id: 'contains_trigger',
      title: 'Contains Trigger',
      enabled: false,
      runtime: 'quickjs',
      source: 'chat_generated',
      version: 1,
      triggers: [{ type: 'message_contains', phrases: ['ping'], tool: 'main' }],
      tools: { main: { description: 'Main tool', schema: { type: 'object', properties: {} } } },
      permissions: { httpOrigins: [], storage: true, secrets: [] },
      createdAt: new Date().toISOString(),
      skillMd: '# Contains Trigger',
      pluginJs: 'export default { tools: { async main() { return { ok: true, reply: "ok" }; } } };',
    })).toThrow();
  });

  it('normalizes loose trigger objects when creating one-tool skill drafts', async () => {
    const { store } = await tempStore();
    const result = await createSkillPackageDraftTool.execute(
      {
        title: 'Loose Trigger',
        whenToUse: 'Use when the user asks for a loose trigger test.',
        skillMd: '# Loose Trigger\n\nUse when testing loose triggers.',
        pluginJs: 'export default { tools: { async inspect() { return { ok: true, reply: "ok" }; } } };',
        tools: { inspect: { description: 'Inspect', schema: { type: 'object', properties: {} } } },
        triggers: [{ type: 'command', command: '/inspect' }],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('Создан черновик навыка');
    const [draft] = await loadDraftSkills(store);
    expect(draft?.triggers).toEqual([{ type: 'command', command: 'inspect', tool: 'inspect' }]);
  });

  it('normalizes short scripted skill errors', async () => {
    const { store } = await tempStore();
    const skill = packageSkill({
      id: 'short_error',
      title: 'Short Error',
      pluginJs: 'export default { tools: { async main() { return { ok: false, error: "missing token" }; } } };',
    });
    const reply = await runSkill(store, skill, msg({ text: '/short_error' }));
    expect(reply?.ok).toBe(false);
    expect(reply?.error).toEqual({ code: 'skill_error', message: 'missing token' });
  });

  it('lists micro-skills in lightweight format by default and full format by name', async () => {
    const { store } = await tempStore();
    
    // Создаем скриптовый навык в черновиках
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'test_script_skill',
      title: 'Test Script',
      enabled: false,
      trigger: { type: 'command', command: 'test' },
      code: 'async () => ({ reply: "hello" })',
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    }));

    // 1. Проверяем вызов без параметров (облегченный формат)
    const listResult = await listSkillPackagesTool.execute({}, { store, timezone: 'UTC' });
    const parsedList = JSON.parse(listResult);
    
    expect(parsedList.drafts).toHaveLength(1);
    expect(parsedList.drafts[0].id).toBe('test_script_skill');
    expect(parsedList.drafts[0].pluginJs).toBeUndefined();
    expect(parsedList.drafts[0].hasPluginJs).toBe(true);

    // 2. Проверяем вызов с указанием конкретного имени
    const detailsResult = await listSkillPackagesTool.execute({ name: 'Test Script' }, { store, timezone: 'UTC' });
    const parsedDetails = JSON.parse(detailsResult);
    
    expect(parsedDetails.ok).toBe(true);
    expect(parsedDetails.skill.id).toBe('test_script_skill');
    expect(parsedDetails.skill.pluginJs).toContain('async () => ({ reply: "hello" })');

    // 3. Проверяем вызов с несуществующим именем
    const missingResult = await listSkillPackagesTool.execute({ name: 'Unknown Skill' }, { store, timezone: 'UTC' });
    const parsedMissing = JSON.parse(missingResult);
    expect(parsedMissing.ok).toBe(false);
    expect(parsedMissing.error).toContain('not found');
  });
});

describe('cron schema', () => {
  it('validates cron expression', () => {
    expect(() => cronJobSchema.parse({
      id: 'cron_test',
      title: 'Test',
      enabled: false,
      cron: '0 10 * * 3',
      timezone: 'Europe/Amsterdam',
      action: { type: 'send_static_message', text: 'hi' },
      createdAt: new Date().toISOString(),
    })).not.toThrow();
    expect(() => cronJobSchema.parse({
      id: 'cron_bad', title: 'Bad', enabled: false, cron: 'bad', timezone: 'Europe/Amsterdam', action: { type: 'send_static_message', text: 'hi' }, createdAt: new Date().toISOString(),
    })).toThrow();
  });

  it('supports cron actions that run enabled micro-skills', async () => {
    const sent: Array<{ text: string; threadId?: number | null }> = [];
    const toolThreads: Array<number | null | undefined> = [];
    await runCronJob(
      cronJobSchema.parse({
        id: 'cron_skill_test',
        title: 'Run skill',
        enabled: true,
        cron: '* * * * *',
        timezone: 'UTC',
        threadId: 42,
        action: { type: 'run_skill_tool', skillId: 'hello', toolName: 'main', args: {}, text: 'cron input', sendResult: true },
        createdAt: new Date().toISOString(),
      }),
      {
        sendMessage: async (result, threadId) => {
          sent.push({ text: skillResultText(result) ?? '', threadId });
        },
        askAgent: async () => 'agent',
        runSkillTool: async (skillId, _toolName, _args, text, threadId) => {
          toolThreads.push(threadId);
          return textSkillResult(`${skillId}:${text}`);
        },
      },
    );
    expect(toolThreads).toEqual([42]);
    expect(sent).toEqual([{ text: 'hello:cron input', threadId: 42 }]);
  });

  it('passes cron job context to agent actions', async () => {
    const job = cronJobSchema.parse({
      id: 'cron_agent_test',
      title: 'Ask agent',
      enabled: true,
      cron: '* * * * *',
      timezone: 'UTC',
      threadId: 42,
      action: { type: 'ask_agent_and_send', prompt: 'cron prompt' },
      createdAt: new Date().toISOString(),
    });
    const agentCalls: Array<{ prompt: string; threadId?: number | null }> = [];
    const sent: Array<{ text: string; threadId?: number | null }> = [];

    await runCronJob(job, {
      sendMessage: async (result, threadId) => {
        sent.push({ text: skillResultText(result) ?? '', threadId });
      },
      askAgent: async (prompt, passedJob) => {
        agentCalls.push({ prompt, threadId: passedJob.threadId });
        return 'agent reply';
      },
      runSkillTool: async () => null,
    });

    expect(agentCalls).toEqual([{ prompt: 'cron prompt', threadId: 42 }]);
    expect(sent).toEqual([{ text: 'agent reply', threadId: 42 }]);
  });

  it('keeps cron silent when micro-skill has no reply', async () => {
    const sent: string[] = [];
    await runCronJob(
      cronJobSchema.parse({
        id: 'cron_silent_skill_test',
        title: 'Check condition',
        enabled: true,
        cron: '* * * * *',
        timezone: 'UTC',
        action: { type: 'run_skill_tool', skillId: 'silent', toolName: 'main', args: {}, text: 'cron input', sendResult: true },
        createdAt: new Date().toISOString(),
      }),
      {
        sendMessage: async (result) => {
          sent.push(skillResultText(result) ?? '');
        },
        askAgent: async () => 'agent',
        runSkillTool: async () => null,
      },
    );
    expect(sent).toEqual([]);
  });

  it('deletes cron jobs from scheduler storage by visible title', async () => {
    const { scheduler } = await tempStore();
    await scheduler.saveDraft(cronJobSchema.parse({
      id: 'cron_delete_test',
      title: 'Delete me',
      enabled: false,
      cron: '* * * * *',
      timezone: 'UTC',
      action: { type: 'send_static_message', text: 'hi' },
      createdAt: new Date().toISOString(),
    }));
    expect(await scheduler.delete('Delete me')).toBe(true);
    expect(await scheduler.list()).toHaveLength(0);
    expect(await scheduler.delete('cron_delete_test')).toBe(false);
  });
});

describe('output limiter', () => {
  it('cuts to maximum characters', () => {
    expect(limitOutput('a'.repeat(100), 20).length).toBeLessThanOrEqual(20);
  });
});

describe('tool loop', () => {
  it('adds a native tool-calling instruction when tools are available', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop',
      description: 'noop',
      schema: z.object({}),
      execute: async () => 'ok',
    });
    let sawNotice = false;
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            sawNotice = messages.some((message: any) =>
              message.role === 'system'
              && String(message.content).includes('Native tool calling is available')
              && String(message.content).includes('use only the API-provided tool_calls')
              && String(message.content).includes('Do not write tool calls')
            );
            return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
          },
        },
      },
    };
    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'system', content: 'base' }, { role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
    });
    expect(result).toBe('ok');
    expect(sawNotice).toBe(true);
  });

  it('stops at max steps', async () => {
    const registry = new ToolRegistry();
    const tool: AgentTool<Record<string, never>> = {
      name: 'noop',
      description: 'noop',
      schema: z.object({}),
      execute: async () => 'ok',
    };
    registry.register(tool);
    const fakeClient = {
      chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'noop', arguments: '{}' } }] } }] }) } },
    };
    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
    });
    expect(result).toContain('лимит');
  });

  it('returns structured validation errors to the model when tool arguments are invalid', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'needs_object',
      description: 'needs object',
      schema: z.object({ item: z.object({ name: z.string() }) }),
      execute: async () => 'ok',
    });
    const toolMessages: string[] = [];
    let calls = 0;
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            calls += 1;
            const lastTool = messages.filter((message: any) => message.role === 'tool').at(-1);
            if (lastTool) {
              toolMessages.push(lastTool.content);
              return { choices: [{ message: { role: 'assistant', content: 'handled' } }] };
            }
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'bad-1',
                    type: 'function',
                    function: { name: 'needs_object', arguments: '{"item":"wrong"}' },
                  }],
                },
              }],
            };
          },
        },
      },
    };
    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
    });
    expect(result).toBe('handled');
    expect(calls).toBe(2);
    expect(JSON.parse(toolMessages[0]!).error.code).toBe('invalid_tool_arguments');
  });

  it('retries transient LLM failures inside the tool loop without rerunning tools', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => 'tool result');
    registry.register({
      name: 'side_effect',
      description: 'side effect',
      schema: z.object({}),
      execute,
    });
    let calls = 0;
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            calls += 1;
            if (!messages.some((message: any) => message.role === 'tool')) {
              return {
                choices: [{
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'side_effect', arguments: '{}' },
                    }],
                  },
                }],
              };
            }
            if (calls === 2) throw new Error('Request timed out.');
            return { choices: [{ message: { role: 'assistant', content: 'handled after retry' } }] };
          },
        },
      },
    };
    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 3,
      completionRetries: 1,
    });
    expect(result).toBe('handled after retry');
    expect(calls).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('trims oversized tool observations before the next tool-loop iteration', async () => {
    const registry = new ToolRegistry();
    const hugeResult = 'данные '.repeat(10000);
    registry.register({
      name: 'huge_tool',
      description: 'huge',
      schema: z.object({}),
      execute: async () => hugeResult,
    });
    let capturedToolContent = '';
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            const lastTool = messages.filter((message: any) => message.role === 'tool').at(-1);
            if (lastTool) {
              capturedToolContent = lastTool.content;
              return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
            }
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'huge-1',
                    type: 'function',
                    function: { name: 'huge_tool', arguments: '{}' },
                  }],
                },
              }],
            };
          },
        },
      },
    };
    const budgetConfig = { contextWindowTokens: 2000, contextBudgetTokens: 100, replyMaxTokens: 10 };
    const policy = buildContextPolicy(budgetConfig);
    policy.stages.toolObservation.maxTokens = 20;
    const allocation = allocateContextStages(
      [{ kind: 'user', content: 'go' }],
      budgetConfig,
    );

    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
      contextBudget: { allocation, policy },
    });

    expect(result).toBe('done');
    expect(capturedToolContent.length).toBeLessThan(hugeResult.length);
    expect(capturedToolContent).toContain('[truncated: tool result exceeded context budget]');
  });

  it('counts tool schemas when fitting tool observations', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'schema_heavy_tool',
      description: 'описание '.repeat(2000),
      schema: z.object({}),
      execute: async () => 'small result',
    });
    let capturedToolContent = '';
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            const lastTool = messages.filter((message: any) => message.role === 'tool').at(-1);
            if (lastTool) {
              capturedToolContent = lastTool.content;
              return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
            }
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'schema-heavy-1',
                    type: 'function',
                    function: { name: 'schema_heavy_tool', arguments: '{}' },
                  }],
                },
              }],
            };
          },
        },
      },
    };
    const budgetConfig = { contextWindowTokens: 1000, contextBudgetTokens: 100, replyMaxTokens: 10 };
    const policy = buildContextPolicy(budgetConfig);
    policy.stages.toolObservation.maxTokens = 20;
    const allocation = allocateContextStages(
      [{ kind: 'user', content: 'go' }],
      budgetConfig,
    );

    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
      contextBudget: { allocation, policy },
    });

    expect(result).toBe('done');
    expect(capturedToolContent).toBe('[Tool result omitted: context window exhausted.]');
  });

});

describe('tool schemas', () => {
  it('exposes nested package fields as objects for OpenAI tool calling', () => {
    const skillSchema = toOpenAITool(createSkillPackageDraftTool).function.parameters as any;
    expect(skillSchema.properties.triggers.items.anyOf[0].type).toBe('object');
    expect(skillSchema.properties.triggers.items.anyOf[1].type).toBe('string');
    expect(skillSchema.properties.tools.additionalProperties.type).toBe('object');

    const cronSchema = toOpenAITool(createCronJobTool).function.parameters as any;
    expect(cronSchema.properties.action.oneOf[0].type).toBe('object');
    expect(cronSchema.required).not.toContain('id');
  });

  it('normalizes natural-language cron ids before saving drafts', async () => {
    const { store, scheduler } = await tempStore();
    const result = await createCronJobTool.execute(
      {
        id: 'я спамер',
        title: 'я спамер',
        cron: '*/3 * * * *',
        action: { type: 'send_static_message', text: 'Привет мир' },
      },
      { store, scheduler, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('cron_ya_spamer');
    expect((await scheduler.list())[0]?.id).toBe('cron_ya_spamer');
  });

  it('stores Telegram thread id on cron drafts created from a topic message', async () => {
    const { store, scheduler } = await tempStore();
    await createCronJobTool.execute(
      {
        title: 'Topic reminder',
        cron: '*/5 * * * *',
        action: { type: 'send_static_message', text: 'Проверить topic' },
      },
      { store, scheduler, timezone: 'Europe/Moscow', currentMessage: msg({ threadId: 777 }) },
    );
    expect((await scheduler.list())[0]?.threadId).toBe(777);
  });

  it('runs template and blocks non-allowlisted HTTP actions', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'webhook_test',
      title: 'Webhook test',
      enabled: true,
      trigger: { type: 'command', command: 'ping' },
      action: {
        type: 'chain',
        actions: [
          { type: 'reply_template', template: 'item={{item}} user={{username}}' },
          { type: 'http_request', method: 'GET', url: 'https://example.com/hook?text={{item}}' },
        ],
      },
      createdAt: new Date().toISOString(),
    });
    const reply = await runSkill(
      store,
      skill,
      msg({ text: 'ping hello', username: 'seva' }),
      { httpAllowedOrigins: [], httpTimeoutMs: 100 },
    );
    expect(skillResultText(reply)).toContain('item=hello user=seva');
    expect(skillResultText(reply)).toContain('заблокирован настройками безопасности');
  });

  it('allows wildcard HTTP origins with response size limits', async () => {
    const { store } = await tempStore();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      return new Response(JSON.stringify({ path: new URL(requestUrl).pathname }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const skill = microSkillSchema.parse({
        id: 'wildcard_http_test',
        title: 'Wildcard HTTP test',
        enabled: true,
        trigger: { type: 'command', command: 'ping' },
        action: {
          type: 'http_request',
          method: 'GET',
          url: 'https://unknown.example/hook?text={{item}}',
          responseTemplate: 'status={{status}} path={{path}} json={{json.path}} body={{body}}',
        },
        createdAt: new Date().toISOString(),
      });
      const reply = await runSkill(store, skill, msg({ text: 'ping hello' }), {
        httpAllowedOrigins: ['*'],
        httpTimeoutMs: 1000,
        httpMaxRequestBytes: 128,
        httpMaxResponseBytes: 1024,
      });
      expect(skillResultText(reply)).toContain('status=200');
      expect(skillResultText(reply)).toContain('path=/hook');
      expect(skillResultText(reply)).toContain('json=/hook');
      expect(skillResultText(reply)).toContain('/hook');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('blocks oversized HTTP request bodies before sending', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'oversized_http_body_test',
      title: 'Oversized HTTP body test',
      enabled: true,
      trigger: { type: 'command', command: 'ping' },
      action: {
        type: 'http_request',
        method: 'POST',
        url: 'https://example.com/hook',
        bodyTemplate: '0123456789',
      },
      createdAt: new Date().toISOString(),
    });
    const reply = await runSkill(store, skill, msg({ text: 'ping' }), {
      httpAllowedOrigins: ['*'],
      httpTimeoutMs: 100,
      httpMaxRequestBytes: 5,
      httpMaxResponseBytes: 1024,
    });
    expect(skillResultText(reply)).toContain('тело запроса больше 5 байт');
  });
});

describe('execute_http_query tool', () => {
  it('executes simple GET query and returns results when origin is allowed', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ some: 'data' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await executeHttpQueryTool.execute(
        { url: 'https://api.external.com/v1/info', method: 'GET' },
        { store, timezone: 'UTC', httpAllowedOrigins: ['https://api.external.com'] }
      );
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe(200);
      expect(JSON.parse(parsed.body)).toEqual({ some: 'data' });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('blocks private IPs and localhost hosts', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');
    
    const resultLocalhost = await executeHttpQueryTool.execute(
      { url: 'http://localhost/secret', method: 'GET' },
      { store, timezone: 'UTC', httpAllowedOrigins: ['*'] }
    );
    expect(resultLocalhost).toContain('forbidden');

    const resultLoopbackIp = await executeHttpQueryTool.execute(
      { url: 'http://127.0.0.1/admin', method: 'GET' },
      { store, timezone: 'UTC', httpAllowedOrigins: ['*'] }
    );
    expect(resultLoopbackIp).toContain('forbidden');
  });

  it('blocks queries to origins that are not allowed', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');

    const result = await executeHttpQueryTool.execute(
      { url: 'https://malicious.com/api', method: 'GET' },
      { store, timezone: 'UTC', httpAllowedOrigins: ['https://safe.com'] }
    );
    expect(result).toContain('blocked by security settings');
  });

  it('safely follows redirects and validates security on every hop', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');
    const originalFetch = globalThis.fetch;
    
    // Мокаем цепочку редиректов: safe.com -> redirect -> localhost/secret
    let callIndex = 0;
    const fetchMock = vi.fn(async () => {
      if (callIndex === 0) {
        callIndex++;
        return new Response('', {
          status: 302,
          headers: { 'location': 'http://localhost/secret' },
        });
      }
      return new Response('secret data', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await executeHttpQueryTool.execute(
        { url: 'https://safe.com/start', method: 'GET' },
        { store, timezone: 'UTC', httpAllowedOrigins: ['*'] }
      );
      // Должно заблокировать на втором хопе редиректа!
      expect(result).toContain('forbidden');
      expect(fetchMock).toHaveBeenCalledOnce(); // Второй запрос (к localhost) совершаться не должен
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });
});

describe('secrets system', () => {
  it('reads, writes, and deletes secrets in store', async () => {
    const { store } = await tempStore();
    const { readSecrets, setSecret, deleteSecret } = await import('../../src/memory/secrets');

    // Сначала пусто
    expect(await readSecrets(store)).toEqual({});

    // Запись
    await setSecret(store, 'API_KEY', 'secret_value_123');
    expect(await readSecrets(store)).toEqual({ API_KEY: 'secret_value_123' });

    // Перезапись
    await setSecret(store, 'API_KEY', 'updated_value');
    expect(await readSecrets(store)).toEqual({ API_KEY: 'updated_value' });

    // Удаление отсутствующего
    expect(await deleteSecret(store, 'NOT_EXISTS')).toBe(false);

    // Удаление существующего
    expect(await deleteSecret(store, 'API_KEY')).toBe(true);
    expect(await readSecrets(store)).toEqual({});
  });

  it('isolates secrets in declarative skills (only allows declared)', async () => {
    const { store } = await tempStore();
    const { setSecret } = await import('../../src/memory/secrets');
    await setSecret(store, 'GITHUB_TOKEN', 'token_123');
    await setSecret(store, 'OTHER_KEY', 'other_123');

    const skill = microSkillSchema.parse({
      id: 'webhook_secrets_test',
      title: 'Secrets test',
      enabled: true,
      trigger: { type: 'command', command: 'secrets' },
      secrets: ['GITHUB_TOKEN'], // Запрашиваем ТОЛЬКО GITHUB_TOKEN
      action: {
        type: 'reply_template',
        template: 'github={{secrets.GITHUB_TOKEN}} other={{secrets.OTHER_KEY}}',
      },
      createdAt: new Date().toISOString(),
    });

    const reply = await runSkill(store, skill, msg({ text: '/secrets' }));
    // GITHUB_TOKEN должен быть подставлен, OTHER_KEY должен остаться пустым (изоляция)
    expect(skillResultText(reply)).toContain('github=token_123');
    expect(skillResultText(reply)).toContain('other=');
    expect(skillResultText(reply)).not.toContain('other_123');
  });

  it('isolates secrets in scripted skills (only allows declared in QuickJS)', async () => {
    const { store } = await tempStore();
    const { setSecret } = await import('../../src/memory/secrets');
    await setSecret(store, 'GITHUB_TOKEN', 'token_123');
    await setSecret(store, 'OTHER_KEY', 'other_123');

    const skill = microSkillSchema.parse({
      id: 'script_secrets_test',
      title: 'Script secrets test',
      enabled: true,
      trigger: { type: 'command', command: 'script_secrets' },
      secrets: ['GITHUB_TOKEN'], // Запрашиваем ТОЛЬКО GITHUB_TOKEN
      code: `async (ctx) => {
        const gh = await ctx.api.secrets.get('GITHUB_TOKEN');
        const other = await ctx.api.secrets.get('OTHER_KEY');
        return { reply: 'gh=' + gh + ' other=' + other };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });

    const reply = await runSkill(store, skill, msg({ text: '/script_secrets' }));
    expect(skillResultText(reply)).toContain('gh=token_123');
    expect(skillResultText(reply)).toContain('other=null');
  });

  it('returns warnings when enabling a skill with missing secrets', async () => {
    const { store, config, scheduler } = await tempStore();
    const { handleAgentCommand } = await import('../../src/telegram/commands');
    
    // Создаем черновик навыка, запрашивающего MY_SECRET
    const skill = microSkillSchema.parse({
      id: 'warn_skill',
      title: 'Warn Skill',
      enabled: false,
      trigger: { type: 'command', command: 'warn' },
      secrets: ['MY_SECRET'],
      action: { type: 'reply_static', text: 'hi' },
      createdAt: new Date().toISOString(),
    });
    await saveDraftSkill(store, skill);

    // Включаем без заполненного секрета -> должно быть предупреждение
    const resultNoSecret = await handleAgentCommand('/agentur skill enable warn_skill', {
      store,
      config,
      scheduler,
      llm: { chat: async () => 'ok', minimalCheck: async () => 'ok', toolCheck: async () => false },
    });
    expect(resultNoSecret).toContain('Навык включён: warn_skill');
    expect(resultNoSecret).toContain('Внимание! Для полноценной работы навыка требуются секреты');
    expect(resultNoSecret).toContain('MY_SECRET');
  });
});
