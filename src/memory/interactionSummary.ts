import { z } from 'zod';
import { FileStore } from './fileStore';
import { analyzeMoodSignal, readMood, smoothMood, writeMood } from './moodDiary';
import { clearRecentMessages, formatMessageAuthor, formatRecentMessageForContext, RecentMessage } from './recentMessages';

export const interactionSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  userMessageCount: z.number().int().nonnegative(),
  botMessageCount: z.number().int().nonnegative(),
  mood: z.object({ warmth: z.number(), tension: z.number(), humor: z.number() }),
  summary: z.string(),
});

export type InteractionSummary = z.infer<typeof interactionSummarySchema>;

export async function summarizeAndResetInteractions(
  store: FileStore,
  messages: RecentMessage[],
  summaryFileMaxChars: number,
): Promise<InteractionSummary | null> {
  if (messages.length === 0) return null;

  const userMessages = messages.filter((message) => !message.isBot);
  const botMessages = messages.filter((message) => message.isBot);
  const signal = analyzeMoodSignal(messages.map((message) => message.text));
  const currentMood = await readMood(store);
  const mood = smoothMood(currentMood, signal, 0.25);
  await writeMood(store, mood);

  const summary = buildInteractionSummary(messages, signal);
  const createdAt = new Date().toISOString();
  const record: InteractionSummary = {
    id: `interaction_summary_${Date.now()}`,
    createdAt,
    messageCount: messages.length,
    userMessageCount: userMessages.length,
    botMessageCount: botMessages.length,
    mood: signal,
    summary,
  };

  await store.appendJsonl(record, 'chat', 'interaction-summaries.jsonl');
  const existing = await store.readText('', 'chat', 'summary.md');
  const updated = `${existing.trim()}\n\nInteraction summary ${createdAt}:\n${summary}`.trim().slice(-summaryFileMaxChars);
  await store.writeText(updated, 'chat', 'summary.md');
  await clearRecentMessages(store);
  return record;
}

function buildInteractionSummary(messages: RecentMessage[], mood: { warmth: number; tension: number; humor: number }): string {
  const users = [...new Set(messages.filter((m) => !m.isBot).map((m) => formatMessageAuthor(m)))]
    .slice(0, 8)
    .join(', ');
  const topics = extractKeywords(messages.map((message) => message.text)).slice(0, 10).join(', ') || 'no explicit topics';
  const lastUserMessages = messages
    .filter((m) => !m.isBot)
    .slice(-5)
    .map((m) => `${formatMessageAuthor(m)}: ${m.text}`)
    .join(' | ');
  const attachmentMessages = messages
    .filter((m) => m.attachments?.length)
    .slice(-5)
    .map((m) => formatRecentMessageForContext(m, 160))
    .join(' | ');
  return [
    `Messages: ${messages.length}; participants: ${users || 'none'}.`,
    `Topics/keywords: ${topics}.`,
    `Mood: warmth=${mood.warmth.toFixed(2)}, tension=${mood.tension.toFixed(2)}, humor=${mood.humor.toFixed(2)}.`,
    lastUserMessages ? `Recent requests: ${lastUserMessages}` : '',
    attachmentMessages ? `Attachments: ${attachmentMessages}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractKeywords(texts: string[]): string[] {
  const stop = new Set([
    'что',
    'это',
    'как',
    'для',
    'или',
    'если',
    'тебя',
    'меня',
    'тут',
    'там',
    'the',
    'and',
    'you',
    'with',
  ]);
  const counts = new Map<string, number>();
  for (const token of texts.join(' ').toLowerCase().match(/[a-zа-яё0-9_-]{4,}/gi) ?? []) {
    if (stop.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
}
