import { ToolRegistry } from './registry';
import { AppConfig } from '../config';
import { McpManager, SdkMcpManager } from '../integrations/mcp/manager';
import { TrustedSkill } from '../skills/trustedTypes';
import { trustedSkillToAgentTools } from '../skills/trustedRuntime';
import { createCronJobTool } from './implementations/createCronJob';
import { createSkillPackageDraftTool } from './implementations/createSkillPackageDraft';
import { deleteCronJobTool } from './implementations/deleteCronJob';
import { deleteMicroSkillTool } from './implementations/deleteMicroSkill';
import { disableCronJobTool } from './implementations/disableCronJob';
import { disableMicroSkillTool } from './implementations/disableMicroSkill';
import { enableMicroSkillTool } from './implementations/enableMicroSkill';
import { runSkillToolTool } from './implementations/runSkillTool';
import { listCronJobsTool } from './implementations/listCronJobs';
import { listSkillPackagesTool } from './implementations/listSkillPackages';
import { rememberFactTool } from './implementations/rememberFact';
import { saveDecisionTool } from './implementations/saveDecision';
import { executeHttpQueryTool } from './implementations/executeHttpQuery';

export function createBuiltinToolRegistry(config?: AppConfig, trustedSkills: TrustedSkill[] = [], mcp?: McpManager): ToolRegistry {
  const registry = new ToolRegistry();
  [
    rememberFactTool,
    saveDecisionTool,
    createSkillPackageDraftTool,
    listSkillPackagesTool,
    runSkillToolTool,
    enableMicroSkillTool,
    disableMicroSkillTool,
    deleteMicroSkillTool,
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
