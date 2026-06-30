import { z } from 'zod';
import { saveDecision } from '../../memory/decisions';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

export const saveDecisionTool: AgentTool<{ text: string; source?: string }> = {
  name: 'save_decision',
  description: TOOL_PROMPTS.saveDecision.description,
  schema: z.object({ text: z.string().min(1), source: z.string().optional() }),
  execute: async (args, context) => {
    const decision = await saveDecision(context.store, args.text, args.source ?? 'llm_tool');
    return `Saved decision ${decision.id}`;
  },
};
