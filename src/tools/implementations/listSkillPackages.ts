import { z } from 'zod';
import { findSkill, loadDraftSkills, loadEnabledSkills } from '../../skills/loader';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  name: z.string().optional().describe(TOOL_PROMPTS.listSkillPackages.name),
});

export const listSkillPackagesTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'list_skill_packages',
  description: TOOL_PROMPTS.listSkillPackages.description,
  schema: argsSchema,
  execute: async (args, context) => {
    const [drafts, enabled] = await Promise.all([loadDraftSkills(context.store), loadEnabledSkills(context.store)]);
    if (args.name) {
      const skill = findSkill([...enabled, ...drafts], args.name);
      if (!skill) return JSON.stringify({ ok: false, error: `Skill not found: ${args.name}` });
      return JSON.stringify({ ok: true, skill });
    }
    return JSON.stringify({
      drafts: drafts.map(lightweightSkill),
      enabled: enabled.map(lightweightSkill),
    });
  },
};

function lightweightSkill<T extends { pluginJs: string; skillMd: string }>(skill: T) {
  const { pluginJs, skillMd, ...rest } = skill;
  return {
    ...rest,
    hasPluginJs: Boolean(pluginJs),
    skillMdPreview: skillMd.slice(0, 300),
  };
}
