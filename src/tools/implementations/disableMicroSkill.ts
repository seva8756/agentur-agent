import { z } from 'zod';
import { disableSkill } from '../../skills/loader';
import { AgentTool } from '../types';

const argsSchema = z.object({ name: z.string().min(1).optional(), id: z.string().min(1).optional() });

export const disableMicroSkillTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'disable_micro_skill',
  description: 'Disable an enabled micro-skill by name. Name can be the stable file name or the visible title.',
  schema: argsSchema,
  execute: async (args, context) => {
    const name = args.name ?? args.id ?? '';
    return (await disableSkill(context.store, name)) ? `Disabled ${name}` : `Skill ${name} was not enabled or not found`;
  },
};
