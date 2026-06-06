import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AppConfig } from '../config';
import { logger } from '../utils/logger';
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
      });
      return response.choices[0]?.message.content ?? '';
    },
    minimalCheck: async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'Reply with ok.' }];
      const response = await client.chat.completions.create({ model: config.llmModel, messages, max_tokens: 5 });
      return response.choices[0]?.message.content ?? '';
    },
    toolCheck: async () => {
      const response = await client.chat.completions.create({
        model: config.llmModel,
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Harmless test tool',
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

function withToolFallbackNotice(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const notice: ChatCompletionMessageParam = {
    role: 'system',
    content: [
      'Tool calling failed for this turn, so no tools or skill tools are available in this fallback reply.',
      'Answer directly from the conversation context.',
      'If the user asked for an action that requires tools, say that the action could not be completed right now.',
    ].join(' '),
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
  const candidate = error as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
    type?: unknown;
    error?: { message?: unknown; status?: unknown; code?: unknown; type?: unknown };
  } | undefined;
  const status = typeof candidate?.status === 'number'
    ? candidate.status
    : typeof candidate?.error?.status === 'number'
      ? candidate.error.status
      : undefined;
  const message = [
    candidate?.message,
    candidate?.error?.message,
    candidate?.code,
    candidate?.error?.code,
    candidate?.type,
    candidate?.error?.type,
  ].filter((item): item is string => typeof item === 'string').join(' ').toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('tool') ||
    message.includes('function') ||
    message.includes('unsupported') ||
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status < 600)
  );
}
