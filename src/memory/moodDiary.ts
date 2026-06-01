import { z } from 'zod';
import { FileStore } from './fileStore';

export const moodSchema = z.object({
  warmth: z.number().min(0).max(1),
  tension: z.number().min(0).max(1),
  humor: z.number().min(0).max(1),
  updatedAt: z.string(),
});
export type Mood = z.infer<typeof moodSchema>;

export const defaultMood: Mood = {
  warmth: 0.5,
  tension: 0.1,
  humor: 0.2,
  updatedAt: new Date(0).toISOString(),
};

export function smoothMood(current: Mood, signal: Omit<Mood, 'updatedAt'>, alpha = 0.2): Mood {
  const mix = (a: number, b: number) => Math.max(0, Math.min(1, a * (1 - alpha) + b * alpha));
  return {
    warmth: mix(current.warmth, signal.warmth),
    tension: mix(current.tension, signal.tension),
    humor: mix(current.humor, signal.humor),
    updatedAt: new Date().toISOString(),
  };
}

export function analyzeMoodSignal(texts: string[]): Omit<Mood, 'updatedAt'> {
  const text = texts.join(' ').toLowerCase();
  const tension = /\b(срочно|плохо|ужас|бесит|проблем|ошибка|сломал|fuck|shit)\b/i.test(text) ? 0.65 : 0.15;
  const humor = /(ха|lol|ахах|шут|😂|😄)/i.test(text) ? 0.6 : 0.2;
  const warmth = /(спасибо|пожалуйста|класс|отлично|люблю|thanks)/i.test(text) ? 0.7 : tension > 0.5 ? 0.3 : 0.5;
  return { warmth, tension, humor };
}

export async function readMood(store: FileStore): Promise<Mood> {
  return store.readJson(moodSchema, defaultMood, 'chat', 'mood.json');
}

export async function writeMood(store: FileStore, mood: Mood): Promise<void> {
  await store.writeJson(mood, 'chat', 'mood.json');
  await store.appendJsonl(mood, 'chat', 'mood-history.jsonl');
}

export async function maybeUpdateMood(store: FileStore, recentTexts: string[], everyMessages: number): Promise<Mood> {
  const current = await readMood(store);
  if (recentTexts.length === 0 || recentTexts.length % everyMessages !== 0) return current;
  const next = smoothMood(current, analyzeMoodSignal(recentTexts.slice(-everyMessages)));
  await writeMood(store, next);
  return next;
}

export async function resetMood(store: FileStore): Promise<Mood> {
  const mood = { ...defaultMood, updatedAt: new Date().toISOString() };
  await writeMood(store, mood);
  return mood;
}
