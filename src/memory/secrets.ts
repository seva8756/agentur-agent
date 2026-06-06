import { z } from 'zod';
import { FileStore } from './fileStore';

export const secretsSchema = z.record(z.string());
export type Secrets = z.infer<typeof secretsSchema>;

export async function readSecrets(store: FileStore): Promise<Record<string, string>> {
  return store.readJson(secretsSchema, {}, 'chat', 'secrets.json');
}

export async function setSecret(store: FileStore, key: string, value: string): Promise<Record<string, string>> {
  const current = await readSecrets(store);
  const updated = { ...current, [key]: value };
  await store.writeJson(updated, 'chat', 'secrets.json');
  return updated;
}

export async function deleteSecret(store: FileStore, key: string): Promise<boolean> {
  const current = await readSecrets(store);
  if (!(key in current)) return false;
  const { [key]: _, ...updated } = current;
  await store.writeJson(updated, 'chat', 'secrets.json');
  return true;
}
