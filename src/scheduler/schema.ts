import cron from 'node-cron';
import { z } from 'zod';

export const cronActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send_static_message'), text: z.string().min(1) }),
  z.object({ type: z.literal('ask_agent_and_send'), prompt: z.string().min(1) }),
  z.object({
    type: z.literal('run_skill_tool'),
    skillId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.record(z.unknown()).default({}),
    text: z.string().min(1).optional(),
    sendResult: z.boolean().default(true),
  }),
]);

export const cronJobSchema = z.object({
  id: z.string().regex(/^cron_[a-z0-9_-]+$/i),
  title: z.string().min(1),
  enabled: z.boolean().default(false),
  cron: z.string().refine((value) => cron.validate(value), 'Invalid cron expression'),
  timezone: z.string().min(1),
  threadId: z.number().int().positive().nullable().optional().default(null),
  action: cronActionSchema,
  createdAt: z.string(),
});

export const cronJobsFileSchema = z.object({ jobs: z.array(cronJobSchema) });
export type CronJobConfig = {
  id: string;
  title: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  threadId?: number | null;
  action: z.output<typeof cronActionSchema>;
  createdAt: string;
};
export type CronJobsFile = { jobs: CronJobConfig[] };
