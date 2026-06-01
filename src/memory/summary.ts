import { FileStore } from './fileStore';

export async function readSummary(store: FileStore): Promise<string> {
  return store.readText('', 'chat', 'summary.md');
}

export async function updateSummary(store: FileStore, text: string, maxChars: number): Promise<void> {
  await store.writeText(text.slice(-maxChars), 'chat', 'summary.md');
}
