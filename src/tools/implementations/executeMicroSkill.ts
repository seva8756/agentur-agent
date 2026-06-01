import { z } from 'zod';
import { loadEnabledSkills } from '../../skills/loader';
import { runSkill } from '../../skills/runtime';
import { ChatMessage } from '../../telegram/telegramTypes';
import { AgentTool } from '../types';

const argsSchema = z.object({
  name: z.string().min(1),
  input: z.string().min(1).optional(),
});

export const executeMicroSkillTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'execute_micro_skill',
  description:
    'Execute an enabled micro-skill by name when the user intent matches it. Name can be the stable name/id or the visible title. Use this instead of asking the user to type the skill command.',
  schema: argsSchema,
  execute: async (args, context) => {
    const skills = await loadEnabledSkills(context.store);
    const skill = skills.find((candidate) => sameName(candidate.id, args.name) || sameName(candidate.title, args.name));
    if (!skill) return `Skill ${args.name} not found or not enabled`;
    const message = buildSkillMessage(context.currentMessage, args.input);
    const result = await runSkill(context.store, skill, message, {
      httpAllowedOrigins: context.httpAllowedOrigins ?? [],
      httpTimeoutMs: context.httpTimeoutMs ?? 10000,
      httpMaxRequestBytes: context.httpMaxRequestBytes ?? 131072,
      httpMaxResponseBytes: context.httpMaxResponseBytes ?? 1048576,
    });
    return result ?? `Skill ${skill.id} completed without reply`;
  },
};

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function buildSkillMessage(current: ChatMessage | undefined, input: string | undefined): ChatMessage {
  const text = input?.trim() || current?.text || '';
  return {
    messageId: current?.messageId ?? Date.now(),
    chatId: current?.chatId ?? 'tool',
    chatType: current?.chatType ?? 'private',
    fromId: current?.fromId,
    username: current?.username,
    displayName: current?.displayName,
    text,
    date: current?.date ?? new Date(),
    replyToBot: current?.replyToBot,
    entities: current?.entities,
  };
}
