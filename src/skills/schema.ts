import { z } from 'zod';

const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/i);

export const triggerSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  tool: toolNameSchema,
});

export const skillToolSchema = z.object({
  description: z.string().min(1).max(1000),
  schema: z.record(z.unknown()).optional().default({ type: 'object', properties: {} }),
});

export const skillPermissionsSchema = z.object({
  httpOrigins: z.array(z.string().url()).default([]),
  storage: z.boolean().default(true),
  secrets: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/)).default([]),
});

export const skillPackageManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  title: z.string().min(1),
  whenToUse: z.string().min(1).max(1000),
  enabled: z.boolean().default(false),
  runtime: z.enum(['quickjs', 'native']).default('quickjs'),
  source: z.enum(['chat_generated', 'system']).default('chat_generated'),
  version: z.number().int().positive().default(1),
  triggers: z.array(triggerSchema).default([]),
  tools: z.record(toolNameSchema, skillToolSchema).refine((tools) => Object.keys(tools).length > 0, 'At least one tool is required'),
  permissions: skillPermissionsSchema.default({ httpOrigins: [], storage: true, secrets: [] }),
  createdAt: z.string(),
});

export const skillPackageSchema = skillPackageManifestSchema.extend({
  skillMd: z.string().default(''),
  pluginJs: z.string().min(1),
});

export type SkillTrigger = z.output<typeof triggerSchema>;
export type SkillPackageManifest = z.output<typeof skillPackageManifestSchema>;
export type SkillPackage = z.output<typeof skillPackageSchema>;
export type MicroSkill = SkillPackage;

export function skillSecrets(skill: SkillPackage): string[] {
  return skill.permissions.secrets;
}
