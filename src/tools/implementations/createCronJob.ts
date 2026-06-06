import { z } from 'zod';
import { cronActionSchema, cronJobSchema } from '../../scheduler/schema';
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
  description:
    'Create a disabled cron reminder draft from natural language. Use ASCII id with cron_ prefix if possible; if unsure omit id. The action must be an object. Supported actions: send_static_message, ask_agent_and_send, run_skill_tool with skillId/toolName/args/text/sendResult. User enables it with /agentur cron enable <id>.',
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
