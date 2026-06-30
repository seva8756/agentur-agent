import { z } from 'zod';
import { cronActionSchema, cronJobSchema } from '../../scheduler/schema';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { withPrefix } from '../../utils/slug';
import { AgentTool } from '../types';

const argsSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1).optional(),
  action: cronActionSchema,
});

export const createCronJobTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'create_cron_job',
  description: TOOL_PROMPTS.createCronJob.description,
  schema: argsSchema,
  execute: async (args, context) => {
    if (!context.scheduler) return 'Scheduler is not available';
    const id = withPrefix(args.id ?? args.title, 'cron_');
    const job = cronJobSchema.parse({
      id,
      title: args.title,
      cron: args.cron,
      timezone: args.timezone ?? context.timezone,
      threadId: context.currentMessage?.threadId ?? null,
      action: args.action,
      enabled: false,
      createdAt: new Date().toISOString(),
    });
    await context.scheduler.saveDraft(job);
    return `Created cron draft ${job.id}. Enable with /agentur cron enable ${job.id}`;
  },
};
