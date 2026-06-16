import { z } from 'zod';
import { createBase64Artifact, createTextArtifact } from '../../memory/artifactStore';
import { AgentTool } from '../types';

const argsSchema = z.object({
  filename: z.string().min(1).max(120).describe('Filename to show to the user, for example index.html'),
  mimeType: z.string().min(1).max(120).describe('IANA media type, for example text/html or image/png'),
  text: z.string().optional().describe('UTF-8 text content for text-like artifacts'),
  base64: z.string().optional().describe('Base64 encoded binary content for non-text artifacts'),
}).refine((value) => (value.text !== undefined) !== (value.base64 !== undefined), 'provide exactly one of text or base64');

export const createArtifactTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'create_artifact',
  description: 'Create a chat-local file artifact from UTF-8 text or base64 content. Returns metadata and an artifactId.',
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
