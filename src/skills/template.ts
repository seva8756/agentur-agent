import { ChatMessage } from '../messaging/types';
import { MicroSkill } from './schema';

export type TemplateVars = Record<string, unknown>;

export function buildTemplateVars(
  skill: MicroSkill,
  message: ChatMessage,
  extra: TemplateVars = {},
): TemplateVars {
  const item = extractCommandArgs(message.text) || message.text;
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

function extractCommandArgs(text: string): string {
  const trimmed = text.trim();
  const firstSpaceIndex = trimmed.search(/\s/);
  return firstSpaceIndex >= 0 ? trimmed.slice(firstSpaceIndex).trim() : '';
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
