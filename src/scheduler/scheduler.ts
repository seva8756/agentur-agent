import cron, { ScheduledTask } from 'node-cron';
import { FileStore } from '../memory/fileStore';
import { logger } from '../utils/logger';
import { runCronJob, CronRuntimeDeps } from './jobRuntime';
import { CronJobConfig, cronJobsFileSchema } from './schema';

export class AgentScheduler {
  private tasks = new Map<string, ScheduledTask>();

  constructor(
    private readonly store: FileStore,
    private readonly deps: CronRuntimeDeps,
  ) {}

  async load(): Promise<CronJobConfig[]> {
    const file = await this.store.readJson(cronJobsFileSchema, { jobs: [] }, 'cron', 'jobs.json');
    for (const job of file.jobs.filter((j) => j.enabled)) this.register(job);
    logger.info(`Loaded cron jobs: ${file.jobs.length}`);
    return file.jobs;
  }

  register(job: CronJobConfig): void {
    this.stop(job.id);
    const task = cron.schedule(
      job.cron,
      () => {
        runCronJob(job, this.deps).catch((error) => logger.error(`Cron job failed: ${job.id}`, error));
      },
      { timezone: job.timezone },
    );
    this.tasks.set(job.id, task);
  }

  stop(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.stop();
    this.tasks.delete(id);
  }

  async list(): Promise<CronJobConfig[]> {
    return (await this.store.readJson(cronJobsFileSchema, { jobs: [] }, 'cron', 'jobs.json')).jobs;
  }

  async saveDraft(job: CronJobConfig): Promise<void> {
    const jobs = await this.list();
    await this.store.writeJson({ jobs: [...jobs.filter((j) => j.id !== job.id), job] }, 'cron', 'jobs.json');
  }

  async resolveName(name: string): Promise<string | null> {
    const jobs = await this.list();
    return findCronJobByName(jobs, name)?.id ?? null;
  }

  async enable(name: string): Promise<CronJobConfig | null> {
    const jobs = await this.list();
    const job = findCronJobByName(jobs, name);
    if (!job) return null;
    const next = { ...job, enabled: true };
    await this.store.writeJson({ jobs: jobs.map((j) => (j.id === job.id ? next : j)) }, 'cron', 'jobs.json');
    this.register(next);
    return next;
  }

  async disable(name: string): Promise<boolean> {
    const jobs = await this.list();
    const job = findCronJobByName(jobs, name);
    if (!job) return false;
    await this.store.writeJson(
      { jobs: jobs.map((j) => (j.id === job.id ? { ...j, enabled: false } : j)) },
      'cron',
      'jobs.json',
    );
    this.stop(job.id);
    return true;
  }

  async delete(name: string): Promise<boolean> {
    const jobs = await this.list();
    const job = findCronJobByName(jobs, name);
    if (!job) return false;
    await this.store.writeJson({ jobs: jobs.filter((j) => j.id !== job.id) }, 'cron', 'jobs.json');
    this.stop(job.id);
    return true;
  }
}

function findCronJobByName(jobs: CronJobConfig[], name: string): CronJobConfig | undefined {
  const normalized = normalizeName(name);
  return jobs.find((job) => normalizeName(job.id) === normalized || normalizeName(job.title) === normalized);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
