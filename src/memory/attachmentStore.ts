import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { ChatMessageAttachment } from '../messaging/types';
import { FileStore } from './fileStore';
import type { RecentAttachment } from './recentMessages';

export const ATTACHMENT_EXTRACT_MAX_CHARS = 60_000;

const attachmentIdSchema = z.string().regex(/^att_[a-f0-9]{16,64}$/);
const attachmentMetaSchema = z.object({
  id: attachmentIdSchema,
  messageId: z.number().int(),
  filename: z.string().optional(),
  kind: z.enum(['file', 'photo', 'video']),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  extractedText: z.boolean(),
  truncated: z.boolean(),
  originalStored: z.boolean(),
});

export type StoredAttachmentMeta = z.output<typeof attachmentMetaSchema>;

export async function persistIncomingAttachments(
  store: FileStore,
  message: { messageId: number; date: Date; attachments?: ChatMessageAttachment[] },
): Promise<RecentAttachment[] | undefined> {
  if (!message.attachments?.length) return undefined;
  const attachments: RecentAttachment[] = [];
  for (const [index, attachment] of message.attachments.entries()) {
    const id = attachmentId(message.messageId, index, attachment);
    const text = attachment.extractedText?.slice(0, ATTACHMENT_EXTRACT_MAX_CHARS);
    const meta: StoredAttachmentMeta = {
      id,
      messageId: message.messageId,
      filename: attachment.filename,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      createdAt: message.date.toISOString(),
      extractedText: text !== undefined,
      truncated: Boolean(attachment.extractedTextTruncated || (attachment.extractedText?.length ?? 0) > ATTACHMENT_EXTRACT_MAX_CHARS),
      originalStored: attachment.originalBytes !== undefined,
    };
    await store.writeJson(meta, 'attachments', id, 'meta.json');
    if (attachment.originalBytes !== undefined) {
      await fs.writeFile(store.resolve('attachments', id, 'original'), attachment.originalBytes);
    }
    if (text !== undefined) await store.writeText(text, 'attachments', id, 'content.txt');
    attachments.push({
      attachmentId: id,
      kind: attachment.kind,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  }
  return attachments;
}

export async function listStoredAttachmentFiles(store: FileStore): Promise<Array<{ path: string; text: string }>> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(store.resolve('attachments'), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ path: string; text: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(store.resolve('attachments', entry.name, 'meta.json'), 'utf8');
      const meta = attachmentMetaSchema.parse(JSON.parse(raw));
      const name = safePathSegment(meta.filename ?? `${meta.kind}-${meta.messageId}`);
      const basePath = `/chat/attachments/${name}--${meta.id.slice(-8)}`;
      files.push({
        path: `${basePath}/meta.txt`,
        text: [
          `[attachment id=${meta.id}]`,
          `message_id: ${meta.messageId}`,
          `kind: ${meta.kind}`,
          meta.filename ? `filename: ${meta.filename}` : undefined,
          meta.mimeType ? `mime: ${meta.mimeType}` : undefined,
          meta.sizeBytes !== undefined ? `size_bytes: ${meta.sizeBytes}` : undefined,
          `extracted_text: ${meta.extractedText ? 'available' : 'unavailable'}`,
          `original_file: ${meta.originalStored ? 'stored' : 'unavailable'}`,
          `truncated: ${meta.truncated}`,
        ].filter(Boolean).join('\n'),
      });
      if (meta.extractedText) {
        files.push({
          path: `${basePath}/content.txt`,
          text: await fs.readFile(store.resolve('attachments', entry.name, 'content.txt'), 'utf8'),
        });
      }
    } catch {
      // Keep retrieval available when an old or partially written attachment is malformed.
    }
  }
  return files;
}

function attachmentId(messageId: number, index: number, attachment: ChatMessageAttachment): string {
  const identity = [messageId, index, attachment.kind, attachment.filename ?? '', attachment.mimeType ?? '', attachment.sizeBytes ?? ''].join(':');
  return `att_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function safePathSegment(value: string): string {
  const compact = value.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return compact || 'unnamed';
}
