import { z } from 'zod';
import { readArtifactMeta, readArtifactText } from '../../memory/artifactStore';
import { AgentTool } from '../types';

const argsSchema = z.object({
  artifactId: z.string().min(1).describe('Artifact id returned by create_artifact or a skill result'),
  mode: z.enum(['meta', 'text']).default('text').describe('Use meta for binary files or text to read text-like artifacts'),
});

export const readArtifactTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'read_artifact',
  description: 'Read metadata or text content from a chat-local artifact. Binary artifacts support metadata only.',
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
