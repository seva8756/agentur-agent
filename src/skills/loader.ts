import fs from 'node:fs/promises';
import { z } from 'zod';
import { FileStore } from '../memory/fileStore';
import { ChatMessage } from '../messaging/types';
import { formatLogError, logger } from '../utils/logger';
import { skillResultText } from './result';
import { runSkillTool, SkillRuntimeOptions } from './runtime';
import { SkillPackage, skillPackageManifestSchema, skillPackageSchema, skillRollbackManifestSchema } from './schema';
import { validateScriptedSkill } from './scriptSandbox';

export type EnableSkillOptions = Partial<SkillRuntimeOptions> & { dryRunText?: string };

const CUSTOM_SKILLS_DIR = 'custom';

export async function loadSkills(store: FileStore): Promise<SkillPackage[]> {
  const full = store.resolve('skills', CUSTOM_SKILLS_DIR);
  await fs.mkdir(full, { recursive: true });
  const entries = await fs.readdir(full, { withFileTypes: true });
  const skills: SkillPackage[] = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    try {
      skills.push(await readSkillPackage(store, entry.name));
    } catch (error) {
      logger.warn(`Skipping invalid skill package ${entry.name}`, formatLogError(error));
    }
  }
  return skills;
}

export async function loadEnabledSkills(store: FileStore): Promise<SkillPackage[]> {
  const skills = (await loadSkills(store)).filter((skill) => skill.enabled);
  logger.info(`Loaded enabled skill packages: ${skills.length}`);
  return skills;
}

async function readSkillPackage(store: FileStore, id: string): Promise<SkillPackage> {
  const rawManifest = await fs.readFile(store.resolve('skills', CUSTOM_SKILLS_DIR, id, 'skill.json'), 'utf8');
  const manifest = skillPackageManifestSchema.parse(JSON.parse(rawManifest));
  const [skillMd, pluginJs] = await Promise.all([
    fs.readFile(store.resolve('skills', CUSTOM_SKILLS_DIR, id, 'SKILL.md'), 'utf8').catch(() => ''),
    fs.readFile(store.resolve('skills', CUSTOM_SKILLS_DIR, id, 'plugin.js'), 'utf8'),
  ]);
  return { ...manifest, skillMd, pluginJs };
}

async function loadSkillById(store: FileStore, id: string): Promise<SkillPackage | null> {
  try {
    return await readSkillPackage(store, id);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveSkill(store: FileStore, skill: SkillPackage): Promise<SkillPackage> {
  const current = await loadSkillById(store, skill.id);
  const next = current
    ? { ...skill, enabled: current.enabled, createdAt: current.createdAt, version: await nextSkillVersion(store, current) }
    : skill;
  const parsed = skillPackageSchema.parse(next);
  if (current) await saveRevision(store, current);
  await writeSkillPackage(store, parsed);
  return parsed;
}

async function writeSkillPackage(store: FileStore, skill: SkillPackage): Promise<void> {
  const { skillMd, pluginJs, ...manifest } = skill;
  await Promise.all([
    store.writeJson(manifest, 'skills', CUSTOM_SKILLS_DIR, skill.id, 'skill.json'),
    store.writeText(skillMd, 'skills', CUSTOM_SKILLS_DIR, skill.id, 'SKILL.md'),
    store.writeText(pluginJs, 'skills', CUSTOM_SKILLS_DIR, skill.id, 'plugin.js'),
  ]);
}

async function saveRevision(store: FileStore, skill: SkillPackage): Promise<void> {
  await clearRevisions(store, skill.id);
  const { skillMd, pluginJs, ...manifest } = skill;
  const snapshot = skillRollbackManifestSchema.parse(manifest);
  await Promise.all([
    store.writeJson(snapshot, 'skills', CUSTOM_SKILLS_DIR, skill.id, 'revisions', revisionDirName(skill.version), 'snapshot.json'),
    store.writeText(skillMd, 'skills', CUSTOM_SKILLS_DIR, skill.id, 'revisions', revisionDirName(skill.version), 'SKILL.md'),
    store.writeText(pluginJs, 'skills', CUSTOM_SKILLS_DIR, skill.id, 'revisions', revisionDirName(skill.version), 'plugin.js'),
  ]);
}

async function loadRevision(store: FileStore, current: SkillPackage): Promise<SkillPackage | null> {
  const version = (await listRevisions(store, current.id))[0];
  if (!version) return null;
  const snapshot = await store.readJson(z.union([skillRollbackManifestSchema, z.null()]), null, 'skills', CUSTOM_SKILLS_DIR, current.id, 'revisions', revisionDirName(version), 'snapshot.json');
  if (!snapshot) return null;
  const [skillMd, pluginJs] = await Promise.all([
    store.readText('', 'skills', CUSTOM_SKILLS_DIR, current.id, 'revisions', revisionDirName(version), 'SKILL.md'),
    store.readText('', 'skills', CUSTOM_SKILLS_DIR, current.id, 'revisions', revisionDirName(version), 'plugin.js'),
  ]);
  if (!pluginJs) return null;
  return skillPackageSchema.parse({
    ...current,
    ...snapshot,
    enabled: current.enabled,
    createdAt: current.createdAt,
    version,
    skillMd,
    pluginJs,
  });
}

async function nextSkillVersion(store: FileStore, current: SkillPackage): Promise<number> {
  const revisions = await listRevisions(store, current.id);
  return Math.max(current.version, ...revisions) + 1;
}

async function listRevisions(store: FileStore, skillId: string): Promise<number[]> {
  try {
    const entries = await fs.readdir(store.resolve('skills', CUSTOM_SKILLS_DIR, skillId, 'revisions'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
      .map((entry) => Number(entry.name.slice(1)))
      .filter((version) => Number.isSafeInteger(version) && version > 0)
      .sort((a, b) => b - a);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function clearRevisions(store: FileStore, skillId: string): Promise<void> {
  const revisions = await listRevisions(store, skillId);
  await Promise.all(revisions.map((version) => fs.rm(store.resolve('skills', CUSTOM_SKILLS_DIR, skillId, 'revisions', revisionDirName(version)), { recursive: true, force: true })));
}

function revisionDirName(version: number): string {
  return `v${version}`;
}

export async function resolveSkillName(store: FileStore, name: string): Promise<string | null> {
  return findSkill(await loadSkills(store), name)?.id ?? null;
}

export async function enableSkill(store: FileStore, name: string, options: EnableSkillOptions = {}): Promise<SkillPackage | null> {
  const skill = findSkill(await loadSkills(store), name);
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
  await writeSkillPackage(store, next);
  return next;
}

export async function disableSkill(store: FileStore, name: string): Promise<boolean> {
  const skill = findSkill(await loadSkills(store), name);
  if (!skill || !skill.enabled) return false;
  await writeSkillPackage(store, { ...skill, enabled: false });
  return true;
}

export async function rollbackSkill(store: FileStore, name: string): Promise<SkillPackage | null> {
  const current = findSkill(await loadSkills(store), name);
  if (!current) return null;
  const revision = await loadRevision(store, current);
  if (!revision) return null;
  const validation = validateScriptedSkill(revision);
  if (validation.length) throw new Error(`Previous skill version is invalid: ${validation.join(', ')}`);
  await saveRevision(store, current);
  await writeSkillPackage(store, revision);
  return revision;
}

export async function deleteSkill(store: FileStore, name: string): Promise<boolean> {
  const id = await resolveSkillName(store, name);
  if (!id) return false;
  return removeDirIfExists(store.resolve('skills', CUSTOM_SKILLS_DIR, id));
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
