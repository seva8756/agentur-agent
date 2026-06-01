import { z } from 'zod';

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_contains'), phrases: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('command'), command: z.string().min(1) }),
]);

export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const atomicActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('append_to_list'),
    listName: z.string().regex(/^[a-z0-9_-]+$/i),
    itemExtractionHint: z.string().min(1),
    confirmationText: z.string().optional(),
  }),
  z.object({ type: z.literal('remember_fact'), extractionHint: z.string().min(1) }),
  z.object({ type: z.literal('save_decision'), extractionHint: z.string().min(1) }),
  z.object({ type: z.literal('reply_static'), text: z.string().min(1) }),
  z.object({
    type: z.literal('reply_template'),
    template: z.string().min(1),
  }),
  z.object({
    type: z.literal('http_request'),
    method: httpMethodSchema.default('GET'),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    bodyTemplate: z.string().optional(),
    responseTemplate: z.string().optional(),
    confirmationText: z.string().optional(),
  }),
]);

export const actionSchema = z.union([
  atomicActionSchema,
  z.object({ type: z.literal('chain'), actions: z.array(atomicActionSchema).min(1).max(8) }),
]);

export const microSkillSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  title: z.string().min(1),
  enabled: z.boolean().default(false),
  trigger: triggerSchema,
  action: actionSchema,
  createdAt: z.string(),
});

export type MicroSkill = {
  id: string;
  title: string;
  enabled: boolean;
  trigger: z.output<typeof triggerSchema>;
  action: z.output<typeof actionSchema>;
  createdAt: string;
};
export type SkillAction = z.output<typeof actionSchema>;
export type AtomicSkillAction = z.output<typeof atomicActionSchema>;
