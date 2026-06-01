import { z } from 'zod';
import { loadDraftSkills, loadEnabledSkills } from '../../skills/loader';
import { AgentTool } from '../types';

export const listMicroSkillsTool: AgentTool<Record<string, never>> = {
  name: 'list_micro_skills',
  description: 'List draft and enabled micro-skills.',
  schema: z.object({}),
  execute: async (_args, context) => {
    const [drafts, enabled] = await Promise.all([loadDraftSkills(context.store), loadEnabledSkills(context.store)]);
    return JSON.stringify({ drafts, enabled });
  },
};
