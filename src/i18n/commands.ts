import type { PromptLocale } from '../memory/chatSettings';
import { commands as en } from './en/commands';
import { commands as ru } from './ru/commands';

export type CommandMessages = {
  [Key in keyof typeof ru]: typeof ru[Key] extends (...args: infer Args) => unknown
    ? (...args: Args) => string
    : string;
};

export function commandMessages(locale: PromptLocale): CommandMessages {
  return locale === 'en' ? en : ru;
}
