import { SkillRunResult, hasSkillOutput, textSkillResult } from '../skills/result';
import { CronJobConfig } from './schema';

export type CronRuntimeDeps = {
  sendMessage: (result: SkillRunResult, threadId?: number | null) => Promise<void>;
  askAgent: (prompt: string) => Promise<string>;
  runSkillTool: (skillId: string, toolName: string, args: Record<string, unknown>, text: string, threadId?: number | null) => Promise<SkillRunResult | null>;
};

export async function runCronJob(job: CronJobConfig, deps: CronRuntimeDeps): Promise<void> {
  if (job.action.type === 'send_static_message') {
    await deps.sendMessage(textSkillResult(job.action.text)!, job.threadId);
    return;
  }
  if (job.action.type === 'ask_agent_and_send') {
    const answer = await deps.askAgent(job.action.prompt);
    await deps.sendMessage(textSkillResult(answer)!, job.threadId);
    return;
  }
  const result = await deps.runSkillTool(job.action.skillId, job.action.toolName, job.action.args, job.action.text ?? job.title, job.threadId);
  if (job.action.sendResult && hasSkillOutput(result)) await deps.sendMessage(result, job.threadId);
}
