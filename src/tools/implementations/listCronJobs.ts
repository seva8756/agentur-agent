import { z } from 'zod';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

export const listCronJobsTool: AgentTool<Record<string, never>> = {
  name: 'list_cron_jobs',
  description: TOOL_PROMPTS.listCronJobs.description,
  schema: z.object({}),
  execute: async (_args, context) => JSON.stringify({ jobs: context.scheduler ? await context.scheduler.list() : [] }),
};
