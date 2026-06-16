import { AppConfig } from '../config';
import { McpManager } from '../integrations/mcp/manager';
import { generateAgentResult } from '../agent/respond';
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
import { SkillRunResult, textSkillResult } from '../skills/result';
import { runSkillTool } from '../skills/runtime';
import { TrustedSkillPromptInfo } from '../skills/trustedTypes';
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
  trustedSkills?: TrustedSkillPromptInfo[];
  mcp?: McpManager;
  scheduler: AgentScheduler;
};

export async function routeMessage(message: ChatMessage, deps: RouterDeps): Promise<SkillRunResult | null> {
  if (deps.config.telegramAllowedChatIds.length > 0 && !deps.config.telegramAllowedChatIds.includes(message.chatId)) {
    logger.debug('Ignoring message from non-allowed chat');
    return null;
  }
  logger.info('Received chat message', { chatId: message.chatId, chatType: message.chatType, messageId: message.messageId });

  const settings = await readChatSettings(deps.store);
  const enabledSkills = await loadEnabledSkills(deps.store);
  const skillMatch = matchSkill(message, enabledSkills);
  const decision = decideReply(message, deps.botUsername, Boolean(skillMatch));
  const isCommand = /^\/agentur(?:@\w+)?(?:\s|$)/i.test(message.text.trim());
  const fullCapture = shouldCaptureFullChat(deps.config, message.chatId);
  const smartMode = settings.replyMode === 'smart';
  const shouldPersistIncoming = fullCapture || smartMode || isCommand || Boolean(skillMatch) || decision.shouldReply;

  if (shouldPersistIncoming) {
    await persistIncomingMessage(message, deps, fullCapture);
  } else {
    logger.info('Message ignored without storage', { chatId: message.chatId, reason: decision.reason });
  }

  // Один раз строим LLM-текст: stripped + цитата (если это reply).
  // Скиллы и команды используют message.text напрямую — им цитата не нужна.
  const strippedText = stripBotAddress(message.text, deps.botUsername);
  const llmInput = buildLlmInput(message, strippedText);

  if (isCommand) {
    return textSkillResult(await handleAgentCommand(message.text, {
      store: deps.store,
      config: deps.config,
      scheduler: deps.scheduler,
      llm: deps.llm,
      mcp: deps.mcp,
    }));
  }

  if (skillMatch) {
    const skillReply = await runSkillTool(deps.store, skillMatch.skill, skillMatch.toolName, {}, message, {
      httpAllowedOrigins: deps.config.skillHttpAllowedOrigins,
      httpTimeoutMs: deps.config.skillHttpTimeoutMs,
      httpMaxRequestBytes: deps.config.skillHttpMaxRequestBytes,
      httpMaxResponseBytes: deps.config.skillHttpMaxResponseBytes,
      mcp: deps.mcp,
      mcpTimeoutMs: deps.config.mcpTimeoutMs,
      mcpMaxResponseBytes: deps.config.mcpMaxResponseBytes,
    });
    if (skillReply) return skillReply;
    logger.info('Matched skill tool completed without reply', { chatId: message.chatId, skillId: skillMatch.skill.id, toolName: skillMatch.toolName });
    return null;
  }

  if (!decision.shouldReply) {
    if (smartMode) {
      // Smart-режим тоже видит цитату — иначе "что это" без контекста непонятно
      const smart = await decideSmartReply(deps.store, { ...message, text: llmInput }, deps.llm);
      if (smart.shouldReply) {
        logger.info('Replying to message', { chatId: message.chatId, reason: `smart:${smart.reason}` });
        return createAgentReply(message, llmInput, strippedText, deps);
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

  return createAgentReply(message, llmInput, strippedText, deps);
}

function buildLlmInput(message: ChatMessage, strippedText: string): string {
  if (!message.quotedMessage) return strippedText;
  const { text, authorName } = message.quotedMessage;
  const MAX_QUOTE = 300;
  const truncated = text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text;
  const attribution = authorName ? `${authorName}: ` : '';
  return `[цитата: ${attribution}"${truncated}"]\n${strippedText}`;
}

async function createAgentReply(message: ChatMessage, llmInput: string, strippedText: string, deps: RouterDeps): Promise<SkillRunResult | null> {
  const toolContext: ToolContext = {
    store: deps.store,
    scheduler: deps.scheduler,
    timezone: deps.config.agentTimezone,
    httpAllowedOrigins: deps.config.skillHttpAllowedOrigins,
    httpTimeoutMs: deps.config.skillHttpTimeoutMs,
    httpMaxRequestBytes: deps.config.skillHttpMaxRequestBytes,
    httpMaxResponseBytes: deps.config.skillHttpMaxResponseBytes,
    currentMessage: { ...message, text: strippedText },
    trustedSkills: deps.trustedSkills ?? [],
    mcp: deps.mcp,
  };
  return generateAgentResult({
    input: llmInput,
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
    threadId: message.threadId,
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
