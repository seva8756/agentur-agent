import { FileStore } from './fileStore';

const identityPath = ['chat', 'identity.md'];

export async function readIdentity(store: FileStore): Promise<string> {
  return store.readText('', ...identityPath);
}

export async function writeIdentity(store: FileStore, text: string, maxChars: number): Promise<string> {
  const normalized = normalizeIdentity(text, maxChars);
  await store.writeText(normalized, ...identityPath);
  return normalized;
}

export async function resetIdentity(store: FileStore): Promise<void> {
  await store.writeText('', ...identityPath);
}

export function normalizeIdentity(text: string, maxChars: number): string {
  return text.replace(/\r\n/g, '\n').trim().slice(0, maxChars).trim();
}
