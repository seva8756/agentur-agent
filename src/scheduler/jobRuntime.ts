import { CronJobConfig } from './schema';

export type CronRuntimeDeps = {
  sendMessage: (text: string) => Promise<void>;
  askAgent: (prompt: string) => Promise<string>;
  runMicroSkill: (skillId: string, text: string) => Promise<string | null>;
};

export async function runCronJob(job: CronJobConfig, deps: CronRuntimeDeps): Promise<void> {
  if (job.action.type === 'send_static_message') {
    await deps.sendMessage(job.action.text);
    return;
  }
  if (job.action.type === 'ask_agent_and_send') {
    const answer = await deps.askAgent(job.action.prompt);
    await deps.sendMessage(answer);
    return;
  }
  const result = await deps.runMicroSkill(job.action.skillId, job.action.text ?? job.title);
  if (job.action.sendResult && result) await deps.sendMessage(result);
}
