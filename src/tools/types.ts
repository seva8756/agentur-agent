import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { FileStore } from '../memory/fileStore';
import { AgentScheduler } from '../scheduler/scheduler';
import type { McpManager } from '../integrations/mcp/manager';
import type { TrustedSkillPromptInfo } from '../skills/trustedTypes';
import { ChatMessage } from '../telegram/telegramTypes';

export type ToolContext = {
  store: FileStore;
  scheduler?: AgentScheduler;
  timezone: string;
  httpAllowedOrigins?: string[];
  httpTimeoutMs?: number;
  httpMaxRequestBytes?: number;
  httpMaxResponseBytes?: number;
  currentMessage?: ChatMessage;
  trustedSkills?: TrustedSkillPromptInfo[];
  mcp?: McpManager;
};

export type AgentTool<TArgs = any> = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  execute: (args: TArgs, context: ToolContext) => Promise<string>;
};

export function toOpenAITool(tool: AgentTool): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.schema),
    },
  };
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema._def.innerType);
  if (schema instanceof z.ZodEffects) return zodToJsonSchema(schema.innerType());
  if (schema instanceof z.ZodNullable) return { anyOf: [zodToJsonSchema(schema.unwrap()), { type: 'null' }] };
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return { oneOf: [...schema.options.values()].map((option) => zodToJsonSchema(option)) };
  }
  if (schema instanceof z.ZodUnion) {
    return { anyOf: (schema.options as z.ZodTypeAny[]).map((option) => zodToJsonSchema(option)) };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }
  if (schema instanceof z.ZodString) {
    const json: Record<string, unknown> = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') json.minLength = check.value;
      if (check.kind === 'max') json.maxLength = check.value;
      if (check.kind === 'regex') json.pattern = check.regex.source;
    }
    return json;
  }
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodLiteral) return { enum: [schema.value] };
  if (schema instanceof z.ZodRecord) return { type: 'object', additionalProperties: zodToJsonSchema(schema.valueSchema) };
  return { type: 'string' };
}
