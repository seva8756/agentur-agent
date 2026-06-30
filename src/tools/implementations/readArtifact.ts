import { z } from 'zod';
import { readArtifactMeta, readArtifactText } from '../../memory/artifactStore';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  artifactId: z.string().min(1).describe(TOOL_PROMPTS.readArtifact.artifactId),
  mode: z.enum(['meta', 'text']).default('text').describe(TOOL_PROMPTS.readArtifact.mode),
});

export const readArtifactTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'read_artifact',
  description: TOOL_PROMPTS.readArtifact.description,
  schema: argsSchema,
  execute: async (args, context) => {
    if (args.mode === 'meta') {
      const meta = await readArtifactMeta(context.store, args.artifactId);
      return JSON.stringify({ ok: true, artifact: meta });
    }
    const result = await readArtifactText(context.store, args.artifactId);
    return JSON.stringify({
      ok: true,
      artifact: result.meta,
      text: result.text,
      truncated: result.truncated,
    });
  },
};
