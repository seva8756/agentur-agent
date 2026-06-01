import fs from 'node:fs/promises';
import { Bot } from 'grammy';
import { AppConfig } from '../config';
import { LlmAdapter } from './types';
import { formatLocalTime } from '../utils/time';

export async function runDoctor(config: AppConfig, llm: LlmAdapter): Promise<string[]> {
  const results: string[] = ['config: ok'];
  await fs.access(config.agentDataDir, fs.constants.W_OK);
  results.push('data dir: writable');
  results.push(`timezone: ${config.agentTimezone} (${formatLocalTime(config.agentTimezone)})`);
  const bot = new Bot(config.telegramBotToken);
  const me = await bot.api.getMe();
  results.push(`telegram: ok (@${me.username})`);
  const answer = await llm.minimalCheck();
  results.push(`llm: ok (${answer.trim().slice(0, 20) || 'empty response'})`);
  if (config.llmSupportsTools) {
    results.push(`llm tools: ${(await llm.toolCheck()) ? 'ok' : 'not returned by endpoint'}`);
  } else {
    results.push('llm tools: disabled by config');
  }
  return results;
}
