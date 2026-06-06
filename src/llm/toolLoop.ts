import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { formatLogError, logger } from '../utils/logger';
import { ToolRegistry } from '../tools/registry';
import { toOpenAITool, ToolContext } from '../tools/types';

export async function runToolLoop(params: {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  registry: ToolRegistry;
  context: ToolContext;
  maxSteps: number;
}): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [...params.messages];
  const tools = params.registry.list().map(toOpenAITool);
  for (let step = 0; step < params.maxSteps; step += 1) {
    const response = await params.client.chat.completions.create({
      model: params.model,
      messages,
      tools,
      tool_choice: 'auto',
    });
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
