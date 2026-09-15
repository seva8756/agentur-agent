import { z } from 'zod';
import { listChatFileInventory } from '../../knowledge/provider';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

export const listChatFilesTool: AgentTool<Record<string, never>> = {
  name: 'list_chat_files',
  description: TOOL_PROMPTS.listChatFiles.description,
  schema: z.object({}),
  execute: async (_args, context) => listChatFileInventory(context.store),
};
