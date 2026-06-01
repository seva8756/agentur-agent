import fs from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '../memory/fileStore';
import { MicroSkill, microSkillSchema } from './schema';
import { logger } from '../utils/logger';

async function loadFromDir(store: FileStore, dir: 'drafts' | 'enabled'): Promise<MicroSkill[]> {
  const full = store.resolve('skills', dir);
  await fs.mkdir(full, { recursive: true });
  const files = await fs.readdir(full);
  const skills: MicroSkill[] = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const raw = await fs.readFile(path.join(full, file), 'utf8');
      skills.push(microSkillSchema.parse(JSON.parse(raw)));
    } catch (error) {
      logger.warn(`Skipping invalid micro-skill ${dir}/${file}`, error);
    }
  }
  return skills;
}

export async function loadDraftSkills(store: FileStore): Promise<MicroSkill[]> {
  return loadFromDir(store, 'drafts');
}

export async function loadEnabledSkills(store: FileStore): Promise<MicroSkill[]> {
  const skills = await loadFromDir(store, 'enabled');
  logger.info(`Loaded enabled skills: ${skills.length}`);
  return skills;
}

export async function saveDraftSkill(store: FileStore, skill: MicroSkill): Promise<void> {
  await store.writeJson({ ...skill, enabled: false }, 'skills', 'drafts', `${skill.id}.json`);
}

export async function resolveSkillName(store: FileStore, name: string): Promise<string | null> {
  const drafts = await loadDraftSkills(store);
  const enabled = await loadEnabledSkills(store);
  const skill = findSkillByName([...enabled, ...drafts], name);
  return skill?.id ?? null;
}

export async function enableSkill(store: FileStore, name: string): Promise<MicroSkill | null> {
  const drafts = await loadDraftSkills(store);
  const enabled = await loadEnabledSkills(store);
  const skill = findSkillByName([...enabled, ...drafts], name);
  if (!skill) return null;
  const next = { ...skill, enabled: true };
  await store.writeJson(next, 'skills', 'enabled', `${skill.id}.json`);
  return next;
}

export async function disableSkill(store: FileStore, name: string): Promise<boolean> {
  const id = await resolveSkillName(store, name);
  if (!id) return false;
  try {
    await fs.unlink(store.resolve('skills', 'enabled', `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function deleteSkill(store: FileStore, name: string): Promise<boolean> {
  const id = await resolveSkillName(store, name);
  if (!id) return false;
  const results = await Promise.all([
    unlinkIfExists(store.resolve('skills', 'drafts', `${id}.json`)),
    unlinkIfExists(store.resolve('skills', 'enabled', `${id}.json`)),
  ]);
  return results.some(Boolean);
}

function findSkillByName(skills: MicroSkill[], name: string): MicroSkill | undefined {
  const normalized = normalizeName(name);
  return skills.find((skill) => normalizeName(skill.id) === normalized || normalizeName(skill.title) === normalized);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

async function unlinkIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
