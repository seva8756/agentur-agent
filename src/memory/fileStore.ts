import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { formatLogError, logger } from '../utils/logger';

export class FileStore {
  constructor(public readonly rootDir: string) {}

  resolve(...parts: string[]): string {
    const target = path.resolve(this.rootDir, ...parts);
    if (!target.startsWith(this.rootDir)) throw new Error('Path escapes data directory');
    return target;
  }

  async ensureDir(...parts: string[]): Promise<void> {
    await fs.mkdir(this.resolve(...parts), { recursive: true });
  }

  async ensureJson<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    fallback: z.output<TSchema>,
    ...parts: string[]
  ): Promise<z.output<TSchema>> {
    const file = this.resolve(...parts);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      const raw = await fs.readFile(file, 'utf8');
      return schema.parse(JSON.parse(raw));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') logger.warn(`Recovering invalid optional file ${parts.join('/')}`);
      await this.writeJson(fallback, ...parts);
      return fallback;
    }
  }

  async readJson<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    fallback: z.output<TSchema>,
    ...parts: string[]
  ): Promise<z.output<TSchema>> {
    try {
      const raw = await fs.readFile(this.resolve(...parts), 'utf8');
      return schema.parse(JSON.parse(raw));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        logger.debug(`JSON ${parts.join('/')} is missing, using fallback`);
      } else {
        logger.warn(`Could not read JSON ${parts.join('/')}, using fallback`, formatLogError(error));
      }
      return fallback;
    }
  }

  async writeJson(value: unknown, ...parts: string[]): Promise<void> {
    const file = this.resolve(...parts);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temp, file);
  }

  async appendJsonl(value: unknown, ...parts: string[]): Promise<void> {
    const file = this.resolve(...parts);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
  }

  async readJsonl<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    ...parts: string[]
  ): Promise<Array<z.output<TSchema>>> {
    try {
      const raw = await fs.readFile(this.resolve(...parts), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => schema.parse(JSON.parse(line)));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') logger.warn(`Could not read JSONL ${parts.join('/')}`, formatLogError(error));
      return [];
    }
  }

  async writeText(text: string, ...parts: string[]): Promise<void> {
    const file = this.resolve(...parts);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
  }

  async readText(fallback: string, ...parts: string[]): Promise<string> {
    try {
      return await fs.readFile(this.resolve(...parts), 'utf8');
    } catch {
      return fallback;
    }
  }
}

export async function initializeDataDir(store: FileStore): Promise<void> {
  await Promise.all([
    store.ensureDir('chat', 'archive'),
    store.ensureDir('chat', 'lists'),
    store.ensureDir('skills', 'drafts'),
    store.ensureDir('skills', 'enabled'),
    store.ensureDir('artifacts'),
    store.ensureDir('integrations', 'mcp'),
    store.ensureDir('cron'),
  ]);
  await store.ensureJson(z.array(z.any()), [], 'chat', 'facts.json');
  await store.ensureJson(z.array(z.any()), [], 'chat', 'decisions.json');
  await store.ensureJson(z.object({ jobs: z.array(z.any()) }), { jobs: [] }, 'cron', 'jobs.json');
  await store.writeText(await store.readText('', 'chat', 'summary.md'), 'chat', 'summary.md');
  await store.ensureJson(
    z.object({ warmth: z.number(), tension: z.number(), humor: z.number(), updatedAt: z.string() }),
    { warmth: 0.5, tension: 0.1, humor: 0.2, updatedAt: new Date().toISOString() },
    'chat', 'mood.json',
  );
}
