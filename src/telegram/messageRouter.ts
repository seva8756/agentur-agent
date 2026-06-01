import { AppConfig } from '../config';
import { generateAgentReply } from '../agent/respond';
import { decideSmartReply } from '../agent/smartPolicy';
import { decideReply, stripBotAddress } from '../agent/replyPolicy';
import { LlmAdapter } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { readChatSettings } from '../memory/chatSettings';
import { appendRecentMessage, readRecentMessages, trimRecentMessages } from '../memory/recentMessages';
import { summarizeAndResetInteractions } from '../memory/interactionSummary';
import { maybeUpdateMood } from '../memory/moodDiary';
import { AgentScheduler } from '../scheduler/scheduler';
import { loadEnabledSkills } from '../skills/loader';
import { matchSkill } from '../skills/matcher';
import { runSkill } from '../skills/runtime';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../tools/types';
import { logger } from '../utils/logger';
import { handleAgentCommand } from './commands';
import { ChatMessage } from './telegramTypes';

export type RouterDeps = {
  config: AppConfig;
  botUsername: string;
  store: FileStore;
  llm: LlmAdapter;
  tools: ToolRegistry;
  scheduler: AgentScheduler;
};

export async function routeMessage(message: ChatMessage, deps: RouterDeps): Promise<string | null> {
  if (deps.config.telegramAllowedChatId && message.chatId !== deps.config.telegramAllowedChatId) {
    logger.debug('Ignoring message from non-allowed chat');
    return null;
  }
  logger.info('Received chat message', { chatId: message.chatId, chatType: message.chatType, messageId: message.messageId });

  const settings = await readChatSettings(deps.store);
  const enabledSkills = await loadEnabledSkills(deps.store);
  const skill = matchSkill(message, enabledSkills);
  const decision = decideReply(message, deps.botUsername, Boolean(skill));
  const isCommand = /^\/agentur(?:@\w+)?(?:\s|$)/i.test(message.text.trim());
  const fullCapture = shouldCaptureFullChat(deps.config, message.chatId);
  const smartMode = settings.replyMode === 'smart';
  const shouldPersistIncoming = fullCapture || smartMode || isCommand || Boolean(skill) || decision.shouldReply;

  if (shouldPersistIncoming) {
    await persistIncomingMessage(message, deps, fullCapture);
  } else {
    logger.info('Message ignored without storage', { chatId: message.chatId, reason: decision.reason });
  }

  if (isCommand) {
    return handleAgentCommand(message.text, {
      store: deps.store,
      config: deps.config,
      scheduler: deps.scheduler,
      llm: deps.llm,
    });
  }

  if (skill) {
    const skillReply = await runSkill(deps.store, skill, message, {
      httpAllowedOrigins: deps.config.skillHttpAllowedOrigins,
      httpTimeoutMs: deps.config.skillHttpTimeoutMs,
      httpMaxRequestBytes: deps.config.skillHttpMaxRequestBytes,
      httpMaxResponseBytes: deps.config.skillHttpMaxResponseBytes,
    });
    if (skillReply) return skillReply;
    logger.info('Matched skill completed without reply', { chatId: message.chatId, skillId: skill.id });
    return null;
  }

  if (!decision.shouldReply) {
    if (smartMode) {
      const smart = await decideSmartReply(deps.store, message, deps.llm);
      if (smart.shouldReply) {
        logger.info('Replying to message', { chatId: message.chatId, reason: `smart:${smart.reason}` });
        return createAgentReply(message, message.text, deps);
      }
      logger.info('Smart mode stayed silent', { chatId: message.chatId, reason: smart.reason });
    }
    logger.info(shouldPersistIncoming ? 'Message stored without reply' : 'Message skipped without reply', {
      chatId: message.chatId,
      reason: decision.reason,
    });
    return null;
  }
  logger.info('Replying to message', { chatId: message.chatId, reason: decision.reason });

  return createAgentReply(message, stripBotAddress(message.text, deps.botUsername), deps);
}

function createAgentReply(message: ChatMessage, input: string, deps: RouterDeps): Promise<string> {
  const toolContext: ToolContext = {
    store: deps.store,
    scheduler: deps.scheduler,
    timezone: deps.config.agentTimezone,
    httpAllowedOrigins: deps.config.skillHttpAllowedOrigins,
    httpTimeoutMs: deps.config.skillHttpTimeoutMs,
    httpMaxRequestBytes: deps.config.skillHttpMaxRequestBytes,
    httpMaxResponseBytes: deps.config.skillHttpMaxResponseBytes,
    currentMessage: { ...message, text: input },
  };
  return generateAgentReply({
    input,
    image: message.image ? { dataUrl: message.image.dataUrl } : undefined,
    config: deps.config,
    store: deps.store,
    llm: deps.llm,
    tools: deps.tools,
    toolContext,
  });
}

function shouldCaptureFullChat(config: AppConfig, chatId: string): boolean {
  return config.telegramFullCaptureChatIds.includes('*') || config.telegramFullCaptureChatIds.includes(chatId);
}

async function persistIncomingMessage(message: ChatMessage, deps: RouterDeps, fullCapture: boolean): Promise<void> {
  await appendRecentMessage(deps.store, {
    id: message.messageId,
    chatId: message.chatId,
    userId: message.fromId,
    username: message.username,
    displayName: message.displayName,
    text: message.text,
    date: message.date.toISOString(),
    isBot: false,
  });

  const recent = await readRecentMessages(deps.store);
  if (!fullCapture && recent.length >= deps.config.interactionSummaryEveryMessages) {
    const summary = await summarizeAndResetInteractions(deps.store, recent, deps.config.summaryMaxChars);
    logger.info('Interaction messages summarized and reset', {
      chatId: message.chatId,
      messageCount: summary?.messageCount ?? recent.length,
    });
    return;
  }

  if (fullCapture) {
    await maybeUpdateMood(deps.store, recent.map((m) => m.text), deps.config.moodUpdateEveryMessages);
    await trimRecentMessages(
      deps.store,
      deps.config.recentMessagesFileLimit,
      deps.config.messagesToSummarizeOnRotation,
      deps.config.summaryMaxChars,
    );
  }
}
