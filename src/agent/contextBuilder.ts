import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { limitOutput } from './outputLimiter';
import { FileStore } from '../memory/fileStore';
import { listDecisions } from '../memory/decisions';
import { listFacts } from '../memory/facts';
import { readMood } from '../memory/moodDiary';
import { readIdentity } from '../memory/identity';
import { readChatSettings } from '../memory/chatSettings';
import { formatMessageAuthor, readRecentMessages, selectRecentForContext } from '../memory/recentMessages';
import { readSummary } from '../memory/summary';
import { buildSystemPrompt } from './promptBuilder';
import { formatLocalTime } from '../utils/time';

export type ContextOptions = {
  maxChars: number;
  recentLimit: number;
  factsMaxChars: number;
  timezone: string;
};

export async function buildChatContext(
  store: FileStore,
  userInput: string,
  options: ContextOptions,
): Promise<ChatCompletionMessageParam[]> {
  const [mood, identity, settings, summary, facts, decisions, recent] = await Promise.all([
    readMood(store),
    readIdentity(store),
    readChatSettings(store),
    readSummary(store),
    listFacts(store),
    listDecisions(store),
    readRecentMessages(store),
  ]);
  const factText = facts.map((f) => `- ${f.text}`).join('\n').slice(-options.factsMaxChars);
  const decisionText = decisions.map((d) => `- ${d.text}`).join('\n').slice(-options.factsMaxChars);
  const recentText = selectRecentForContext(recent, options.recentLimit)
    .map((m) => `${formatMessageAuthor(m)}: ${m.text}`)
    .join('\n');
  const context = limitOutput(
    [`Summary:\n${summary}`, `Facts:\n${factText}`, `Decisions:\n${decisionText}`, `Recent chat:\n${recentText}`]
      .filter((s) => s.trim().length > 0)
      .join('\n\n'),
    options.maxChars,
  );
  return [
    { role: 'system', content: buildSystemPrompt(mood, identity, settings.profanityMode) },
    { role: 'system', content: `Current local time: ${formatLocalTime(options.timezone)} (${options.timezone}). Use this for date/time references.` },
    { role: 'system', content: `Local chat memory:\n${context}` },
    { role: 'user', content: userInput },
  ];
}

export function trimMessagesToBudget(
  messages: ChatCompletionMessageParam[],
  maxChars: number,
): ChatCompletionMessageParam[] {
  const copy = [...messages];
  const length = () => copy.reduce((sum, m) => sum + messageContentToString(m.content).length, 0);
  while (copy.length > 2 && length() > maxChars) copy.splice(1, 1);
  if (length() > maxChars && copy.length >= 2) {
    const last = copy[copy.length - 1];
    copy[copy.length - 1] = { ...last, content: limitOutput(messageContentToString(last.content), maxChars / 2) };
  }
  return copy;
}

function messageContentToString(content: ChatCompletionMessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return JSON.stringify(content);
}
