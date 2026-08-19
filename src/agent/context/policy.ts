import type { ContextBudgetConfig, ContextStageKind } from './types';

export type StagePolicy = {
  maxTokens: number;
  minTokens?: number;
};

export type MemoryPartPolicy = {
  minTokens: number;
  share: number;
};

export type ContextPolicy = {
  safetyTokens: number;
  stages: Record<ContextStageKind, StagePolicy>;
  memoryParts: Record<'summary' | 'facts' | 'decisions' | 'recentChat', MemoryPartPolicy>;
  memoryFreeOrder: Array<'summary' | 'facts' | 'decisions' | 'recentChat'>;
};

export function buildContextPolicy(config: ContextBudgetConfig): ContextPolicy {
  const soft = Math.max(1, Math.min(config.contextBudgetTokens, config.contextWindowTokens - config.replyMaxTokens));
  return {
    safetyTokens: Math.max(256, Math.ceil(config.contextWindowTokens * 0.02)),
    stages: {
      system: { maxTokens: Math.min(4000, soft) },
      identity: { maxTokens: 5000 },
      time: { maxTokens: 150 },
      skills: { maxTokens: Math.min(5000, soft) },
      user: { maxTokens: 14000 },
      memory: { minTokens: 6850, maxTokens: soft },
      toolObservation: { maxTokens: 10000 },
    },
    memoryParts: {
      summary: { minTokens: 96, share: 0.35 },
      facts: { minTokens: 64, share: 0.18 },
      decisions: { minTokens: 64, share: 0.17 },
      recentChat: { minTokens: 128, share: 0.30 },
    },
    memoryFreeOrder: ['recentChat', 'summary', 'facts', 'decisions'],
  };
}
