import { z } from 'zod';
import { AgentTool } from '../types';

export const listCronJobsTool: AgentTool<Record<string, never>> = {
  name: 'list_cron_jobs',
  description: 'List cron jobs.',
  schema: z.object({}),
  execute: async (_args, context) => JSON.stringify({ jobs: context.scheduler ? await context.scheduler.list() : [] }),
};
