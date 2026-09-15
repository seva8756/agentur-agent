import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const AGENT_DOCS_MAX_CHARS = 12_000;

export const readAgentDocsTool: AgentTool<Record<string, never>> = {
  name: 'read_agent_docs',
  description: TOOL_PROMPTS.readAgentDocs.description,
  schema: z.object({}),
  execute: async () => {
    const filename = path.resolve(process.cwd(), 'src', 'prompts', 'docs', 'agent-capabilities.md');
    const content = await fs.readFile(filename, 'utf8');
    if (content.length <= AGENT_DOCS_MAX_CHARS) return content;
    return `${content.slice(0, AGENT_DOCS_MAX_CHARS).trimEnd()}\n\n[Documentation truncated]`;
  },
};
