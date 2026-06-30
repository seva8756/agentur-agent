import { z } from 'zod';
import { findSkill, loadEnabledSkills } from '../../skills/loader';
import { skillResultText } from '../../skills/result';
import { runSkillTool } from '../../skills/runtime';
import { ChatMessage } from '../../telegram/telegramTypes';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  skillId: z.string().min(1).describe(TOOL_PROMPTS.runSkillTool.skillId),
  toolName: z.string().min(1).describe(TOOL_PROMPTS.runSkillTool.toolName),
  args: z.record(z.unknown()).optional().default({}).describe(TOOL_PROMPTS.runSkillTool.args),
  input: z.string().min(1).optional().describe(TOOL_PROMPTS.runSkillTool.input),
});

export const runSkillToolTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'run_skill_tool',
  description: TOOL_PROMPTS.runSkillTool.description,
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
