import fs from 'node:fs/promises';
import path from 'node:path';
import type { PromptLocale } from '../memory/chatSettings';

const docsRoot = path.resolve(process.cwd(), 'src', 'prompts', 'docs');
const docs: Record<PromptLocale, Promise<string>> = {
  ru: fs.readFile(path.join(docsRoot, 'ru', 'agent-capabilities.md'), 'utf8'),
  en: fs.readFile(path.join(docsRoot, 'en', 'agent-capabilities.md'), 'utf8'),
};

export async function agentCapabilitiesDoc(locale: PromptLocale): Promise<string> {
  return docs[locale];
}
