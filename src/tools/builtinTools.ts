import { ToolRegistry } from './registry';
import { AppConfig } from '../config';
import { McpManager, SdkMcpManager } from '../integrations/mcp/manager';
import { TrustedSkill } from '../skills/trustedTypes';
import { trustedSkillToAgentTools } from '../skills/trustedRuntime';
import { createCronJobTool } from './implementations/createCronJob';
import { createArtifactTool } from './implementations/createArtifact';
import { createSkillPackageTool } from './implementations/createSkillPackage';
import { deleteCronJobTool } from './implementations/deleteCronJob';
import { deleteSkillTool } from './implementations/deleteSkill';
import { disableCronJobTool } from './implementations/disableCronJob';
import { disableSkillTool } from './implementations/disableSkill';
import { enableSkillTool } from './implementations/enableSkill';
import { rollbackSkillTool } from './implementations/rollbackSkill';
import { runSkillToolTool } from './implementations/runSkillTool';
import { readArtifactTool } from './implementations/readArtifact';
import { readAgentDocsTool } from './implementations/readAgentDocs';
import { grepChatTool } from './implementations/grepChat';
import { readChatTool } from './implementations/readChat';
import { readTrustedSkillInstructionsTool } from './implementations/readTrustedSkillInstructions';
import { createSendPayloadTool } from './implementations/sendPayload';
import { listCronJobsTool } from './implementations/listCronJobs';
import { listChatFilesTool } from './implementations/listChatFiles';
import { listSkillPackagesTool } from './implementations/listSkillPackages';
import { rememberFactTool } from './implementations/rememberFact';
import { saveDecisionTool } from './implementations/saveDecision';
import { executeHttpQueryTool } from './implementations/executeHttpQuery';

export function createBuiltinToolRegistry(config?: AppConfig, trustedSkills: TrustedSkill[] = [], mcp?: McpManager): ToolRegistry {
  const registry = new ToolRegistry();
  [
    rememberFactTool,
    saveDecisionTool,
    createArtifactTool,
    readArtifactTool,
    grepChatTool,
    readChatTool,
    listChatFilesTool,
    readAgentDocsTool,
    readTrustedSkillInstructionsTool,
    createSendPayloadTool(config?.telegramSendMaxItems),
    createSkillPackageTool,
    listSkillPackagesTool,
    runSkillToolTool,
    enableSkillTool,
    rollbackSkillTool,
    disableSkillTool,
    deleteSkillTool,
    createCronJobTool,
    listCronJobsTool,
    disableCronJobTool,
    deleteCronJobTool,
    executeHttpQueryTool,
  ].forEach((tool) => registry.register(tool));
  if (config?.mcpEnabled) {
    const mcpManager = mcp ?? new SdkMcpManager(config);
    trustedSkills.flatMap((skill) => trustedSkillToAgentTools({ skill, config, mcp: mcpManager })).forEach((tool) => registry.register(tool));
  }
  return registry;
}
