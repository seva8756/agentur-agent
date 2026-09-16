import { z } from 'zod';
import type { AppConfig } from '../config';
import type { FileStore } from '../memory/fileStore';
import type { ChatMessage } from '../messaging/types';
import type { McpManager, McpServerInfo, McpToolInfo } from '../integrations/mcp/manager';
import type { SkillRunResult } from './result';

export type TrustedSkillManifest = {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  runtime: 'native';
  source: 'system';
  version: number;
  triggers: unknown[];
  tools: Record<string, {
    description: string;
    schema?: Record<string, unknown>;
  }>;
  permissions?: Record<string, unknown>;
  createdAt: string;
};

export type { McpManager, McpServerInfo, McpToolInfo };

export type TrustedSkillContext = {
  config: AppConfig;
  store: FileStore;
  currentMessage?: ChatMessage;
  mcp: McpManager;
};

export type TrustedSkillTool<TArgs = unknown> = {
  schema: z.ZodTypeAny;
  execute: (args: TArgs, context: TrustedSkillContext) => Promise<SkillRunResult>;
};

export type TrustedSkillPlugin = {
  tools: Record<string, TrustedSkillTool<any>>;
};

export type TrustedSkill = {
  manifest: TrustedSkillManifest;
  skillMd: string;
  plugin: TrustedSkillPlugin;
};

export type TrustedSkillPromptInfo = Pick<TrustedSkill, 'manifest' | 'skillMd'>;
