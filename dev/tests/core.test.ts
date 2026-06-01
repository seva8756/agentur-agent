import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ChatRuntimeManager } from '../../src/agent/chatRuntime';
import { loadConfig, AppConfig } from '../../src/config';
import { buildChatContext, trimMessagesToBudget } from '../../src/agent/contextBuilder';
import { limitOutput } from '../../src/agent/outputLimiter';
import { decideReply } from '../../src/agent/replyPolicy';
import { generateAgentReply } from '../../src/agent/respond';
import { runToolLoop } from '../../src/llm/toolLoop';
import { FileStore, initializeDataDir } from '../../src/memory/fileStore';
import { readIdentity, writeIdentity } from '../../src/memory/identity';
import { readChatSettings, setReplyMode } from '../../src/memory/chatSettings';
import { smoothMood, defaultMood, writeMood } from '../../src/memory/moodDiary';
import { appendRecentMessage } from '../../src/memory/recentMessages';
import { AgentScheduler } from '../../src/scheduler/scheduler';
import { runCronJob } from '../../src/scheduler/jobRuntime';
import { cronJobSchema } from '../../src/scheduler/schema';
import { enableSkill, disableSkill, saveDraftSkill, loadDraftSkills, loadEnabledSkills, deleteSkill } from '../../src/skills/loader';
import { matchSkill, matchesCommand } from '../../src/skills/matcher';
import { microSkillSchema } from '../../src/skills/schema';
import { runSkill } from '../../src/skills/runtime';
import { ToolRegistry } from '../../src/tools/registry';
import { AgentTool, toOpenAITool } from '../../src/tools/types';
import { createCronJobTool } from '../../src/tools/implementations/createCronJob';
import { createMicroSkillDraftTool } from '../../src/tools/implementations/createMicroSkillDraft';
import { executeMicroSkillTool } from '../../src/tools/implementations/executeMicroSkill';
import { routeMessage } from '../../src/telegram/messageRouter';
import { handleAgentCommand } from '../../src/telegram/commands';
import { markdownToTelegramHtml } from '../../src/telegram/formatting';
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
  const scheduler = new AgentScheduler(store, { sendMessage: async () => undefined, askAgent: async () => 'ok', runMicroSkill: async () => null });
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
    expect(reply).toContain('Могу помочь');
    expect(await store.readJsonl(z.any(), 'chat', 'recent.jsonl')).toHaveLength(1);
  });

  it('does not fall back to generic LLM reply when a matched skill returns no text', async () => {
    const { store, config, scheduler } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'silent_memory',
      title: 'Silent memory',
      enabled: false,
      trigger: { type: 'message_contains', phrases: ['запомни молча'] },
      action: { type: 'remember_fact', extractionHint: 'remember full message' },
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'silent_memory');
    const reply = await routeMessage(msg({ text: 'запомни молча это факт' }), {
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
    expect(decideReply(msg({ replyToBot: true }), 'agentbot').shouldReply).toBe(true);
    expect(decideReply(msg({ text: '/agentur status' }), 'agentbot').shouldReply).toBe(true);
    expect(decideReply(msg({ text: '/agentur@agentbot status' }), 'agentbot').shouldReply).toBe(true);
    expect(decideReply(msg({ text: '/agents status' }), 'agentbot').shouldReply).toBe(false);
    expect(decideReply(msg({ text: 'люди, как дела?' }), 'agentbot').shouldReply).toBe(false);
  });
});

describe('telegram formatting', () => {
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
});

describe('context trimming', () => {
  it('injects current local time into context', async () => {
    const { store } = await tempStore();
    await writeMood(store, { warmth: 0.2, tension: 0.7, humor: 0.1, updatedAt: new Date().toISOString() });
    const context = await buildChatContext(store, 'который час?', {
      maxChars: 1000,
      recentLimit: 5,
      factsMaxChars: 500,
      timezone: 'Europe/Moscow',
    });
    expect(String(context[1]?.content)).toContain('Current local time');
    expect(String(context[1]?.content)).toContain('Europe/Moscow');
    expect(String(context[0]?.content)).toContain('Mood diary');
    expect(String(context[0]?.content)).toContain('tension=0.70');
    expect(String(context[0]?.content)).toContain('Шутки лучше минимизировать');
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
      maxChars: 1000,
      recentLimit: 5,
      factsMaxChars: 500,
      timezone: 'Europe/Moscow',
    });
    expect(String(context[0]?.content)).toContain('Language mode: uncensored');
    expect(String(context[0]?.content)).toContain('Мат разрешён');
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
      maxChars: 1000,
      recentLimit: 5,
      factsMaxChars: 500,
      timezone: 'Europe/Moscow',
    });
    expect(String(context[0]?.content)).toContain('@username');
    expect(String(context[2]?.content)).toContain('Сева (@seva): посмотри задачу');
  });

  it('drops old middle context before system/current input', () => {
    const trimmed = trimMessagesToBudget(
      [
        { role: 'system', content: 'system' },
        { role: 'system', content: 'old'.repeat(1000) },
        { role: 'assistant', content: 'older'.repeat(1000) },
        { role: 'user', content: 'current input' },
      ],
      100,
    );
    expect(trimmed[0]?.content).toBe('system');
    expect(trimmed.at(-1)?.role).toBe('user');
    expect(String(trimmed.at(-1)?.content)).toContain('current');
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

  it('includes enabled micro-skills for semantic tool selection', async () => {
    const { store, config, scheduler } = await tempStore();
    await saveDraftSkill(store, microSkillSchema.parse({
      id: 'jsonbin_fetch',
      title: 'Fetch JSONBin data',
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
            typeof message.content === 'string' && message.content.includes('execute_micro_skill') && message.content.includes('jsonbin_fetch')
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
    const context = await buildChatContext(store, 'привет', { maxChars: 1000, recentLimit: 5, factsMaxChars: 500, timezone: 'Europe/Moscow' });
    expect(String(context[0]?.content)).toContain('дворецкий');
    expect(String(context[0]?.content)).toContain('не переписывается под настроение');
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
      trigger: { type: 'message_contains', phrases: ['надо купить'] },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    });
    expect(skill.id).toBe('shopping_list');
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
    expect(matchSkill(msg({ text: '/jsonbin' }), [skill])?.id).toBe('jsonbin_fetch');
  });

  it('enables and disables JSON skill', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping list',
      enabled: false,
      trigger: { type: 'message_contains', phrases: ['надо купить'] },
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
      trigger: { type: 'message_contains', phrases: ['надо купить'] },
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
      trigger: { type: 'message_contains', phrases: ['надо купить'] },
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
    const result = await executeMicroSkillTool.execute(
      { name: 'Generate Cat Image', input: 'сгенерь котика' },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toBe('generated for сгенерь котика');
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
    const sent: string[] = [];
    await runCronJob(
      cronJobSchema.parse({
        id: 'cron_skill_test',
        title: 'Run skill',
        enabled: true,
        cron: '* * * * *',
        timezone: 'UTC',
        action: { type: 'run_micro_skill', skillId: 'hello', text: 'cron input', sendResult: true },
        createdAt: new Date().toISOString(),
      }),
      {
        sendMessage: async (text) => {
          sent.push(text);
        },
        askAgent: async () => 'agent',
        runMicroSkill: async (skillId, text) => `${skillId}:${text}`,
      },
    );
    expect(sent).toEqual(['hello:cron input']);
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
});

describe('tool schemas', () => {
  it('exposes nested trigger/action as objects for OpenAI tool calling', () => {
    const skillSchema = toOpenAITool(createMicroSkillDraftTool).function.parameters as any;
    expect(skillSchema.properties.trigger.oneOf[0].type).toBe('object');
    expect(skillSchema.properties.action.anyOf[0].oneOf[0].type).toBe('object');

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

  it('runs template and blocks non-allowlisted HTTP actions', async () => {
    const { store } = await tempStore();
    const skill = microSkillSchema.parse({
      id: 'webhook_test',
      title: 'Webhook test',
      enabled: true,
      trigger: { type: 'message_contains', phrases: ['ping'] },
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
    expect(reply).toContain('item=hello user=seva');
    expect(reply).toContain('заблокирован настройками безопасности');
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
        trigger: { type: 'message_contains', phrases: ['ping'] },
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
      expect(reply).toContain('status=200');
      expect(reply).toContain('path=/hook');
      expect(reply).toContain('json=/hook');
      expect(reply).toContain('/hook');
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
      trigger: { type: 'message_contains', phrases: ['ping'] },
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
    expect(reply).toContain('тело запроса больше 5 байт');
  });
});
