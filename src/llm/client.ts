import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AppConfig } from '../config';
import { logger } from '../utils/logger';
import { buildToolFallbackNotice, LLM_HEALTH_CHECK_PROMPT, LLM_TOOL_CHECK_PROMPT, LLM_TOOL_CHECK_TOOL_DESCRIPTION } from '../prompts/catalog';
import { getLlmErrorDetails } from './errors';
import { runToolLoop } from './toolLoop';
import { LlmAdapter } from './types';

export function createLlmClient(config: AppConfig): LlmAdapter {
  const client = new OpenAI({
    apiKey: config.llmApiKey,
    baseURL: config.llmBaseUrl,
    timeout: config.llmTimeoutMs,
    maxRetries: config.llmMaxRetries,
  });

  return {
    chat: async (messages, options) => {
      let fallbackWithoutTools = false;
      if (config.llmSupportsTools && options?.tools && options.toolContext) {
        try {
          return await runToolLoop({
            client,
            model: config.llmModel,
            messages,
            registry: options.tools,
            context: options.toolContext,
            maxSteps: options.maxSteps ?? config.agentMaxToolSteps,
            maxTokens: options.maxTokens ?? config.replyMaxTokens,
            completionRetries: config.llmToolLoopRetries,
          });
        } catch (error) {
          if (!shouldRetryWithoutTools(error)) throw error;
          logger.warn('LLM tool loop failed; retrying without tools', error);
          fallbackWithoutTools = true;
        }
      }
      const response = await client.chat.completions.create({
        model: config.llmModel,
        messages: fallbackWithoutTools ? withToolFallbackNotice(messages) : messages,
        max_tokens: options?.maxTokens ?? config.replyMaxTokens,
      });
      logCompletionUsage('LLM completion usage', response.usage);
      return response.choices[0]?.message.content ?? '';
    },
    minimalCheck: async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: LLM_HEALTH_CHECK_PROMPT }];
      const response = await client.chat.completions.create({ model: config.llmModel, messages, max_tokens: 5 });
      return response.choices[0]?.message.content ?? '';
    },
    toolCheck: async () => {
      const response = await client.chat.completions.create({
        model: config.llmModel,
        messages: [{ role: 'user', content: LLM_TOOL_CHECK_PROMPT }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: LLM_TOOL_CHECK_TOOL_DESCRIPTION,
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          },
        ],
        tool_choice: 'auto',
      });
      return Boolean(response.choices[0]?.message.tool_calls?.length);
    },
  };
}

function logCompletionUsage(message: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): void {
  if (!usage) return;
  logger.info(message, `prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'} total=${usage.total_tokens ?? '?'}`);
}

function withToolFallbackNotice(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const notice: ChatCompletionMessageParam = {
    role: 'system',
    content: buildToolFallbackNotice(),
  };
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return [...messages, notice];
  return [
    ...messages.slice(0, lastUserIndex),
    notice,
    ...messages.slice(lastUserIndex),
  ];
}

function shouldRetryWithoutTools(error: unknown): boolean {
  const { status, text } = getLlmErrorDetails(error);
  return (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('tool') ||
    text.includes('function') ||
    text.includes('unsupported') ||
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status < 600)
  );
}
