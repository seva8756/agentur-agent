import { ChatMessage } from '../telegram/telegramTypes';
import { MicroSkill } from './schema';

export function matchSkill(message: ChatMessage, skills: MicroSkill[]): MicroSkill | null {
  const text = message.text.toLowerCase();
  for (const skill of skills) {
    if (!skill.enabled) continue;
    if (skill.trigger.type === 'message_contains') {
      if (skill.trigger.phrases.some((phrase) => text.includes(phrase.toLowerCase()))) return skill;
    }
    if (skill.trigger.type === 'command' && matchesCommand(message.text, skill.trigger.command)) return skill;
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

export function extractItemAfterPhrase(text: string, phrases: string[]): string {
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    const index = lower.indexOf(phrase.toLowerCase());
    if (index >= 0) return text.slice(index + phrase.length).trim().replace(/^[:,-]+\s*/, '');
  }
  return text.trim();
}
