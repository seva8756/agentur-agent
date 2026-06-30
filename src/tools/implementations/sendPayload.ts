import { z } from 'zod';
import { readArtifactMeta } from '../../memory/artifactStore';
import { FileStore } from '../../memory/fileStore';
import { SKILL_SEND_MAX_ITEMS, SkillRunResult, skillSendSchema } from '../../skills/result';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

export function createSendPayloadTool(maxSendItems = SKILL_SEND_MAX_ITEMS): AgentTool<{ send: z.output<typeof skillSendSchema>[] }> {
  const safeMaxSendItems = Math.max(1, Math.min(SKILL_SEND_MAX_ITEMS, Math.floor(maxSendItems)));
  const argsSchema = z.object({
    send: z.array(skillSendSchema)
      .min(1)
      .max(safeMaxSendItems)
      .describe(TOOL_PROMPTS.sendPayload.send),
  });

  return {
    name: 'send_payload',
    description: `${TOOL_PROMPTS.sendPayload.description} Max items: ${safeMaxSendItems}.`,
    schema: argsSchema,
    execute: async (args, context) => {
      const queuedCount = (context.outbox ?? []).reduce((count, result) => count + (result.send?.length ?? 0), 0);
      if (queuedCount + args.send.length > safeMaxSendItems) {
        throw new Error(`send_payload exceeds configured Telegram item limit: ${queuedCount + args.send.length}/${safeMaxSendItems}`);
      }
      await validateArtifactSources(context.store, args.send);
      const result: SkillRunResult = {
        ok: true,
        send: args.send,
      };
      context.outbox?.push(result);
      return JSON.stringify({ ok: true, send: result.send });
    },
  };
}

export const sendPayloadTool = createSendPayloadTool();

async function validateArtifactSources(store: FileStore, send: z.output<typeof skillSendSchema>[]): Promise<void> {
  for (const item of send) {
    if (item.kind !== 'message' && item.source?.type === 'artifact') {
      await readArtifactMeta(store, item.source.artifactId);
    }
  }
}
