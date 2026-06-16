import { z } from 'zod';
import { artifactFilenameSchema, artifactIdSchema } from '../memory/artifactStore';

export const SKILL_REPLY_MAX_CHARS = 8192;
export const SKILL_MEDIA_CAPTION_MAX_CHARS = 1024;
export const SKILL_MEDIA_FILENAME_MAX_CHARS = 120;

const safeHttpUrlSchema = z.string().url().refine(isSafePublicHttpUrl, 'URL must be public http/https');
const captionSchema = z.string().max(SKILL_MEDIA_CAPTION_MAX_CHARS);
const filenameSchema = artifactFilenameSchema.max(SKILL_MEDIA_FILENAME_MAX_CHARS).optional();

const sendSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), url: safeHttpUrlSchema }),
  z.object({ type: z.literal('artifact'), artifactId: artifactIdSchema }),
]);

const mediaSendBaseSchema = z.object({
  url: safeHttpUrlSchema.optional(),
  source: sendSourceSchema.optional(),
  caption: captionSchema.optional(),
  filename: filenameSchema,
});

function mediaSendSchema<TKind extends 'photo' | 'file' | 'video'>(kind: TKind) {
  return z.object({ kind: z.literal(kind) })
    .merge(mediaSendBaseSchema)
    .refine((value) => Boolean(value.url || value.source), 'media send requires url or source');
}

export const skillSendSchema = z.union([
  z.object({
    kind: z.literal('message'),
    text: z.string().max(SKILL_REPLY_MAX_CHARS).optional(),
    caption: captionSchema.optional(),
  }),
  mediaSendSchema('photo'),
  mediaSendSchema('file'),
  mediaSendSchema('video'),
]);

export const skillRunResultSchema = z.object({
  ok: z.boolean().default(true),
  reply: z.string().max(SKILL_REPLY_MAX_CHARS).nullable().optional(),
  data: z.unknown().optional(),
  send: skillSendSchema.optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).optional(),
});

export type SkillRunResult = z.output<typeof skillRunResultSchema>;

export function normalizeSkillRunResultInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if ('error' in record && record.error !== undefined) {
    record.error = normalizeSkillError(record.error);
    if (record.ok === undefined) record.ok = false;
  }
  return record;
}

export function textSkillResult(reply: string | null | undefined): SkillRunResult | null {
  const trimmed = reply?.trim();
  return trimmed ? { ok: true, reply: trimmed } : null;
}

export function hasSkillOutput(result: SkillRunResult | null | undefined): result is SkillRunResult {
  return Boolean(result && (result.reply?.trim() || result.send));
}

export function skillResultText(result: SkillRunResult | null | undefined): string | null {
  if (!result) return null;
  const reply = result.reply?.trim();
  if (reply) return reply;
  if (!result.send) return null;
  if (result.send.kind === 'message') return result.send.text?.trim() || result.send.caption?.trim() || null;
  return result.send.caption?.trim() || result.send.url || artifactText(result.send.source);
}

function artifactText(source: z.output<typeof sendSourceSchema> | undefined): string | null {
  if (!source) return null;
  if (source.type === 'url') return source.url;
  return source.artifactId;
}

function isSafePublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost'
      || host.endsWith('.localhost')
      || host === '0.0.0.0'
      || host === '::1'
      || host.startsWith('127.')
      || host.startsWith('10.')
      || host.startsWith('192.168.')
      || host.startsWith('169.254.')
      || isPrivate172Host(host)
      || host.startsWith('fc')
      || host.startsWith('fd')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isPrivate172Host(host: string): boolean {
  const match = host.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function normalizeSkillError(error: unknown): { code: string; message: string } {
  if (typeof error === 'string') return { code: 'skill_error', message: error };
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === 'string' && record.message.trim()
      ? record.message.trim()
      : JSON.stringify(error);
    const code = typeof record.code === 'string' && record.code.trim()
      ? record.code.trim()
      : 'skill_error';
    return { code, message };
  }
  return { code: 'skill_error', message: String(error) };
}
