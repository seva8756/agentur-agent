import { ChatMessage } from '../telegram/telegramTypes';
import { extractItemAfterPhrase } from './matcher';
import { MicroSkill } from './schema';

export type TemplateVars = Record<string, unknown>;

export function buildTemplateVars(
  skill: MicroSkill,
  message: ChatMessage,
  extra: TemplateVars = {},
): TemplateVars {
  const phrases = skill.trigger.type === 'message_contains' ? skill.trigger.phrases : [];
  const item = extractItemAfterPhrase(message.text, phrases) || message.text;
  return {
    text: message.text,
    item,
    chatId: message.chatId,
    chatType: message.chatType ?? '',
    userId: message.fromId ?? '',
    username: message.username ?? '',
    displayName: message.displayName ?? message.username ?? '',
    isoDate: new Date().toISOString(),
    ...extra,
  };
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = getPath(vars, key);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}
