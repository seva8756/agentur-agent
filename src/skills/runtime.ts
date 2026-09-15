import { FileStore } from '../memory/fileStore';
import { ChatMessage } from '../messaging/types';
import { McpManager } from '../integrations/mcp/manager';
import { SkillRunResult } from './result';
import { runPackageTool } from './scriptSandbox';
import { SkillPackage } from './schema';

export type SkillRuntimeOptions = {
  httpAllowedOrigins: string[];
  httpBlockedHosts: string[];
  httpAllowedPrivateHosts: string[];
  httpTimeoutMs: number;
  httpMaxRequestBytes: number;
  httpMaxResponseBytes: number;
  mcp?: McpManager;
  mcpTimeoutMs?: number;
  mcpMaxResponseBytes?: number;
};

const defaultOptions: SkillRuntimeOptions = {
  httpAllowedOrigins: [],
  httpBlockedHosts: [],
  httpAllowedPrivateHosts: [],
  httpTimeoutMs: 10000,
  httpMaxRequestBytes: 131072,
  httpMaxResponseBytes: 1048576,
  mcpTimeoutMs: 20000,
  mcpMaxResponseBytes: 262144,
};

export async function runSkillTool(
  store: FileStore,
  skill: SkillPackage,
  toolName: string,
  args: Record<string, unknown>,
  message: ChatMessage,
  options: Partial<SkillRuntimeOptions> = {},
): Promise<SkillRunResult | null> {
  if (skill.runtime !== 'quickjs') throw new Error(`Skill runtime is not executable in sandbox runtime: ${skill.runtime}`);
  return runPackageTool(store, skill, toolName, args, message, { ...defaultOptions, ...options });
}

export async function runSkill(
  store: FileStore,
  skill: SkillPackage,
  message: ChatMessage,
  options: Partial<SkillRuntimeOptions> = {},
): Promise<SkillRunResult | null> {
  const toolName = skill.triggers[0]?.tool ?? Object.keys(skill.tools)[0];
  if (!toolName) return null;
  return runSkillTool(store, skill, toolName, {}, message, options);
}
