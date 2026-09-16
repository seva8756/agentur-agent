import type { LlmAdapter } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { Mood, MoodSignal, moodSignalSchema, readMood, smoothMood, writeMood } from '../memory/moodDiary';
import { formatRecentMessageForContext, RecentMessage } from '../memory/recentMessages';
import { buildMoodAnalysisSystemPrompt, buildMoodAnalysisUserPrompt } from '../prompts/catalog';

const MOOD_ANALYSIS_MESSAGE_MAX_CHARS = 400;

// Updates mood only at its configured interval, using the latest interval-sized chat window.
export async function maybeUpdateMood(
  store: FileStore,
  llm: LlmAdapter,
  recentMessages: RecentMessage[],
  everyMessages: number,
): Promise<Mood> {
  const current = await readMood(store);
  if (recentMessages.length === 0 || recentMessages.length % everyMessages !== 0) return current;

  const recentChat = recentMessages
    .slice(-everyMessages)
    .map((message) => formatRecentMessageForContext(message, MOOD_ANALYSIS_MESSAGE_MAX_CHARS))
    .join('\n');
  if (!recentChat.trim()) return current;

  try {
    const raw = await llm.chat([
      { role: 'system', content: buildMoodAnalysisSystemPrompt(current) },
      { role: 'user', content: buildMoodAnalysisUserPrompt(recentChat) },
    ], { maxTokens: 100 });
    const next = smoothMood(current, parseMoodSignal(raw), 0.2);
    await writeMood(store, next);
    return next;
  } catch {
    // Mood is auxiliary state: retain the last model-backed estimate if the analysis request fails.
    return current;
  }
}

function parseMoodSignal(raw: string): MoodSignal {
  return moodSignalSchema.parse(JSON.parse(raw));
}
