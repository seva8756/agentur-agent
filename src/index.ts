import { ChatRuntimeManager } from './agent/chatRuntime';
import { loadConfig } from './config';
import { createLlmClient } from './llm/client';
import { createBuiltinToolRegistry } from './tools/builtinTools';
import { logger } from './utils/logger';
import { createTelegramBot } from './telegram/bot';
import { sendMarkdown } from './telegram/send';

async function main(): Promise<void> {
  const config = loadConfig();
  const llm = createLlmClient(config);
  const tools = createBuiltinToolRegistry();

  let sendToChat: ((chatId: string, text: string) => Promise<void>) | null = null;
  const runtimeManager = new ChatRuntimeManager(config, llm, tools, async (chatId, text) => {
    if (!sendToChat) throw new Error('Bot is not initialized yet');
    await sendToChat(chatId, text);
  });

  const { bot, botUsername } = await createTelegramBot({ config, runtimeManager });
  sendToChat = async (chatId, text) => {
    await bot.api.sendChatAction(chatId, 'typing').catch((error) => logger.debug('Could not send typing action', error));
    await sendMarkdown(bot, chatId, text);
  };

  await runtimeManager.loadKnownRuntimes();
  logger.info('Starting tiny Telegram agent', {
    mode: config.telegramMultiChat ? 'multi-chat' : 'single-chat',
    chatId: config.telegramAllowedChatId ?? 'all',
    botUsername,
    baseUrl: config.llmBaseUrl,
  });
  await bot.start();
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : 'Fatal startup error', error);
  process.exit(1);
});
