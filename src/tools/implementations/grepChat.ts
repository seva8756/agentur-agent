import { z } from 'zod';
import { formatGrepMatches, grepVirtualChat } from '../../knowledge/provider';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  pattern: z.string().min(1).max(256).describe(TOOL_PROMPTS.grepChat.pattern),
  path: z.string().default('/chat').describe(TOOL_PROMPTS.grepChat.path),
  regex: z.boolean().default(false).describe(TOOL_PROMPTS.grepChat.regex),
  ignore_case: z.boolean().default(true).describe(TOOL_PROMPTS.grepChat.ignoreCase),
  before_context: z.number().int().min(0).max(5).default(0).describe(TOOL_PROMPTS.grepChat.beforeContext),
  after_context: z.number().int().min(0).max(5).default(0).describe(TOOL_PROMPTS.grepChat.afterContext),
  max_results: z.number().int().min(1).max(50).default(20).describe(TOOL_PROMPTS.grepChat.maxResults),
});

export const grepChatTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'grep_chat',
  description: TOOL_PROMPTS.grepChat.description,
  schema: argsSchema,
  execute: async (args, context) => formatGrepMatches(args.pattern, await grepVirtualChat(context.store, {
    pattern: args.pattern,
    path: args.path,
    regex: args.regex,
    ignoreCase: args.ignore_case,
    beforeContext: args.before_context,
    afterContext: args.after_context,
    maxResults: args.max_results,
  })),
};
