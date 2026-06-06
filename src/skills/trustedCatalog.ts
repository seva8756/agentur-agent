import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppConfig } from '../config';
import { formatLogError, logger } from '../utils/logger';
import mcpPlugin from '../../skills/catalog/mcp/plugin';
import { TrustedSkill, TrustedSkillManifest, TrustedSkillPromptInfo } from './trustedTypes';

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  title: z.string().min(1),
  whenToUse: z.string().min(1).max(1000).optional(),
  enabled: z.boolean().default(true),
  runtime: z.literal('native'),
  source: z.literal('system'),
  version: z.number().int().positive().default(1),
  triggers: z.array(z.unknown()).default([]),
  tools: z.record(z.object({
    description: z.string().min(1),
    schema: z.record(z.unknown()).optional(),
  })),
  permissions: z.record(z.unknown()).default({}),
  createdAt: z.string(),
});

const plugins = {
  mcp: mcpPlugin,
};

export async function loadTrustedCatalogSkills(config: AppConfig): Promise<TrustedSkill[]> {
  const skills: TrustedSkill[] = [];
  if (config.mcpEnabled) {
    const skill = await loadTrustedSkill('mcp');
    if (skill) skills.push(skill);
  }
  return skills;
}

export function trustedSkillPromptInfo(skills: TrustedSkill[]): TrustedSkillPromptInfo[] {
  return skills.map(({ manifest, skillMd }) => ({ manifest, skillMd }));
}

async function loadTrustedSkill(id: keyof typeof plugins): Promise<TrustedSkill | null> {
  try {
    const base = path.resolve(process.cwd(), 'skills', 'catalog', id);
    const [rawManifest, skillMd] = await Promise.all([
      fs.readFile(path.join(base, 'skill.json'), 'utf8'),
      fs.readFile(path.join(base, 'SKILL.md'), 'utf8').catch(() => ''),
    ]);
    const manifest = manifestSchema.parse(JSON.parse(rawManifest)) as TrustedSkillManifest;
    return {
      manifest,
      skillMd,
      plugin: plugins[id],
    };
  } catch (error) {
    logger.warn(`Could not load trusted skill ${id}`, formatLogError(error));
    return null;
  }
}
