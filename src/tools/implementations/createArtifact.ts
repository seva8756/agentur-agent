import { z } from 'zod';
import { createBase64Artifact, createTextArtifact } from '../../memory/artifactStore';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const argsSchema = z.object({
  filename: z.string().min(1).max(120).describe(TOOL_PROMPTS.createArtifact.filename),
  mimeType: z.string().min(1).max(120).describe(TOOL_PROMPTS.createArtifact.mimeType),
  text: z.string().optional().describe(TOOL_PROMPTS.createArtifact.text),
  base64: z.string().optional().describe(TOOL_PROMPTS.createArtifact.base64),
}).refine((value) => (value.text !== undefined) !== (value.base64 !== undefined), 'provide exactly one of text or base64');

export const createArtifactTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'create_artifact',
  description: TOOL_PROMPTS.createArtifact.description,
  schema: argsSchema,
  execute: async (args, context) => {
    const meta = args.text !== undefined
      ? await createTextArtifact(context.store, {
        filename: args.filename,
        mimeType: args.mimeType,
        text: args.text,
      }, { kind: 'agent' })
      : await createBase64Artifact(context.store, {
        filename: args.filename,
        mimeType: args.mimeType,
        base64: args.base64 ?? '',
      }, { kind: 'agent' });
    return JSON.stringify({ ok: true, artifact: meta });
  },
};
