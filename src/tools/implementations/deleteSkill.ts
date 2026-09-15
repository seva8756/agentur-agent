import { z } from 'zod';
import { deleteSkill } from '../../skills/loader';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({ name: z.string().min(1).optional(), id: z.string().min(1).optional() });

export const deleteSkillTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'delete_skill',
  description: TOOL_PROMPTS.deleteSkill.description,
  schema: argsSchema,
  execute: async (args, context) => {
    const name = args.name ?? args.id ?? '';
    return (await deleteSkill(context.store, name)) ? `Deleted ${name}` : `Skill ${name} not found`;
  },
};
