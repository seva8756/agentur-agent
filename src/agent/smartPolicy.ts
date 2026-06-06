import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { LlmAdapter } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { readMood } from '../memory/moodDiary';
import { DEFAULT_RECENT_MESSAGE_CONTEXT_MAX_CHARS, formatRecentMessageForContext, readRecentMessages, selectRecentForContext } from '../memory/recentMessages';
import { ChatMessage } from '../telegram/telegramTypes';
import { logger } from '../utils/logger';

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
    .map((item) => formatRecentMessageForContext(item, DEFAULT_RECENT_MESSAGE_CONTEXT_MAX_CHARS))
    .join('\n');
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: [
        'Decide whether a Telegram group assistant should proactively join the conversation.',
        'Return strict JSON only: {"reply": boolean, "reason": string}.',
        'Reply true only when the assistant can clearly help: direct unresolved question, request for planning, confusion, bug, summary needed, decision support, or useful reminder.',
        'Reply false for casual banter, greetings, short acknowledgements, private jokes, emotional reactions, or when humans are already handling it.',
        `Current mood: warmth=${mood.warmth.toFixed(2)}, tension=${mood.tension.toFixed(2)}, humor=${mood.humor.toFixed(2)}.`,
        'If tension is high, be more conservative unless the assistant can reduce confusion, summarize, or de-escalate.',
        'If warmth/humor are high and tension is low, a slightly more proactive helpful reply is acceptable, but only when useful.',
        'Be conservative: silence is usually better.',
      ].join(' '),
    },
    { role: 'user', content: `Recent chat:\n${recent}\n\nCurrent message:\n${message.text}` },
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
