import { ToolRegistry } from './registry';
import { createCronJobTool } from './implementations/createCronJob';
import { createMicroSkillDraftTool } from './implementations/createMicroSkillDraft';
import { deleteCronJobTool } from './implementations/deleteCronJob';
import { deleteMicroSkillTool } from './implementations/deleteMicroSkill';
import { disableCronJobTool } from './implementations/disableCronJob';
import { disableMicroSkillTool } from './implementations/disableMicroSkill';
import { enableMicroSkillTool } from './implementations/enableMicroSkill';
import { executeMicroSkillTool } from './implementations/executeMicroSkill';
import { listCronJobsTool } from './implementations/listCronJobs';
import { listMicroSkillsTool } from './implementations/listMicroSkills';
import { rememberFactTool } from './implementations/rememberFact';
import { saveDecisionTool } from './implementations/saveDecision';

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  [
    rememberFactTool,
    saveDecisionTool,
    createMicroSkillDraftTool,
    listMicroSkillsTool,
    executeMicroSkillTool,
    enableMicroSkillTool,
    disableMicroSkillTool,
    deleteMicroSkillTool,
    createCronJobTool,
    listCronJobsTool,
    disableCronJobTool,
    deleteCronJobTool,
  ].forEach((tool) => registry.register(tool));
  return registry;
}
