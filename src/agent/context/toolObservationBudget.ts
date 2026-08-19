import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { conservativeTokenEstimator, estimateMessageTokens, TokenEstimator } from './estimator';
import type { ContextPolicy } from './policy';
import type { ContextAllocation } from './types';

export type ToolObservationBudgetSource = {
  allocation: ContextAllocation;
  policy: ContextPolicy;
};

export type ToolObservationBudget = {
  estimator: TokenEstimator;
  softCapTokens: number;
  hardCapTokens: number;
  toolsTokens: number;
};

export type FittedToolObservation = {
  content: string;
  rawTokens: number;
  softContentTokens: number;
  hardContentTokens: number;
  fittedTokens: number;
  overflowTokens: number;
  trimmed: boolean;
  limited: boolean;
};

export function createToolObservationBudget(
  source: ToolObservationBudgetSource,
  messages: ChatCompletionMessageParam[],
  tools: unknown[],
  estimator: TokenEstimator = conservativeTokenEstimator,
): ToolObservationBudget {
  const toolsTokens = estimateToolsTokens(tools, estimator);
  const currentPromptTokens = estimateToolObservationMessages(messages, estimator) + toolsTokens;
  const unusedContextBudget = Math.max(0, source.allocation.softBudgetTokens - currentPromptTokens);
  const toolSoftRoom = unusedContextBudget + source.policy.stages.toolObservation.maxTokens;
  const hardCapTokens = source.allocation.usableHardTokens;
  return {
    estimator,
    softCapTokens: Math.min(currentPromptTokens + toolSoftRoom, hardCapTokens),
    hardCapTokens,
    toolsTokens,
  };
}

export function fitToolObservationContent(
  content: string,
  toolCallId: string,
  messages: ChatCompletionMessageParam[],
  budget: ToolObservationBudget | undefined,
): FittedToolObservation {
  if (!budget) {
    const rawTokens = conservativeTokenEstimator.estimateText(content);
    return {
      content,
      rawTokens,
      softContentTokens: rawTokens,
      hardContentTokens: rawTokens,
      fittedTokens: rawTokens,
      overflowTokens: 0,
      trimmed: false,
      limited: false,
    };
  }
  const currentPromptTokens = estimateToolObservationMessages(messages, budget.estimator) + budget.toolsTokens;
  const softContentTokens = availableToolContentTokens(budget.softCapTokens, currentPromptTokens, toolCallId, budget.estimator);
  const hardContentTokens = availableToolContentTokens(budget.hardCapTokens, currentPromptTokens, toolCallId, budget.estimator);
  const rawTokens = budget.estimator.estimateText(content);
  if (rawTokens <= softContentTokens) {
    return {
      content,
      rawTokens,
      softContentTokens,
      hardContentTokens,
      fittedTokens: rawTokens,
      overflowTokens: 0,
      trimmed: false,
      limited: false,
    };
  }

  const trimmed = rawTokens > hardContentTokens;
  const fitted = trimmed ? trimToolContent(content, hardContentTokens, budget.estimator) : content;
  return {
    content: fitted,
    rawTokens,
    softContentTokens,
    hardContentTokens,
    fittedTokens: budget.estimator.estimateText(fitted),
    overflowTokens: Math.max(0, Math.min(rawTokens, hardContentTokens) - softContentTokens),
    trimmed,
    limited: true,
  };
}

function availableToolContentTokens(capTokens: number, currentPromptTokens: number, toolCallId: string, estimator: TokenEstimator): number {
  const emptyToolMessageTokens = estimateToolObservationMessage({
    role: 'tool',
    tool_call_id: toolCallId,
    content: '',
  }, estimator);
  return Math.max(0, capTokens - currentPromptTokens - emptyToolMessageTokens);
}

function trimToolContent(content: string, maxTokens: number, estimator: TokenEstimator): string {
  const marker = '\n... [truncated: tool result exceeded context budget]';
  if (maxTokens <= 0) return '[Tool result omitted: context window exhausted.]';
  const markerTokens = estimator.estimateText(marker);
  if (markerTokens >= maxTokens) return estimator.trimTextToTokens(marker.trim(), maxTokens);
  return `${estimator.trimTextToTokens(content, maxTokens - markerTokens).trimEnd()}${marker}`;
}

function estimateToolObservationMessages(messages: ChatCompletionMessageParam[], estimator: TokenEstimator): number {
  return messages.reduce((sum, message) => sum + estimateToolObservationMessage(message, estimator), 0);
}

function estimateToolsTokens(tools: unknown[], estimator: TokenEstimator): number {
  return tools.length ? estimator.estimateText(JSON.stringify(tools)) : 0;
}

function estimateToolObservationMessage(message: ChatCompletionMessageParam, estimator: TokenEstimator): number {
  const record = message as ChatCompletionMessageParam & {
    tool_calls?: unknown;
    tool_call_id?: unknown;
    name?: unknown;
  };
  let total = estimateMessageTokens(message, estimator);
  if (Array.isArray(record.tool_calls)) total += estimator.estimateText(JSON.stringify(record.tool_calls));
  if (typeof record.tool_call_id === 'string') total += estimator.estimateText(record.tool_call_id);
  if (typeof record.name === 'string') total += estimator.estimateText(record.name);
  return total;
}
