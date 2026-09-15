import { ChatMessage } from '../messaging/types';
import { SkillPackage } from './schema';

export type SkillMatch = {
  skill: SkillPackage;
  toolName: string;
};

export function matchSkill(message: ChatMessage, skills: SkillPackage[]): SkillMatch | null {
  for (const skill of skills) {
    if (!skill.enabled) continue;
    for (const trigger of skill.triggers) {
      if (trigger.type === 'command' && matchesCommand(message.text, trigger.command)) {
        return { skill, toolName: trigger.tool };
      }
    }
  }
  return null;
}

export function matchesCommand(text: string, command: string): boolean {
  const firstToken = text.trim().split(/\s+/, 1)[0] ?? '';
  return normalizeCommand(firstToken) === normalizeCommand(command);
}

function normalizeCommand(command: string): string {
  return command.trim().toLowerCase().replace(/^\//, '').replace(/@.+$/, '');
}
