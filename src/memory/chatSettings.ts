import { z } from 'zod';
import { FileStore } from './fileStore';

export const replyModeSchema = z.enum(['called', 'smart']);
export type ReplyMode = z.infer<typeof replyModeSchema>;
export const profanityModeSchema = z.enum(['normal', 'uncensored']);
export type ProfanityMode = z.infer<typeof profanityModeSchema>;
export const localeSchema = z.enum(['ru', 'en']);
export type PromptLocale = z.infer<typeof localeSchema>;

export const chatSettingsSchema = z.object({
  replyMode: replyModeSchema.default('called'),
  profanityMode: profanityModeSchema.default('normal'),
  locale: localeSchema.default('ru'),
  updatedAt: z.string(),
});

export type ChatSettings = z.output<typeof chatSettingsSchema>;

export const defaultChatSettings: ChatSettings = {
  replyMode: 'called',
  profanityMode: 'normal',
  locale: 'ru',
  updatedAt: new Date(0).toISOString(),
};

export async function readChatSettings(store: FileStore, defaultLocale: PromptLocale = 'ru'): Promise<ChatSettings> {
  const settings = await store.ensureJson(chatSettingsSchema, { ...defaultChatSettings, locale: defaultLocale }, 'chat', 'settings.json');
  if (settings.locale === defaultLocale || settings.locale !== 'ru' || defaultLocale === 'ru') return settings;

  // Settings files written before locale support parse as `ru` because of the schema default.
  // Upgrade that legacy value to the configured default on its first read.
  const raw = await store.readText('', 'chat', 'settings.json');
  if (!raw.includes('"locale"')) {
    const migrated = { ...settings, locale: defaultLocale, updatedAt: new Date().toISOString() };
    await store.writeJson(migrated, 'chat', 'settings.json');
    return migrated;
  }
  return settings;
}

export async function setReplyMode(store: FileStore, replyMode: ReplyMode): Promise<ChatSettings> {
  const current = await readChatSettings(store);
  const settings = { ...current, replyMode, updatedAt: new Date().toISOString() };
  await store.writeJson(settings, 'chat', 'settings.json');
  return settings;
}

export async function setProfanityMode(store: FileStore, profanityMode: ProfanityMode): Promise<ChatSettings> {
  const current = await readChatSettings(store);
  const settings = { ...current, profanityMode, updatedAt: new Date().toISOString() };
  await store.writeJson(settings, 'chat', 'settings.json');
  return settings;
}

export async function setLocale(store: FileStore, locale: PromptLocale): Promise<ChatSettings> {
  const current = await readChatSettings(store);
  const settings = { ...current, locale, updatedAt: new Date().toISOString() };
  await store.writeJson(settings, 'chat', 'settings.json');
  return settings;
}

export function isCensorModeEnabled(settings: Pick<ChatSettings, 'profanityMode'>): boolean {
  return settings.profanityMode !== 'uncensored';
}

export async function setCensorMode(store: FileStore, enabled: boolean): Promise<ChatSettings> {
  return setProfanityMode(store, enabled ? 'normal' : 'uncensored');
}
