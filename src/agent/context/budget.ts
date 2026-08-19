import { buildContextPolicy } from './policy';
import { conservativeTokenEstimator, TokenEstimator } from './estimator';
import type { ContextAllocation, ContextBudgetConfig, ContextStageKind, TextStage } from './types';

const STAGE_KINDS: ContextStageKind[] = ['system', 'time', 'skills', 'user', 'memory', 'toolObservation'];

export function allocateContextStages(
  stages: TextStage[],
  config: ContextBudgetConfig,
  estimator: TokenEstimator = conservativeTokenEstimator,
): ContextAllocation {
  const policy = buildContextPolicy(config);
  const usableHardTokens = Math.max(1, config.contextWindowTokens - config.replyMaxTokens - policy.safetyTokens);
  const softBudgetTokens = Math.max(1, Math.min(config.contextBudgetTokens, usableHardTokens));
  const raw = emptyStageRecord();

  for (const stage of stages) {
    raw[stage.kind] += estimator.estimateText(stage.content);
  }

  const takes = emptyStageRecord();
  let softRemaining = softBudgetTokens;
  takes.system = takeBase(raw.system, policy.stages.system.maxTokens, softRemaining);
  softRemaining -= takes.system;
  takes.time = takeBase(raw.time, policy.stages.time.maxTokens, softRemaining);
  softRemaining -= takes.time;
  takes.skills = takeBase(raw.skills, policy.stages.skills.maxTokens, softRemaining);
  softRemaining -= takes.skills;
  takes.toolObservation = 0;
  takes.memory = takeBase(raw.memory, policy.stages.memory.minTokens ?? 0, softRemaining);
  softRemaining -= takes.memory;
  takes.user = takeBase(raw.user, policy.stages.user.maxTokens, softRemaining);

  const baseUsed = sumTakes(takes);
  let freeTokens = Math.max(0, softBudgetTokens - baseUsed);
  const userNeed = Math.max(0, raw.user - takes.user);
  const userExtraTokens = Math.min(freeTokens, userNeed);
  takes.user += userExtraTokens;
  freeTokens -= userExtraTokens;

  const memoryNeed = Math.max(0, raw.memory - takes.memory);
  const memoryExtra = Math.min(freeTokens, memoryNeed);
  takes.memory += memoryExtra;
  freeTokens -= memoryExtra;

  const overflowRoom = Math.max(0, usableHardTokens - sumTakes(takes));
  const userOverflowTokens = Math.min(overflowRoom, Math.max(0, raw.user - takes.user));
  takes.user += userOverflowTokens;

  return {
    usableHardTokens,
    softBudgetTokens,
    freeTokens,
    userExtraTokens,
    userOverflowTokens,
    takes,
  };
}

function emptyStageRecord(): Record<ContextStageKind, number> {
  return STAGE_KINDS.reduce((record, kind) => {
    record[kind] = 0;
    return record;
  }, {} as Record<ContextStageKind, number>);
}

function sumTakes(takes: Record<ContextStageKind, number>): number {
  return STAGE_KINDS.reduce((sum, kind) => sum + takes[kind], 0);
}

function takeBase(rawTokens: number, maxTokens: number, remainingTokens: number): number {
  return Math.max(0, Math.min(rawTokens, maxTokens, remainingTokens));
}
