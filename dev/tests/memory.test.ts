import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { buildChatContext } from '../../src/agent/context';
import { FileStore } from '../../src/memory/fileStore';
import { IdentityTooLongError, readIdentity, writeIdentity } from '../../src/memory/identity';
import { readChatSettings } from '../../src/memory/chatSettings';
import { readMood, smoothMood, defaultMood, writeMood } from '../../src/memory/moodDiary';
import { maybeUpdateMood } from '../../src/messaging/moodUpdate';
import { createTextArtifact, readArtifactText } from '../../src/memory/artifactStore';
import { saveSkill } from '../../src/skills/loader';
import { skillResultText } from '../../src/skills/result';
import { runSkill } from '../../src/skills/runtime';
import { ToolContext } from '../../src/tools/types';
import { createArtifactTool } from '../../src/tools/implementations/createArtifact';
import { readArtifactTool } from '../../src/tools/implementations/readArtifact';
import { createSendPayloadTool, sendPayloadTool } from '../../src/tools/implementations/sendPayload';
import { handleAgentCommand } from '../../src/messaging/commands';
import { TELEGRAM_CHAT_ID, tempStore, msg, skillSchema } from './helpers';

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
    const identityMessage = context.messages.find((message) => String(message.content).includes('дворецкий'));
    expect(identityMessage?.role).toBe('system');
    expect(String(identityMessage?.content)).toContain('не переписывается под настроение');
    expect(context.allocation.takes.identity).toBeGreaterThan(0);
  });

  it('rejects identity over configured limit', async () => {
    const { store } = await tempStore();
    await expect(writeIdentity(store, 'abcdef', 3)).rejects.toBeInstanceOf(IdentityTooLongError);
    expect(await readIdentity(store)).toBe('');
  });
});

describe('mood', () => {
  it('uses the current time when initializing settings and mood', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-agent-timestamps-'));
    const store = new FileStore(dir);
    const before = Date.now();
    const [settings, mood] = await Promise.all([readChatSettings(store), readMood(store)]);
    const after = Date.now();

    for (const value of [settings.updatedAt, mood.updatedAt]) {
      const timestamp = Date.parse(value);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    }
  });

  it('smooths signal into current values', () => {
    const next = smoothMood(defaultMood, { warmth: 1, tension: 1, humor: 0 }, 0.5);
    expect(next.warmth).toBeCloseTo(0.75);
    expect(next.tension).toBeCloseTo(0.55);
    expect(next.humor).toBeCloseTo(0.1);
  });

  it('updates mood from the model JSON assessment', async () => {
    const { store } = await tempStore();
    const current = await readMood(store);
    const chat = vi.fn(async (messages) => {
      expect(String(messages[0]?.content)).toContain('Return strict JSON only');
      expect(String(messages[1]?.content)).toContain('всё хорошо, спасибо');
      return '{"warmth":1,"tension":0.6,"humor":0.4}';
    });

    const next = await maybeUpdateMood(store, {
      chat,
      minimalCheck: async () => 'ok',
      toolCheck: async () => false,
    }, [{
      id: 1,
      chatId: TELEGRAM_CHAT_ID,
      text: 'всё хорошо, спасибо',
      date: new Date().toISOString(),
      isBot: false,
    }], 1);

    expect(chat).toHaveBeenCalledOnce();
    expect(next.warmth).toBeCloseTo(0.6);
    expect(next.tension).toBeCloseTo(0.2);
    expect(next.humor).toBeCloseTo(0.24);
  });

  it('keeps the previous mood when the model does not return valid JSON', async () => {
    const { store } = await tempStore();
    const current = { warmth: 0.7, tension: 0.3, humor: 0.4, updatedAt: new Date().toISOString() };
    await writeMood(store, current);

    const next = await maybeUpdateMood(store, {
      chat: async () => 'certainly!',
      minimalCheck: async () => 'ok',
      toolCheck: async () => false,
    }, [{
      id: 1,
      chatId: TELEGRAM_CHAT_ID,
      text: 'всё хорошо, спасибо',
      date: new Date().toISOString(),
      isBot: false,
    }], 1);

    expect(next).toEqual(current);
    expect(await readMood(store)).toEqual(current);
  });

  it('sends the full configured mood window to the model', async () => {
    const { store } = await tempStore();
    const messages = Array.from({ length: 51 }, (_, id) => ({
      id,
      chatId: TELEGRAM_CHAT_ID,
      text: `message-${id} ${'x'.repeat(500)}`,
      date: new Date().toISOString(),
      isBot: false,
    }));
    const chat = vi.fn(async (_messages: ChatCompletionMessageParam[]) => '{"warmth":0.5,"tension":0.1,"humor":0.2}');

    await maybeUpdateMood(store, {
      chat,
      minimalCheck: async () => 'ok',
      toolCheck: async () => false,
    }, messages, 51);

    const prompt = String(chat.mock.calls[0]?.[0][1]?.content);
    expect(prompt).toContain('message-0');
    expect(prompt).toContain('message-50');
    expect(prompt.split('\n').slice(1)).toHaveLength(51);
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

    const skill = skillSchema.parse({
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

    const skill = skillSchema.parse({
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
    const skill = skillSchema.parse({
      id: 'warn_skill',
      title: 'Warn Skill',
      enabled: false,
      trigger: { type: 'command', command: 'warn' },
      secrets: ['MY_SECRET'],
      action: { type: 'reply_static', text: 'hi' },
      createdAt: new Date().toISOString(),
    });
    await saveSkill(store, skill);

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
