import { AppConfig } from '../config';
import { FileStore } from '../memory/fileStore';
import { normalizeSkillRunResultInput, skillRunResultSchema } from './result';
import { McpManager, TrustedSkill } from './trustedTypes';
import { AgentTool, ToolContext } from '../tools/types';

export function trustedSkillToAgentTools(params: {
  skill: TrustedSkill;
  config: AppConfig;
  mcp: McpManager;
}): AgentTool[] {
  return Object.entries(params.skill.plugin.tools).map(([toolName, tool]) => ({
    name: toolName,
    description: params.skill.manifest.tools[toolName]?.description ?? `${params.skill.manifest.title}: ${toolName}`,
    schema: tool.schema,
    execute: async (args, toolContext) => {
      const startedAt = Date.now();
      try {
        const result = skillRunResultSchema.parse(normalizeSkillRunResultInput(await tool.execute(args, {
          config: params.config,
          store: toolContext.store,
          currentMessage: toolContext.currentMessage,
          mcp: params.mcp,
        })));
        await auditTrustedSkillRun(toolContext.store, params.skill.manifest.id, toolName, 'completed', {
          durationMs: Date.now() - startedAt,
          args: summarizeArgs(args),
          hasReply: Boolean(result.reply?.trim()),
          hasData: result.data !== undefined,
          hasSend: Boolean(result.send?.length),
        });
        return JSON.stringify(result);
      } catch (error) {
        await auditTrustedSkillRun(toolContext.store, params.skill.manifest.id, toolName, 'failed', {
          durationMs: Date.now() - startedAt,
          args: summarizeArgs(args),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  }));
}

async function auditTrustedSkillRun(
  store: FileStore,
  skillId: string,
  toolName: string,
  status: 'completed' | 'failed',
  details: unknown,
): Promise<void> {
  await store.appendJsonl({
    skillId,
    toolName,
    status,
    details,
    createdAt: new Date().toISOString(),
  }, 'skills', 'audit', `${skillId}.jsonl`);
}

function summarizeArgs(args: unknown): unknown {
  const text = JSON.stringify(args);
  if (!text || text.length <= 1000) return args;
  return { truncated: true, preview: text.slice(0, 1000) };
}
