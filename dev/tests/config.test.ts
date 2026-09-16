import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig } from '../../src/config';
import { nativeChatId, providerChatId } from '../../src/messaging/chatAddress';
import { TELEGRAM_CHAT_ID, testConfig } from './helpers';

describe('chat addresses', () => {
  it('restores a native provider chat ID for provider API calls', () => {
    expect(nativeChatId('telegram', TELEGRAM_CHAT_ID)).toBe('-1001');
  });

  it('rejects an ID from another provider', () => {
    expect(() => nativeChatId('telegram', providerChatId('discord', '42'))).toThrow('does not belong to telegram');
  });
});

describe('config', () => {
  it('uses Russian as the default locale and accepts an English override', () => {
    const base = {
      TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI',
      TELEGRAM_ALLOWED_CHAT_ID: '-1001',
      LLM_API_KEY: 'sk-test',
      LLM_MODEL: 'test-model',
    };
    expect(loadConfig(base).defaultLocale).toBe('ru');
    expect(loadConfig({ ...base, AGENT_DEFAULT_LOCALE: 'en' }).defaultLocale).toBe('en');
  });

  it('limits Telegram send payload items to the Telegram maximum', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-agent-config-'));
    const config = testConfig(dir);
    expect(config.telegramSendMaxItems).toBe(10);
    expect(config.chatAllowedIds).toEqual([TELEGRAM_CHAT_ID]);
    const httpConfig = loadConfig({
      TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI',
      TELEGRAM_ALLOWED_CHAT_ID: '-1001',
      LLM_API_KEY: 'sk-test',
      LLM_MODEL: 'test-model',
      AGENT_DATA_DIR: dir,
      HTTP_BLOCKED_HOSTS: 'api.example.com, Staging.example.com',
      HTTP_ALLOWED_PRIVATE_HOSTS: 'localhost, api.internal',
    });
    expect(httpConfig.httpBlockedHosts).toEqual(['api.example.com', 'Staging.example.com']);
    expect(httpConfig.httpAllowedPrivateHosts).toEqual(['localhost', 'api.internal']);
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
