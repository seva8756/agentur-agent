import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { formatLogError, logger } from '../utils/logger';
import { ToolRegistry } from '../tools/registry';
import { toOpenAITool, ToolContext } from '../tools/types';
import { buildNativeToolCallingNotice } from '../prompts/catalog';
import { isRetryableLlmTransportError } from './errors';

export async function runToolLoop(params: {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  registry: ToolRegistry;
  context: ToolContext;
  maxSteps: number;
  maxTokens?: number;
  completionRetries?: number;
}): Promise<string> {
  const tools = params.registry.list().map(toOpenAITool);
  const messages: ChatCompletionMessageParam[] = tools.length
    ? withNativeToolCallingNotice(params.messages)
    : [...params.messages];
  for (let step = 0; step < params.maxSteps; step += 1) {
    const response = await createCompletionWithRetry(params, messages, tools);
    logCompletionUsage('LLM tool loop usage', step + 1, response.usage);
    const message = response.choices[0]?.message;
    if (!message) return '';
    if (!message.tool_calls?.length) return message.content ?? '';
    messages.push(message as ChatCompletionMessageParam);
    for (const call of message.tool_calls) {
      const tool = params.registry.get(call.function.name);
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: `Unknown tool ${call.function.name}` });
        continue;
      }
      try {
        const parsed = tool.schema.parse(JSON.parse(call.function.arguments || '{}'));
        logger.info(`Executing tool ${tool.name}`);
        const result = await tool.execute(parsed, params.context);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      } catch (error) {
        logger.warn(`Tool failed: ${tool.name}`, formatLogError(error));
        messages.push({ role: 'tool', tool_call_id: call.id, content: formatToolError(tool.name, error) });
      }
    }
  }
  return 'Не смог завершить действие: достигнут лимит внутренних действий.';
}

function logCompletionUsage(
  message: string,
  step: number,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): void {
  if (!usage) return;
  logger.info(message, `step=${step} prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'} total=${usage.total_tokens ?? '?'}`);
}

function withNativeToolCallingNotice(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const notice: ChatCompletionMessageParam = {
    role: 'system',
    content: buildNativeToolCallingNotice(),
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

async function createCompletionWithRetry(
  params: {
    client: OpenAI;
    model: string;
    maxTokens?: number;
    completionRetries?: number;
  },
  messages: ChatCompletionMessageParam[],
  tools: ReturnType<typeof toOpenAITool>[],
) {
  const maxAttempts = Math.max(1, (params.completionRetries ?? 0) + 1);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await params.client.chat.completions.create({
        model: params.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: params.maxTokens,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableLlmTransportError(error)) throw error;
      logger.warn('LLM tool loop completion failed; retrying with tools', {
        attempt,
        maxAttempts,
        error: formatLogError(error),
      });
    }
  }
  throw lastError;
}

function formatToolError(toolName: string, error: unknown): string {
  if (error instanceof z.ZodError) {
    return JSON.stringify({
      ok: false,
      tool: toolName,
      error: {
        code: 'invalid_tool_arguments',
        message: 'Tool arguments failed schema validation. Fix the arguments and call the tool again if the user still needs this action.',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          expected: 'expected' in issue ? issue.expected : undefined,
          received: 'received' in issue ? issue.received : undefined,
        })),
      },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({
    ok: false,
    tool: toolName,
    error: {
      code: 'tool_failed',
      message: message.slice(0, 1000),
    },
  });
}
