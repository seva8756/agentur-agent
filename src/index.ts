import { ChatRuntimeManager } from './agent/chatRuntime';
import { loadConfig } from './config';
import { SdkMcpManager } from './integrations/mcp/manager';
import { createLlmClient } from './llm/client';
import { loadTrustedCatalogSkills, trustedSkillPromptInfo } from './skills/trustedCatalog';
import { createBuiltinToolRegistry } from './tools/builtinTools';
import { logger } from './utils/logger';
import { createTelegramAdapter } from './telegram/bot';
import { ConversationQueue } from './messaging/conversationQueue';
import { ChatAdapter } from './messaging/adapter';

async function main(): Promise<void> {
  const config = loadConfig();
  const llm = createLlmClient(config);
  const mcp = config.mcpEnabled ? new SdkMcpManager(config) : undefined;
  const messageQueue = new ConversationQueue();
  const trustedSkills = await loadTrustedCatalogSkills(config);
  const trustedSkillsPrompt = trustedSkillPromptInfo(trustedSkills);
  const tools = createBuiltinToolRegistry(config, trustedSkills, mcp);

  let chatAdapter: ChatAdapter | null = null;
  const runtimeManager = new ChatRuntimeManager(config, llm, tools, async (chatId, store, result, threadId) => {
    if (!chatAdapter) throw new Error('Chat adapter is not initialized yet');
    await chatAdapter.sendResult(chatId, store, result, threadId);
  }, trustedSkillsPrompt, mcp);

  chatAdapter = await createTelegramAdapter({ config, runtimeManager, messageQueue });

  await runtimeManager.loadKnownRuntimes();
  logger.info(`Starting Agentur'a`, {
    adapter: chatAdapter.id,
    mode: config.chatMultiChat ? 'multi-chat' : 'single-chat',
    chatId: config.chatAllowedIds.length ? config.chatAllowedIds.join(', ') : 'all',
    botUsername: chatAdapter.botUsername,
    baseUrl: config.llmBaseUrl,
  });
  await chatAdapter.start();
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : 'Fatal startup error', error);
  process.exit(1);
});
