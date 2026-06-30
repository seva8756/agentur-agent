import { z } from 'zod';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({ name: z.string().min(1).optional(), id: z.string().min(1).optional() });

export const deleteCronJobTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'delete_cron_job',
  description: TOOL_PROMPTS.deleteCronJob.description,
  schema: argsSchema,
  execute: async (args, context) => {
    const name = args.name ?? args.id ?? '';
    return context.scheduler && (await context.scheduler.delete(name)) ? `Deleted ${name}` : `Cron job ${name} not found`;
  },
};
