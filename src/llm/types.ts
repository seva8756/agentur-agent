import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ContextPolicy } from '../agent/context/policy';
import type { ContextAllocation } from '../agent/context/types';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../tools/types';

export type LlmContextBudget = {
  allocation: ContextAllocation;
  policy: ContextPolicy;
};

export type LlmAdapter = {
  chat: (messages: ChatCompletionMessageParam[], options?: {
    tools?: ToolRegistry;
    toolContext?: ToolContext;
    maxSteps?: number;
    maxTokens?: number;
    contextBudget?: LlmContextBudget;
  }) => Promise<string>;
  minimalCheck: () => Promise<string>;
  toolCheck: () => Promise<boolean>;
};
