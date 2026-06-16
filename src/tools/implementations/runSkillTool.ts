import { z } from 'zod';
import { findSkill, loadEnabledSkills } from '../../skills/loader';
import { skillResultText } from '../../skills/result';
import { runSkillTool } from '../../skills/runtime';
import { ChatMessage } from '../../telegram/telegramTypes';
import { AgentTool } from '../types';

const argsSchema = z.object({
  skillId: z.string().min(1).describe('Enabled skill id or visible title'),
  toolName: z.string().min(1).describe('Tool name exposed by the skill'),
  args: z.record(z.unknown()).optional().default({}).describe('Arguments for the skill tool'),
  input: z.string().min(1).optional().describe('Optional input text to expose as ctx.text'),
});

export const runSkillToolTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'run_skill_tool',
  description:
    'Run a tool exposed by an enabled skill. Use this when user intent matches a skill. Returns JSON with ok/reply/data/send/error; data can be used in later tool calls.',
  schema: argsSchema,
  execute: async (args, context) => {
    const skills = await loadEnabledSkills(context.store);
    const skill = findSkill(skills, args.skillId);
    if (!skill) return JSON.stringify({ ok: false, skillId: args.skillId, error: { code: 'skill_not_found_or_disabled', message: 'Skill not found or disabled' } });
    const message = buildSkillMessage(context.currentMessage, args.input);
    const result = await runSkillTool(context.store, skill, args.toolName, args.args, message, {
      httpAllowedOrigins: context.httpAllowedOrigins ?? [],
      httpTimeoutMs: context.httpTimeoutMs ?? 10000,
      httpMaxRequestBytes: context.httpMaxRequestBytes ?? 131072,
      httpMaxResponseBytes: context.httpMaxResponseBytes ?? 1048576,
      mcp: context.mcp,
    });
    if (result?.send) context.outbox?.push(result);
    return JSON.stringify({
      ok: result?.ok ?? true,
      skillId: skill.id,
      title: skill.title,
      toolName: args.toolName,
      reply: skillResultText(result),
      data: result?.data ?? null,
      send: result?.send ?? null,
      error: result?.error ?? null,
    });
  },
};

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
