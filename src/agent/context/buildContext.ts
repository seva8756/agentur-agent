import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { listDecisions } from '../../memory/decisions';
import { FileStore } from '../../memory/fileStore';
import { listFacts } from '../../memory/facts';
import { readChatSettings } from '../../memory/chatSettings';
import { readIdentity } from '../../memory/identity';
import { readMood } from '../../memory/moodDiary';
import { readRecentMessages } from '../../memory/recentMessages';
import { readSummary } from '../../memory/summary';
import {
  buildAgentSystemPrompt,
  buildArtifactToolsPrompt,
  buildCurrentTimePrompt,
  buildEnabledSkillsPrompt,
  buildLocalMemoryPrompt,
} from '../../prompts/catalog';
import { loadEnabledSkills } from '../../skills/loader';
import { formatLocalTime } from '../../utils/time';
import { allocateContextStages } from './budget';
import { conservativeTokenEstimator, TokenEstimator } from './estimator';
import { formatFacts, packMemory } from './packMemory';
import { buildContextPolicy } from './policy';
import type { BuiltContext, ContextBuildOptions, MemorySource, TextStage } from './types';

export async function buildChatContext(
  store: FileStore,
  userInput: string,
  options: ContextBuildOptions,
  estimator: TokenEstimator = conservativeTokenEstimator,
): Promise<BuiltContext> {
  const [mood, identity, settings, summary, facts, decisions, recent, skills] = await Promise.all([
    readMood(store),
    readIdentity(store),
    readChatSettings(store),
    readSummary(store),
    listFacts(store),
    listDecisions(store),
    readRecentMessages(store),
    loadEnabledSkills(store),
  ]);

  const system = buildAgentSystemPrompt(mood, identity, settings.profanityMode);
  const time = buildCurrentTimePrompt(formatLocalTime(options.timezone), options.timezone);
  const skillsPrompt = [
    buildEnabledSkillsPrompt(skills, options.trustedSkills ?? []),
    buildArtifactToolsPrompt(),
  ].filter(Boolean).join('\n');
  const memorySource: MemorySource = {
    summary,
    facts: formatFacts(facts),
    decisions: formatFacts(decisions),
    recent,
    currentThreadId: options.currentThreadId,
  };

  const policy = buildContextPolicy(options);
  const rawMemory = packMemory(memorySource, options.contextBudgetTokens, estimator, policy);
  const stages: TextStage[] = [
    { kind: 'system', content: system },
    { kind: 'time', content: time },
    { kind: 'skills', content: skillsPrompt },
    { kind: 'user', content: userInput },
    { kind: 'memory', content: rawMemory },
  ];
  const allocation = allocateContextStages(stages, options, estimator);
  const memory = packMemory(memorySource, allocation.takes.memory, estimator, policy);
  const messages: ChatCompletionMessageParam[] = [];
  pushSystem(messages, estimator.trimTextToTokens(system, allocation.takes.system));
  pushSystem(messages, estimator.trimTextToTokens(time, allocation.takes.time));
  if (memory.trim()) pushSystem(messages, buildLocalMemoryPrompt(memory));
  pushSystem(messages, estimator.trimTextToTokens(skillsPrompt, allocation.takes.skills));
  messages.push({ role: 'user', content: estimator.trimTextToTokens(userInput, allocation.takes.user) });

  return { messages, allocation };
}

function pushSystem(messages: ChatCompletionMessageParam[], content: string): void {
  if (!content.trim()) return;
  messages.push({ role: 'system', content });
}
