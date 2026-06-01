import { z } from 'zod';
import { enableSkill } from '../../skills/loader';
import { AgentTool } from '../types';

const argsSchema = z.object({ name: z.string().min(1).optional(), id: z.string().min(1).optional() });

export const enableMicroSkillTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'enable_micro_skill',
  description: 'Enable an existing micro-skill draft by name. Name can be the stable file name or the visible title.',
  schema: argsSchema,
  execute: async (args, context) => {
    const name = args.name ?? args.id ?? '';
    return (await enableSkill(context.store, name)) ? `Enabled ${name}` : `Skill ${name} not found`;
  },
};
