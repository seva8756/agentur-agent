import { z } from 'zod';
import { readArtifactMeta } from '../../memory/artifactStore';
import { SkillRunResult } from '../../skills/result';
import { AgentTool } from '../types';

const argsSchema = z.object({
  artifactId: z.string().min(1).describe('Artifact id to send'),
  kind: z.enum(['file', 'photo', 'video']).default('file').describe('Telegram payload kind. Use file for documents, HTML, text, PDFs, and other generic files. Never use artifact as kind.'),
  caption: z.string().max(1024).optional(),
  filename: z.string().min(1).max(120).optional(),
});

export const sendArtifactTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'send_artifact',
  description: 'Queue an existing chat-local artifact to be sent to Telegram as a file, photo, or video. Use kind=file for documents, HTML, text, PDFs, and other generic files.',
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
