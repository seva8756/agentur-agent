import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AppConfig } from '../config';
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
      if (config.llmSupportsTools && options?.tools && options.toolContext) {
        return runToolLoop({
          client,
          model: config.llmModel,
          messages,
          registry: options.tools,
          context: options.toolContext,
          maxSteps: options.maxSteps ?? config.agentMaxToolSteps,
        });
      }
      const response = await client.chat.completions.create({ model: config.llmModel, messages });
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
