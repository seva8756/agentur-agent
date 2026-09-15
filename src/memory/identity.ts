import { FileStore } from './fileStore';

export const IDENTITY_MAX_CHARS = 20000;
const identityPath = ['chat', 'identity.md'];

export class IdentityTooLongError extends Error {
  constructor(
    readonly length: number,
    readonly maxChars: number,
  ) {
    super(`Identity is too long: ${length} > ${maxChars}`);
  }
}

export async function readIdentity(store: FileStore): Promise<string> {
  return store.readText('', ...identityPath);
}

export async function writeIdentity(store: FileStore, text: string, maxChars: number = IDENTITY_MAX_CHARS): Promise<string> {
  const normalized = normalizeIdentity(text);
  if (normalized.length > maxChars) throw new IdentityTooLongError(normalized.length, maxChars);
  await store.writeText(normalized, ...identityPath);
  return normalized;
}

export async function resetIdentity(store: FileStore): Promise<void> {
  await store.writeText('', ...identityPath);
}

export function normalizeIdentity(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}
