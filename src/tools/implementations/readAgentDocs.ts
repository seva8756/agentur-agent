import { z } from 'zod';
import { readChatSettings } from '../../memory/chatSettings';
import { agentCapabilitiesDoc } from '../../prompts/docs';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { AgentTool } from '../types';

const AGENT_DOCS_MAX_CHARS = 12_000;

export const readAgentDocsTool: AgentTool<Record<string, never>> = {
  name: 'read_agent_docs',
  description: TOOL_PROMPTS.readAgentDocs.description,
  schema: z.object({}),
  execute: async (_args, context) => {
    const locale = context.locale ?? (await readChatSettings(context.store)).locale;
    const content = await agentCapabilitiesDoc(locale);
    if (content.length <= AGENT_DOCS_MAX_CHARS) return content;
    return `${content.slice(0, AGENT_DOCS_MAX_CHARS).trimEnd()}\n\n[Documentation truncated]`;
  },
};
