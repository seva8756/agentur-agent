import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { RecentMessage } from '../../memory/recentMessages';
import type { TrustedSkillPromptInfo } from '../../skills/trustedTypes';
import type { ContextPolicy } from './policy';

export type ContextBudgetConfig = {
  contextWindowTokens: number;
  contextBudgetTokens: number;
  replyMaxTokens: number;
};

export type ContextBuildOptions = ContextBudgetConfig & {
  timezone: string;
  currentThreadId?: number;
  trustedSkills?: TrustedSkillPromptInfo[];
};

export type ContextStageKind =
  | 'system'
  | 'time'
  | 'skills'
  | 'user'
  | 'memory'
  | 'toolObservation';

export type TextStage = {
  kind: ContextStageKind;
  content: string;
};

export type MemorySource = {
  summary: string;
  facts: string;
  decisions: string;
  recent: RecentMessage[];
  currentThreadId?: number;
};

export type ContextAllocation = {
  usableHardTokens: number;
  softBudgetTokens: number;
  freeTokens: number;
  userExtraTokens: number;
  userOverflowTokens: number;
  takes: Record<ContextStageKind, number>;
};

export type BuiltContext = {
  messages: ChatCompletionMessageParam[];
  allocation: ContextAllocation;
  policy: ContextPolicy;
};
