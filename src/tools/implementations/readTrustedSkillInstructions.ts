import { z } from 'zod';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  skillId: z.string().regex(/^[a-z0-9_-]+$/i).describe(TOOL_PROMPTS.readTrustedSkillInstructions.skillId),
});

export const readTrustedSkillInstructionsTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'read_trusted_skill_instructions',
  description: TOOL_PROMPTS.readTrustedSkillInstructions.description,
  schema: argsSchema,
  execute: async (args, context) => {
    const skill = context.trustedSkills?.find((candidate) => candidate.manifest.enabled && candidate.manifest.id === args.skillId);
    if (!skill) return JSON.stringify({ ok: false, error: `Enabled trusted skill not found: ${args.skillId}` });
    if (!skill.skillMd.trim()) return JSON.stringify({ ok: false, error: `Trusted skill has no instructions: ${args.skillId}` });
    return JSON.stringify({ ok: true, skillId: skill.manifest.id, instructions: skill.skillMd });
  },
};
