import fs from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '../memory/fileStore';
import { ChatMessage } from '../messaging/types';
import { formatLogError, logger } from '../utils/logger';
import { skillResultText } from './result';
import { runSkillTool, SkillRuntimeOptions } from './runtime';
import { SkillPackage, skillPackageManifestSchema } from './schema';
import { validateScriptedSkill } from './scriptSandbox';

export type EnableSkillOptions = Partial<SkillRuntimeOptions> & {
  dryRunText?: string;
};

async function loadFromDir(store: FileStore, dir: 'drafts' | 'enabled'): Promise<SkillPackage[]> {
  const full = store.resolve('skills', dir);
  await fs.mkdir(full, { recursive: true });
  const entries = await fs.readdir(full, { withFileTypes: true });
  const skills: SkillPackage[] = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    try {
      skills.push(await readSkillPackage(store, dir, entry.name));
    } catch (error) {
      logger.warn(`Skipping invalid skill package ${dir}/${entry.name}`, formatLogError(error));
    }
  }
  return skills;
}

async function readSkillPackage(store: FileStore, dir: 'drafts' | 'enabled', id: string): Promise<SkillPackage> {
  const base = store.resolve('skills', dir, id);
  const rawManifest = await fs.readFile(path.join(base, 'skill.json'), 'utf8');
  const manifest = skillPackageManifestSchema.parse(JSON.parse(rawManifest));
  const [skillMd, pluginJs] = await Promise.all([
    fs.readFile(path.join(base, 'SKILL.md'), 'utf8').catch(() => ''),
    fs.readFile(path.join(base, 'plugin.js'), 'utf8'),
  ]);
  return { ...manifest, skillMd, pluginJs };
}

export async function loadDraftSkills(store: FileStore): Promise<SkillPackage[]> {
  return loadFromDir(store, 'drafts');
}

export async function loadEnabledSkills(store: FileStore): Promise<SkillPackage[]> {
  const skills = await loadFromDir(store, 'enabled');
  logger.info(`Loaded enabled skill packages: ${skills.length}`);
  return skills;
}

export async function saveDraftSkill(store: FileStore, skill: SkillPackage): Promise<void> {
  await writeSkillPackage(store, 'drafts', { ...skill, enabled: false });
}

async function writeSkillPackage(store: FileStore, dir: 'drafts' | 'enabled', skill: SkillPackage): Promise<void> {
  const base = store.resolve('skills', dir, skill.id);
  await fs.mkdir(base, { recursive: true });
  const { skillMd, pluginJs, ...manifest } = skill;
  await Promise.all([
    store.writeJson(manifest, 'skills', dir, skill.id, 'skill.json'),
    store.writeText(skillMd, 'skills', dir, skill.id, 'SKILL.md'),
    store.writeText(pluginJs, 'skills', dir, skill.id, 'plugin.js'),
  ]);
}

export async function resolveSkillName(store: FileStore, name: string): Promise<string | null> {
  const drafts = await loadDraftSkills(store);
  const enabled = await loadEnabledSkills(store);
  const skill = findSkill([...drafts, ...enabled], name);
  return skill?.id ?? null;
}

export async function enableSkill(store: FileStore, name: string, options: EnableSkillOptions = {}): Promise<SkillPackage | null> {
  const drafts = await loadDraftSkills(store);
  const enabled = await loadEnabledSkills(store);
  const skill = findSkill([...drafts, ...enabled], name);
  if (!skill) return null;

  const validation = validateScriptedSkill(skill);
  if (validation.length) throw new Error(`Skill package validation failed: ${validation.join(', ')}`);
  const toolName = skill.triggers[0]?.tool ?? Object.keys(skill.tools)[0];
  if (toolName) {
    const startedAt = Date.now();
    const dryRunReply = await runSkillTool(store, { ...skill, enabled: false }, toolName, {}, buildDryRunMessage(options.dryRunText), options);
    const dryRunText = skillResultText(dryRunReply);
    logger.info('Skill package dry-run completed', {
      skillId: skill.id,
      title: skill.title,
      toolName,
      durationMs: Date.now() - startedAt,
      hasReply: Boolean(dryRunText),
      replyPreview: dryRunText?.slice(0, 200) ?? null,
    });
  }

  const next = { ...skill, enabled: true };
  await writeSkillPackage(store, 'enabled', next);
  return next;
}

export async function disableSkill(store: FileStore, name: string): Promise<boolean> {
  const id = await resolveSkillName(store, name);
  if (!id) return false;
  return removeDirIfExists(store.resolve('skills', 'enabled', id));
}

export async function deleteSkill(store: FileStore, name: string): Promise<boolean> {
  const id = await resolveSkillName(store, name);
  if (!id) return false;
  const results = await Promise.all([
    removeDirIfExists(store.resolve('skills', 'drafts', id)),
    removeDirIfExists(store.resolve('skills', 'enabled', id)),
  ]);
  return results.some(Boolean);
}

export function findSkill(skills: SkillPackage[], name: string): SkillPackage | undefined {
  const normalized = normalizeName(name);
  return skills.find((skill) => normalizeName(skill.id) === normalized || normalizeName(skill.title) === normalized);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

async function removeDirIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.rm(filePath, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function buildDryRunMessage(text = 'test'): ChatMessage {
  return {
    messageId: 0,
    chatId: 'dry-run',
    chatType: 'private',
    fromId: 'dry-run-user',
    username: 'dry_run',
    displayName: 'Dry Run',
    text,
    date: new Date(),
  };
}
