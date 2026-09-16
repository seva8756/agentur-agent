import { z } from 'zod';
import { FileStore } from './fileStore';

export const moodSchema = z.object({
  warmth: z.number().min(0).max(1),
  tension: z.number().min(0).max(1),
  humor: z.number().min(0).max(1),
  updatedAt: z.string(),
});
export type Mood = z.infer<typeof moodSchema>;
export const moodSignalSchema = moodSchema.omit({ updatedAt: true });
export type MoodSignal = z.infer<typeof moodSignalSchema>;

export function createDefaultMood(): Mood {
  return {
    warmth: 0.5,
    tension: 0.1,
    humor: 0.2,
    updatedAt: new Date().toISOString(),
  };
}

// Retained for callers that need the default values outside of initialization.
export const defaultMood = createDefaultMood();

export function smoothMood(current: Mood, signal: MoodSignal, alpha = 0.2): Mood {
  const mix = (a: number, b: number) => Math.max(0, Math.min(1, a * (1 - alpha) + b * alpha));
  return {
    warmth: mix(current.warmth, signal.warmth),
    tension: mix(current.tension, signal.tension),
    humor: mix(current.humor, signal.humor),
    updatedAt: new Date().toISOString(),
  };
}

export async function readMood(store: FileStore): Promise<Mood> {
  return store.readJson(moodSchema, createDefaultMood(), 'chat', 'mood.json');
}

export async function writeMood(store: FileStore, mood: Mood): Promise<void> {
  await store.writeJson(mood, 'chat', 'mood.json');
  await store.appendJsonl(mood, 'chat', 'mood-history.jsonl');
}

export async function resetMood(store: FileStore): Promise<Mood> {
  const mood = createDefaultMood();
  await writeMood(store, mood);
  return mood;
}
