import { z } from 'zod';
import { rollbackSkill } from '../../skills/loader';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  name: z.string().min(1).describe(TOOL_PROMPTS.rollbackSkill.name),
});

export const rollbackSkillTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'rollback_skill',
  description: TOOL_PROMPTS.rollbackSkill.description,
  schema: argsSchema,
  execute: async ({ name }, context) => {
    try {
      const skill = await rollbackSkill(context.store, name);
      return skill
        ? `Restored the previous version of ${skill.id}.`
        : `No previous version is available for ${name}.`;
    } catch (error) {
      return `Could not restore ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
