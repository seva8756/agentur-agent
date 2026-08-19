import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { LlmAdapter } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { readMood } from '../memory/moodDiary';
import { formatRecentMessageForContext, readRecentMessages, selectRecentForContext } from '../memory/recentMessages';
import { buildSmartReplySystemPrompt, buildSmartReplyUserPrompt } from '../prompts/catalog';
import { ChatMessage } from '../telegram/telegramTypes';
import { logger } from '../utils/logger';

const SMART_REPLY_RECENT_MESSAGE_MAX_CHARS = 500;

export type SmartDecision = {
  shouldReply: boolean;
  reason: string;
};

export async function decideSmartReply(
  store: FileStore,
  message: ChatMessage,
  llm: LlmAdapter,
): Promise<SmartDecision> {
  if (message.text.trim().length < 8) return { shouldReply: false, reason: 'too_short' };

  const mood = await readMood(store);
  const recent = selectRecentForContext(await readRecentMessages(store), 12)
    .map((item) => formatRecentMessageForContext(item, SMART_REPLY_RECENT_MESSAGE_MAX_CHARS))
    .join('\n');
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: buildSmartReplySystemPrompt(mood),
    },
    { role: 'user', content: buildSmartReplyUserPrompt(recent, message.text) },
  ];

  try {
    const raw = await llm.chat(messages);
    const parsed = parseSmartJson(raw);
    return { shouldReply: parsed.reply, reason: parsed.reason || 'smart_classifier' };
  } catch (error) {
    logger.warn('Smart reply classifier failed', error);
    return { shouldReply: false, reason: 'classifier_error' };
  }
}

function parseSmartJson(raw: string): { reply: boolean; reason: string } {
  const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
  const parsed = JSON.parse(json) as { reply?: unknown; reason?: unknown };
  return { reply: parsed.reply === true, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
}
