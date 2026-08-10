import { ChatRuntimeManager } from './agent/chatRuntime';
import { loadConfig } from './config';
import { SdkMcpManager } from './integrations/mcp/manager';
import { createLlmClient } from './llm/client';
import { loadTrustedCatalogSkills, trustedSkillPromptInfo } from './skills/trustedCatalog';
import { createBuiltinToolRegistry } from './tools/builtinTools';
import { logger } from './utils/logger';
import { createTelegramBot } from './telegram/bot';
import { sendSkillResult } from './telegram/send';
import { SkillRunResult } from './skills/result';
import { FileStore } from './memory/fileStore';
import { ConversationQueue } from './messaging/conversationQueue';

async function main(): Promise<void> {
  const config = loadConfig();
  const llm = createLlmClient(config);
  const mcp = config.mcpEnabled ? new SdkMcpManager(config) : undefined;
  const messageQueue = new ConversationQueue();
  const trustedSkills = await loadTrustedCatalogSkills(config);
  const trustedSkillsPrompt = trustedSkillPromptInfo(trustedSkills);
  const tools = createBuiltinToolRegistry(config, trustedSkills, mcp);

  let sendToChat: ((chatId: string, store: FileStore, result: SkillRunResult, threadId?: number | null) => Promise<void>) | null = null;
  const runtimeManager = new ChatRuntimeManager(config, llm, tools, async (chatId, store, result, threadId) => {
    if (!sendToChat) throw new Error('Bot is not initialized yet');
    await sendToChat(chatId, store, result, threadId);
  }, trustedSkillsPrompt, mcp);

  const { bot, botUsername } = await createTelegramBot({ config, runtimeManager, messageQueue });
  sendToChat = async (chatId, store, result, threadId) => {
    await bot.api.sendChatAction(chatId, 'typing', threadOptions(threadId)).catch((error) => logger.debug('Could not send typing action', error));
    await sendSkillResult(bot, store, chatId, result, threadId, config.telegramSendMaxItems);
  };

  await runtimeManager.loadKnownRuntimes();
  logger.info(`Starting Agentur'a`, {
    mode: config.telegramMultiChat ? 'multi-chat' : 'single-chat',
    chatId: config.telegramAllowedChatIds.length ? config.telegramAllowedChatIds.join(', ') : 'all',
    botUsername,
    baseUrl: config.llmBaseUrl,
  });
  await bot.start();
}

function threadOptions(threadId: number | null | undefined): { message_thread_id?: number } | undefined {
  return threadId ? { message_thread_id: threadId } : undefined;
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : 'Fatal startup error', error);
  process.exit(1);
});
