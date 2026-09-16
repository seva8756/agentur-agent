import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { Bot } from 'grammy';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ChatRuntimeManager } from '../../src/agent/chatRuntime';
import { loadConfig } from '../../src/config';
import { decideReply } from '../../src/agent/replyPolicy';
import { setReplyMode } from '../../src/memory/chatSettings';
import { readMood, writeMood } from '../../src/memory/moodDiary';
import { enableSkill, saveSkill } from '../../src/skills/loader';
import { skillResultText } from '../../src/skills/result';
import { ToolRegistry } from '../../src/tools/registry';
import { routeMessage } from '../../src/messaging/messageRouter';
import { hasTelegramRichMarkup, markdownToTelegramHtml } from '../../src/telegram/formatting';
import { sendMarkdown, sendSkillResult, truncateForTelegram } from '../../src/telegram/send';
import { providerChatId } from '../../src/messaging/chatAddress';
import { TELEGRAM_CHAT_ID, TELEGRAM_CHAT_ID_2, TELEGRAM_DENIED_CHAT_ID, telegramError, telegramBadRequest, tempStore, msg, skillSchema } from './helpers';

describe('single-chat filtering', () => {
  it('ignores and does not store messages from other chats', async () => {
    const { store, config, scheduler } = await tempStore();
    const reply = await routeMessage(msg({ chatId: providerChatId('telegram', '-999'), text: '@agentbot ping' }), {
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
    const first = await manager.getRuntime(TELEGRAM_CHAT_ID);
    const second = await manager.getRuntime(TELEGRAM_CHAT_ID_2);
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

    const first = await manager.getRuntime(TELEGRAM_CHAT_ID);
    const second = await manager.getRuntime(TELEGRAM_CHAT_ID_2);
    const denied = await manager.getRuntime(TELEGRAM_DENIED_CHAT_ID);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(denied).toBeNull();
    expect(first?.store.rootDir).not.toEqual(second?.store.rootDir);
    const deniedDir = path.join(dir, 'chats', Buffer.from(TELEGRAM_DENIED_CHAT_ID, 'utf8').toString('base64url'));
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
    const captureConfig = { ...config, chatFullCaptureIds: [TELEGRAM_CHAT_ID] };
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

  it('updates mood on its own interval outside full-capture chats', async () => {
    const { store, config, scheduler } = await tempStore();
    let moodCalls = 0;
    const llm = {
      chat: async (messages: ChatCompletionMessageParam[]) => {
        if (String(messages[0]?.content).includes('Assess the mood')) {
          moodCalls += 1;
          return '{"warmth":1,"tension":0.6,"humor":0.4}';
        }
        return 'pong';
      },
      minimalCheck: async () => 'ok',
      toolCheck: async () => false,
    };
    const deps = {
      config: { ...config, moodUpdateEveryMessages: 2, interactionSummaryEveryMessages: 10 },
      botUsername: 'agentbot',
      store,
      scheduler,
      tools: new ToolRegistry(),
      llm,
    };

    await routeMessage(msg({ messageId: 1, text: '@agentbot first' }), deps);
    await routeMessage(msg({ messageId: 2, text: '@agentbot second' }), deps);

    expect(moodCalls).toBe(1);
    expect((await readMood(store)).warmth).toBeCloseTo(0.6);
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
    await saveSkill(store, skillSchema.parse({
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

describe('reply attachments', () => {
  it('passes an image from the quoted message with reply-specific context', async () => {
    const { store, config, scheduler } = await tempStore();
    let content = '';
    const reply = await routeMessage(msg({
      text: 'что на ней?',
      replyToBot: true,
      quotedMessage: { text: '[изображение]', authorName: 'Seva' },
      quotedImage: { dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', sizeBytes: 4 },
    }), {
      config,
      botUsername: 'agentbot',
      store,
      scheduler,
      tools: new ToolRegistry(),
      llm: {
        chat: async (messages) => {
          const last = messages.at(-1);
          content = JSON.stringify(last?.content);
          return 'На изображении тест.';
        },
        minimalCheck: async () => 'ok',
        toolCheck: async () => false,
      },
    });
    expect(skillResultText(reply)).toContain('На изображении');
    expect(content).toContain('quoted message');
    expect(content).toContain('image_url');
    expect(content).toContain('data:image/png;base64,AAAA');
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

  it('detects telegram rich markup without treating plain chat as markdown', () => {
    expect(hasTelegramRichMarkup('Ок, сделал.')).toBe(false);
    expect(hasTelegramRichMarkup('Добавь SKILL_HTTP_ALLOWED_ORIGINS=*')).toBe(false);
    expect(hasTelegramRichMarkup('**важно**')).toBe(true);
    expect(hasTelegramRichMarkup('файл `.txt`')).toBe(true);
    expect(hasTelegramRichMarkup('- пункт')).toBe(true);
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

  it.each([
    '**важно**',
    'Результат:\n\n| Email | userId | Статус |\n| --- | --- | --- |\n| user@example.com | 42 | Готово |',
    'Имя | Статус\r\n:--- | ---:\r\nИван | Готово',
    '| Имя |\n| --- |\n| Иван |',
    '| A \\| B | C |\n| --- | --- |\n| x | y |',
  ])('sends markdown as Telegram rich markdown: %s', async (text) => {
    const sendRichMessage = vi.fn(async (_chatId: string, _rich: unknown, _options?: unknown) => ({ message_id: 1, date: 1, chat: { id: -1001, type: 'supergroup' } }));
    const sendMessage = vi.fn();
    const bot = {
      api: {
        sendRichMessage,
        sendMessage,
      },
    } as unknown as Bot;

    await sendMarkdown(bot, '-1001', text, 42);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const args = sendRichMessage.mock.calls[0];
    expect(args[0]).toBe('-1001');
    expect(args[1]).toEqual({ markdown: text });
    expect(args[2]).toMatchObject({ message_thread_id: 42 });
  });

  it.each([
    'Ок, сделал.',
    'Выбери A | B',
    '| Имя | Статус |\n| Иван | Готово |',
    '| Имя | Статус |\n\n| --- | --- |',
    '| Имя | Статус |\n| --- |',
    '| Имя | Статус |\n| --- | текст |',
    '--- | ---',
    '\n| --- | --- |',
    '    | Имя | Статус |\n    | --- | --- |',
  ])('sends plain chat text without rich messages: %s', async (text) => {
    const sendRichMessage = vi.fn();
    const sendMessage = vi.fn(async (_chatId: string, _text: string, _options?: unknown) => ({ message_id: 4, date: 1, chat: { id: -1001, type: 'supergroup' } }));
    const bot = {
      api: {
        sendRichMessage,
        sendMessage,
      },
    } as unknown as Bot;

    await sendMarkdown(bot, '-1001', text, 42);

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toBe(text);
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ message_thread_id: 42 });
    expect(sendMessage.mock.calls[0][2]).not.toHaveProperty('parse_mode');
  });

  it('sends skill text payloads as rich markdown', async () => {
    const { store } = await tempStore();
    const sendRichMessage = vi.fn(async (_chatId: string, _rich: unknown, _options?: unknown) => ({ message_id: 8, date: 1, chat: { id: -1001, type: 'supergroup' } }));
    const sendMessage = vi.fn();
    const bot = {
      api: { sendRichMessage, sendMessage },
    } as unknown as Bot;

    await sendSkillResult(bot, store, '-1001', {
      ok: true,
      reply: 'Готово.',
      send: [{ kind: 'message', text: '**готово**' }],
    }, 42, 10);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendRichMessage.mock.calls[0][1]).toEqual({ markdown: '**готово**' });
    expect(sendRichMessage.mock.calls[0][2]).toMatchObject({ message_thread_id: 42 });
  });

  it('falls back to HTML when rich markdown is a bad request', async () => {
    const sendRichMessage = vi.fn(async () => {
      throw telegramBadRequest('can\'t parse markdown');
    });
    const sendMessage = vi.fn(async (_chatId: string, _text: string, _options?: unknown) => ({ message_id: 2, date: 1, chat: { id: -1001, type: 'supergroup' } }));
    const bot = {
      api: {
        sendRichMessage,
        sendMessage,
      },
    } as unknown as Bot;

    await sendMarkdown(bot, '-1001', '**важно**', 42);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const args = sendMessage.mock.calls[0];
    expect(args[1]).toContain('<b>важно</b>');
    expect(args[2]).toMatchObject({ parse_mode: 'HTML', message_thread_id: 42 });
  });

  it('does not fall back when rich markdown fails with a non-parse error', async () => {
    const sendRichMessage = vi.fn(async () => {
      throw telegramError(403, 'Forbidden: bot was kicked');
    });
    const sendMessage = vi.fn();
    const bot = {
      api: {
        sendRichMessage,
        sendMessage,
      },
    } as unknown as Bot;

    await expect(sendMarkdown(bot, '-1001', '**важно**')).rejects.toMatchObject({ error_code: 403 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to plain text when HTML sendMessage is a bad request', async () => {
    const sendRichMessage = vi.fn(async () => {
      throw telegramBadRequest('can\'t parse markdown');
    });
    let sendCount = 0;
    const sendMessage = vi.fn(async (_chatId: string, _text: string, _options?: unknown) => {
      sendCount += 1;
      if (sendCount === 1) throw telegramBadRequest('can\'t parse entities');
      return { message_id: 3, date: 1, chat: { id: -1001, type: 'supergroup' } };
    });
    const bot = {
      api: {
        sendRichMessage,
        sendMessage,
      },
    } as unknown as Bot;

    await sendMarkdown(bot, '-1001', '**важно**');

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const plainCall = sendMessage.mock.calls[1];
    expect(plainCall[1]).toBe('**важно**');
    expect(plainCall[2]).toMatchObject({ message_thread_id: undefined });
    expect(plainCall[2]).not.toHaveProperty('parse_mode');
  });
});
