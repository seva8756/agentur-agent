import { z } from 'zod';
import { FileStore } from './fileStore';

export const replyModeSchema = z.enum(['called', 'smart']);
export type ReplyMode = z.infer<typeof replyModeSchema>;
export const profanityModeSchema = z.enum(['normal', 'uncensored']);
export type ProfanityMode = z.infer<typeof profanityModeSchema>;

export const chatSettingsSchema = z.object({
  replyMode: replyModeSchema.default('called'),
  profanityMode: profanityModeSchema.default('normal'),
  updatedAt: z.string(),
});

export type ChatSettings = z.output<typeof chatSettingsSchema>;

export const defaultChatSettings: ChatSettings = {
  replyMode: 'called',
  profanityMode: 'normal',
  updatedAt: new Date(0).toISOString(),
};

export async function readChatSettings(store: FileStore): Promise<ChatSettings> {
  return store.ensureJson(chatSettingsSchema, defaultChatSettings, 'chat', 'settings.json');
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

export function isCensorModeEnabled(settings: Pick<ChatSettings, 'profanityMode'>): boolean {
  return settings.profanityMode !== 'uncensored';
}

export async function setCensorMode(store: FileStore, enabled: boolean): Promise<ChatSettings> {
  return setProfanityMode(store, enabled ? 'normal' : 'uncensored');
}
