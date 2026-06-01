import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../tools/types';

export type LlmAdapter = {
  chat: (messages: ChatCompletionMessageParam[], options?: { tools?: ToolRegistry; toolContext?: ToolContext; maxSteps?: number }) => Promise<string>;
  minimalCheck: () => Promise<string>;
  toolCheck: () => Promise<boolean>;
};
