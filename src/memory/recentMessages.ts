import { z } from 'zod';
import { FileStore } from './fileStore';

export const recentMessageSchema = z.object({
  id: z.number(),
  chatId: z.string(),
  userId: z.string().optional(),
  username: z.string().optional(),
  displayName: z.string().optional(),
  text: z.string(),
  date: z.string(),
  isBot: z.boolean().default(false),
});

export type RecentMessage = {
  id: number;
  chatId: string;
  userId?: string;
  username?: string;
  displayName?: string;
  text: string;
  date: string;
  isBot: boolean;
};

export async function appendRecentMessage(store: FileStore, message: RecentMessage): Promise<void> {
  await store.appendJsonl(message, 'chat', 'recent.jsonl');
}

export async function readRecentMessages(store: FileStore): Promise<RecentMessage[]> {
  return store.readJsonl(recentMessageSchema, 'chat', 'recent.jsonl');
}

export async function trimRecentMessages(
  store: FileStore,
  fileLimit: number,
  summarizeCount: number,
  summaryMaxChars: number,
): Promise<void> {
  const messages = await readRecentMessages(store);
  if (messages.length <= fileLimit) return;
  const overflowCount = Math.min(messages.length - fileLimit + summarizeCount, messages.length);
  const archived = messages.slice(0, overflowCount);
  const kept = messages.slice(overflowCount);
  const existing = await store.readText('', 'chat', 'summary.md');
  const archiveText = archived.map((m) => `${formatMessageAuthor(m)}: ${m.text}`).join('\n');
  const updated = `${existing.trim()}\n\nАрхив контекста ${new Date().toISOString()}:\n${archiveText}`
    .trim()
    .slice(-summaryMaxChars);
  await store.writeText(updated, 'chat', 'summary.md');
  await store.writeText(kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length ? '\n' : ''), 'chat', 'recent.jsonl');
}

export async function clearRecentMessages(store: FileStore): Promise<void> {
  await store.writeText('', 'chat', 'recent.jsonl');
}

export function selectRecentForContext(messages: RecentMessage[], limit: number): RecentMessage[] {
  return messages.slice(-limit);
}

export function formatMessageAuthor(message: Pick<RecentMessage, 'displayName' | 'username' | 'userId'>): string {
  const username = message.username ? `@${message.username.replace(/^@/, '')}` : '';
  if (message.displayName && username && message.displayName !== message.username) return `${message.displayName} (${username})`;
  return message.displayName ?? username ?? message.userId ?? 'user';
}
