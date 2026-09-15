import { z } from 'zod';
import { FileStore } from './fileStore';

export const recentAttachmentSchema = z.object({
  kind: z.enum(['file', 'photo', 'video']),
  attachmentId: z.string().optional(),
  artifactId: z.string().optional(),
  url: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const recentMessageSchema = z.object({
  id: z.number(),
  chatId: z.string(),
  threadId: z.number().int().positive().optional(),
  userId: z.string().optional(),
  username: z.string().optional(),
  displayName: z.string().optional(),
  text: z.string(),
  date: z.string(),
  isBot: z.boolean().default(false),
  attachments: z.array(recentAttachmentSchema).optional(),
});

export type RecentAttachment = z.output<typeof recentAttachmentSchema>;

export type RecentMessage = {
  id: number;
  chatId: string;
  threadId?: number;
  userId?: string;
  username?: string;
  displayName?: string;
  text: string;
  date: string;
  isBot: boolean;
  attachments?: RecentAttachment[];
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
  summaryFileMaxChars: number,
): Promise<void> {
  const messages = await readRecentMessages(store);
  if (messages.length <= fileLimit) return;
  const overflowCount = Math.min(messages.length - fileLimit + summarizeCount, messages.length);
  const archived = messages.slice(0, overflowCount);
  const kept = messages.slice(overflowCount);
  const existing = await store.readText('', 'chat', 'summary.md');
  const archiveText = archived.map((m) => formatRecentMessageForContext(m)).join('\n');
  const updated = `${existing.trim()}\n\nАрхив контекста ${new Date().toISOString()}:\n${archiveText}`
    .trim()
    .slice(-summaryFileMaxChars);
  await store.writeText(updated, 'chat', 'summary.md');
  await store.writeText(kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length ? '\n' : ''), 'chat', 'recent.jsonl');
}

export async function clearRecentMessages(store: FileStore): Promise<void> {
  await store.writeText('', 'chat', 'recent.jsonl');
}

export function selectRecentForContext(messages: RecentMessage[], limit: number): RecentMessage[] {
  return messages.slice(-limit);
}

export function formatRecentMessageForContext(
  message: RecentMessage,
  maxTextChars = 500,
): string {
  const thread = message.threadId ? `[thread=${message.threadId}] ` : '';
  const text = limitRecentText(message.text, maxTextChars);
  const attachments = formatAttachmentsForContext(message.attachments);
  const body = [text, attachments].filter(Boolean).join('\n');
  return `${thread}${formatMessageAuthor(message)}: ${body}`;
}

export function formatMessageAuthor(message: Pick<RecentMessage, 'displayName' | 'username' | 'userId'>): string {
  const username = message.username ? `@${message.username.replace(/^@/, '')}` : '';
  if (message.displayName && username && message.displayName !== message.username) return `${message.displayName} (${username})`;
  return message.displayName ?? username ?? message.userId ?? 'user';
}

function limitRecentText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}... [truncated]`;
}

function formatAttachmentsForContext(attachments: RecentAttachment[] | undefined): string {
  if (!attachments?.length) return '';
  return attachments.map((attachment) => {
    const parts = [
      attachment.kind,
      attachment.filename ? `filename=${attachment.filename}` : undefined,
      attachment.artifactId ? `artifact=${attachment.artifactId}` : undefined,
      attachment.url ? `url=${attachment.url}` : undefined,
      attachment.mimeType ? `mime=${attachment.mimeType}` : undefined,
      attachment.sizeBytes !== undefined ? `size=${attachment.sizeBytes}` : undefined,
    ].filter(Boolean);
    return `[attachment: ${parts.join(' ')}]`;
  }).join('\n');
}
