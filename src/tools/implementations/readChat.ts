import { z } from 'zod';
import { formatReadResult, readVirtualChatFile } from '../../knowledge/provider';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  path: z.string().min(6).max(300).describe(TOOL_PROMPTS.readChat.path),
  start_line: z.number().int().positive().default(1).describe(TOOL_PROMPTS.readChat.startLine),
  end_line: z.number().int().positive().max(100_000).default(120).describe(TOOL_PROMPTS.readChat.endLine),
});

export const readChatTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'read_chat',
  description: TOOL_PROMPTS.readChat.description,
  schema: argsSchema,
  execute: async (args, context) => formatReadResult(await readVirtualChatFile(context.store, args.path, args.start_line, args.end_line)),
};
