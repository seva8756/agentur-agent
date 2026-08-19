import { ChatMessage } from '../telegram/telegramTypes';

export type ReplyDecision = {
  shouldReply: boolean;
  reason: 'mention' | 'reply_to_bot' | 'agent_command' | 'private_chat' | 'skill' | 'cron' | 'silent';
};

export function decideReply(message: ChatMessage, botUsername: string, skillMatched = false): ReplyDecision {
  const text = message.text.trim();
  const normalized = text.toLowerCase();
  const username = botUsername.toLowerCase().replace(/^@/, '');
  if (skillMatched) return { shouldReply: true, reason: 'skill' };
  if (message.replyToBot) return { shouldReply: true, reason: 'reply_to_bot' };
  if (/^\/agentur(?:@\w+)?(?:\s|$)/i.test(normalized)) return { shouldReply: true, reason: 'agent_command' };
  if (message.chatType === 'private') return { shouldReply: true, reason: 'private_chat' };
  if (new RegExp(`@${escapeRegExp(username)}(?![\\w])`).test(normalized)) return { shouldReply: true, reason: 'mention' };
  return { shouldReply: false, reason: 'silent' };
}

export function stripBotAddress(text: string, botUsername: string): string {
  return text
    .replace(new RegExp(`@${botUsername.replace(/^@/, '')}`, 'gi'), '')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
