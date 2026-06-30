import { z } from 'zod';
import { enableSkill } from '../../skills/loader';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({ name: z.string().min(1).optional(), id: z.string().min(1).optional() });

export const enableMicroSkillTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'enable_micro_skill',
  description: TOOL_PROMPTS.enableMicroSkill.description,
  schema: argsSchema,
  execute: async (args, context) => {
    const name = args.name ?? args.id ?? '';
    try {
      return (await enableSkill(context.store, name, {
        httpAllowedOrigins: context.httpAllowedOrigins ?? [],
        httpTimeoutMs: context.httpTimeoutMs ?? 10000,
        httpMaxRequestBytes: context.httpMaxRequestBytes ?? 131072,
        httpMaxResponseBytes: context.httpMaxResponseBytes ?? 1048576,
      })) ? `Enabled ${name}` : `Skill ${name} not found`;
    } catch (error) {
      return `Skill ${name} not enabled: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
