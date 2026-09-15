import { ChatProvider } from './types';

export function providerChatId(provider: ChatProvider, nativeChatId: string): string {
  return `${provider}:${nativeChatId}`;
}

export function nativeChatId(provider: ChatProvider, chatId: string): string {
  const prefix = `${provider}:`;
  if (!chatId.startsWith(prefix)) throw new Error(`Chat ID does not belong to ${provider}`);
  return chatId.slice(prefix.length);
}
