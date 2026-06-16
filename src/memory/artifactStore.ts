import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FileStore } from './fileStore';

export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_READ_TEXT_MAX_BYTES = 3 * 1024 * 1024;

export const artifactIdSchema = z.string().regex(/^art_[a-zA-Z0-9_-]{12,80}$/);
export const artifactFilenameSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[^/\\\0]+$/);
export const artifactMimeTypeSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i);

export const artifactMetaSchema = z.object({
  id: artifactIdSchema,
  filename: artifactFilenameSchema,
  mimeType: artifactMimeTypeSchema,
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
  createdBy: z.object({
    kind: z.enum(['agent', 'skill', 'system']),
    id: z.string().min(1).max(120).optional(),
  }),
});

export type ArtifactMeta = z.output<typeof artifactMetaSchema>;

export async function createTextArtifact(
  store: FileStore,
  input: { filename: string; mimeType: string; text: string },
  createdBy: ArtifactMeta['createdBy'],
): Promise<ArtifactMeta> {
  const bytes = Buffer.from(input.text, 'utf8');
  return writeArtifact(store, {
    filename: input.filename,
    mimeType: input.mimeType,
    bytes,
    createdBy,
  });
}

export async function createBase64Artifact(
  store: FileStore,
  input: { filename: string; mimeType: string; base64: string },
  createdBy: ArtifactMeta['createdBy'],
): Promise<ArtifactMeta> {
  const cleanBase64 = input.base64.includes(',')
    ? input.base64.slice(input.base64.indexOf(',') + 1)
    : input.base64;
  const normalized = cleanBase64.replace(/\s/g, '');
  if (normalized && !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error('invalid base64 artifact body');
  if (normalized.length % 4 === 1) throw new Error('invalid base64 artifact body');
  const bytes = Buffer.from(normalized, 'base64');
  return writeArtifact(store, {
    filename: input.filename,
    mimeType: input.mimeType,
    bytes,
    createdBy,
  });
}

export async function readArtifactMeta(store: FileStore, artifactId: string): Promise<ArtifactMeta> {
  const id = artifactIdSchema.parse(artifactId);
  const raw = await fs.readFile(store.resolve('artifacts', id, 'meta.json'), 'utf8');
  return artifactMetaSchema.parse(JSON.parse(raw));
}

export async function readArtifactText(
  store: FileStore,
  artifactId: string,
  maxBytes = ARTIFACT_READ_TEXT_MAX_BYTES,
): Promise<{ meta: ArtifactMeta; text: string; truncated: boolean }> {
  const meta = await readArtifactMeta(store, artifactId);
  if (!isTextArtifact(meta.mimeType)) throw new Error(`artifact is not text-readable: ${meta.mimeType}`);
  const file = artifactContentPath(store, meta.id);
  const handle = await fs.open(file, 'r');
  try {
    const budget = Math.max(0, maxBytes);
    const buffer = Buffer.alloc(Math.min(meta.size, budget + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > budget || meta.size > budget;
    const slice = buffer.subarray(0, Math.min(bytesRead, budget));
    return { meta, text: slice.toString('utf8'), truncated };
  } finally {
    await handle.close();
  }
}

export function artifactContentPath(store: FileStore, artifactId: string): string {
  const id = artifactIdSchema.parse(artifactId);
  return store.resolve('artifacts', id, 'content');
}

export function isTextArtifact(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType === 'application/xml'
    || mimeType === 'application/javascript'
    || mimeType === 'application/typescript'
    || mimeType.endsWith('+json')
    || mimeType.endsWith('+xml')
  );
}

async function writeArtifact(
  store: FileStore,
  input: { filename: string; mimeType: string; bytes: Buffer; createdBy: ArtifactMeta['createdBy'] },
): Promise<ArtifactMeta> {
  const filename = artifactFilenameSchema.parse(input.filename);
  const mimeType = artifactMimeTypeSchema.parse(input.mimeType);
  if (input.bytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw new Error(`artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`);
  }

  const id = `art_${crypto.randomUUID().replace(/-/g, '')}`;
  const meta: ArtifactMeta = {
    id,
    filename,
    mimeType,
    size: input.bytes.byteLength,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };
  const dir = store.resolve('artifacts', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'content'), input.bytes);
  await store.writeJson(meta, 'artifacts', id, 'meta.json');
  return meta;
}
