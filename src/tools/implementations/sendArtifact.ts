import { z } from 'zod';
import { readArtifactMeta } from '../../memory/artifactStore';
import { SkillRunResult } from '../../skills/result';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  artifactId: z.string().min(1).describe(TOOL_PROMPTS.sendArtifact.artifactId),
  kind: z.enum(['file', 'photo', 'video']).default('file').describe(TOOL_PROMPTS.sendArtifact.kind),
  caption: z.string().max(1024).optional(),
  filename: z.string().min(1).max(120).optional(),
});

export const sendArtifactTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'send_artifact',
  description: TOOL_PROMPTS.sendArtifact.description,
  schema: argsSchema,
  execute: async (args, context) => {
    const meta = await readArtifactMeta(context.store, args.artifactId);
    const result: SkillRunResult = {
      ok: true,
      send: {
        kind: args.kind,
        source: { type: 'artifact', artifactId: meta.id },
        caption: args.caption,
        filename: args.filename ?? meta.filename,
      },
    };
    context.outbox?.push(result);
    return JSON.stringify({ ok: true, artifact: meta, send: result.send });
  },
};
