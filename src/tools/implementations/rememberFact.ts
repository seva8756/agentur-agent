import { z } from 'zod';
import { rememberFact as saveFact } from '../../memory/facts';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

export const rememberFactTool: AgentTool<{ text: string; source?: string }> = {
  name: 'remember_fact',
  description: TOOL_PROMPTS.rememberFact.description,
  schema: z.object({ text: z.string().min(1), source: z.string().optional() }),
  execute: async (args, context) => {
    const fact = await saveFact(context.store, args.text, args.source ?? 'llm_tool');
    return `Saved fact ${fact.id}`;
  },
};
