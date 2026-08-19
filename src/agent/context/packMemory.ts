import { buildLocalMemoryContext } from '../../prompts/catalog';
import { formatRecentMessageForContext } from '../../memory/recentMessages';
import { conservativeTokenEstimator, TokenEstimator } from './estimator';
import { buildContextPolicy, ContextPolicy } from './policy';
import type { MemorySource } from './types';

export function formatFacts(items: { text: string }[]): string {
  return items.map((item) => `- ${item.text}`).join('\n');
}

export function packMemory(
  source: MemorySource,
  maxTokens: number,
  estimator: TokenEstimator = conservativeTokenEstimator,
  policy: ContextPolicy = buildContextPolicy({
    contextWindowTokens: maxTokens,
    contextBudgetTokens: maxTokens,
    replyMaxTokens: 1,
  }),
): string {
  if (maxTokens <= 0) return '';

  const budgets = allocateMemoryPartBudgets(source, maxTokens, estimator, policy);
  const selected = {
    summary: trimTextWithMarker(source.summary, budgets.summary, estimator),
    facts: trimTextWithMarker(source.facts, budgets.facts, estimator),
    decisions: trimTextWithMarker(source.decisions, budgets.decisions, estimator),
    recentChat: packRecent(source, budgets.recentChat, estimator),
  };

  return buildLocalMemoryContext({
    summary: selected.summary,
    facts: selected.facts,
    decisions: selected.decisions,
    recentChat: selected.recentChat,
    currentThreadId: source.currentThreadId,
  });
}

function allocateMemoryPartBudgets(
  source: MemorySource,
  maxTokens: number,
  estimator: TokenEstimator,
  policy: ContextPolicy,
): Record<'summary' | 'facts' | 'decisions' | 'recentChat', number> {
  const raw = {
    summary: estimator.estimateText(source.summary),
    facts: estimator.estimateText(source.facts),
    decisions: estimator.estimateText(source.decisions),
    recentChat: estimator.estimateText(packRecent(source, maxTokens, estimator)),
  };
  const budgets = {
    summary: partBudget(raw.summary, maxTokens, policy.memoryParts.summary),
    facts: partBudget(raw.facts, maxTokens, policy.memoryParts.facts),
    decisions: partBudget(raw.decisions, maxTokens, policy.memoryParts.decisions),
    recentChat: partBudget(raw.recentChat, maxTokens, policy.memoryParts.recentChat),
  };

  shrinkToTotal(budgets, maxTokens);

  let free = maxTokens - sumBudgets(budgets);
  for (const key of policy.memoryFreeOrder) {
    if (free <= 0) break;
    const need = Math.max(0, raw[key] - budgets[key]);
    const take = Math.min(free, need);
    budgets[key] += take;
    free -= take;
  }

  return budgets;
}

function partBudget(rawTokens: number, maxTokens: number, policy: ContextPolicy['memoryParts']['summary']): number {
  if (rawTokens <= 0) return 0;
  return Math.max(policy.minTokens, Math.floor(maxTokens * policy.share));
}

function packRecent(source: MemorySource, maxTokens: number, estimator: TokenEstimator): string {
  const lines: string[] = [];
  for (const message of [...source.recent].reverse()) {
    const line = formatRecentMessageForContext(message, Number.MAX_SAFE_INTEGER);
    const candidate = [line, ...lines].join('\n');
    if (estimator.estimateText(candidate) <= maxTokens) {
      lines.unshift(line);
      continue;
    }
    const remaining = Math.max(0, maxTokens - estimator.estimateText(lines.join('\n')));
    const trimmed = trimTextWithMarker(line, remaining, estimator);
    if (trimmed) lines.unshift(trimmed);
    break;
  }
  return lines.join('\n');
}

function shrinkToTotal(budgets: Record<'summary' | 'facts' | 'decisions' | 'recentChat', number>, maxTokens: number): void {
  let total = sumBudgets(budgets);
  while (total > maxTokens) {
    const key = (['summary', 'recentChat', 'facts', 'decisions'] as const)
      .filter((candidate) => budgets[candidate] > 0)
      .sort((a, b) => budgets[b] - budgets[a])[0];
    if (!key) return;
    budgets[key] -= 1;
    total -= 1;
  }
}

function sumBudgets(budgets: Record<'summary' | 'facts' | 'decisions' | 'recentChat', number>): number {
  return budgets.summary + budgets.facts + budgets.decisions + budgets.recentChat;
}

function trimTextWithMarker(text: string, maxTokens: number, estimator: TokenEstimator): string {
  if (maxTokens <= 0 || !text) return '';
  if (estimator.estimateText(text) <= maxTokens) return text;
  const marker = '... [truncated]';
  const textBudget = maxTokens - estimator.estimateText(marker);
  if (textBudget <= 0) return estimator.trimTextToTokens(marker, maxTokens);
  return `${estimator.trimTextToTokens(text, textBudget).trimEnd()}${marker}`;
}

