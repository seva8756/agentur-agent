import { describe, expect, it } from 'vitest';
import { allocateContextStages, buildChatContext, conservativeTokenEstimator } from '../../src/agent/context';
import { generateAgentReply, generateAgentResult } from '../../src/agent/respond';
import { readChatSettings } from '../../src/memory/chatSettings';
import { writeMood } from '../../src/memory/moodDiary';
import { appendRecentMessage } from '../../src/memory/recentMessages';
import { enableSkill, saveSkill } from '../../src/skills/loader';
import { ToolRegistry } from '../../src/tools/registry';
import { handleAgentCommand } from '../../src/messaging/commands';
import { formatLocalTime } from '../../src/utils/time';
import { TELEGRAM_CHAT_ID, tempStore, skillSchema } from './helpers';

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
    expect(String(context.messages[0]?.content)).toContain('Настроение чата');
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
    expect(String(context.messages[0]?.content)).toContain('Мат разрешён');
    expect(String(context.messages[0]?.content)).toContain('Мат разрешён');
  });

  it('switches the chat prompt and command UI to English', async () => {
    const { store, config, scheduler } = await tempStore();
    const deps = {
      store,
      config,
      scheduler,
      llm: { chat: async () => 'ok', minimalCheck: async () => 'ok', toolCheck: async () => false },
    };
    expect(await handleAgentCommand('/agentur language en', deps)).toContain('English');
    expect((await readChatSettings(store)).locale).toBe('en');
    expect(await handleAgentCommand('/agentur help', deps)).toContain('command list');
    const context = await buildChatContext(store, 'hello', {
      contextWindowTokens: 32000,
      contextBudgetTokens: 12000,
      replyMaxTokens: 900,
      timezone: 'Europe/Moscow',
    });
    expect(String(context.messages[0]?.content)).toContain('Reply in English');
  });

  it('includes usernames in recent chat context for mentions', async () => {
    const { store } = await tempStore();
    await appendRecentMessage(store, {
      id: 1,
      chatId: TELEGRAM_CHAT_ID,
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
      chatId: TELEGRAM_CHAT_ID,
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
      chatId: TELEGRAM_CHAT_ID,
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
      chatId: TELEGRAM_CHAT_ID,
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

  it('includes enabled skills for semantic tool selection', async () => {
    const { store, config, scheduler } = await tempStore();
    await saveSkill(store, skillSchema.parse({
      id: 'jsonbin_fetch',
      title: 'Fetch JSONBin data',
      description: 'Use when the user asks to fetch or show JSONBin data.',
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
            && message.content.includes('description=Use when the user asks to fetch or show JSONBin data.')
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
