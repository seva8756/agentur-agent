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
import { maybeUpdateMood } from './moodUpdate';
import { persistIncomingAttachments } from '../memory/attachmentStore';
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
import { ChatMessage } from './types';

const REPLY_QUOTE_MAX_CHARS = 4096;

export type RouterDeps = {
  config: AppConfig;
  botUsername: string;
  store: FileStore;
  llm: LlmAdapter;
  tools: ToolRegistry;
  trustedSkills?: TrustedSkillPromptInfo[];
  mcp?: McpManager;
  scheduler: AgentScheduler;
  onReplyExpected?: () => void;
};

export async function routeMessage(message: ChatMessage, deps: RouterDeps): Promise<SkillRunResult | null> {
  if (deps.config.chatAllowedIds.length > 0 && !deps.config.chatAllowedIds.includes(message.chatId)) {
    logger.debug('Ignoring message from non-allowed chat');
    return null;
  }
  logger.info('Received chat message', { provider: message.provider, chatId: message.chatId, chatType: message.chatType, messageId: message.messageId });

  const settings = await readChatSettings(deps.store, deps.config.defaultLocale);
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

  // Build the LLM text once: stripped input plus quoted-message context.
  const strippedText = stripBotAddress(message.text, deps.botUsername);
  const llmInput = buildLlmInput(message, strippedText);

  if (isCommand) {
    deps.onReplyExpected?.();
    return textSkillResult(await handleAgentCommand(message.text, {
      store: deps.store,
      config: deps.config,
      scheduler: deps.scheduler,
      llm: deps.llm,
      mcp: deps.mcp,
    }));
  }

  if (skillMatch) {
    deps.onReplyExpected?.();
    const skillReply = await runSkillTool(deps.store, skillMatch.skill, skillMatch.toolName, {}, message, {
      httpAllowedOrigins: deps.config.skillHttpAllowedOrigins,
      httpBlockedHosts: deps.config.httpBlockedHosts,
      httpAllowedPrivateHosts: deps.config.httpAllowedPrivateHosts,
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
      // Smart mode needs the quoted context as well.
      const smart = await decideSmartReply(deps.store, { ...message, text: llmInput }, deps.llm);
      if (smart.shouldReply) {
        logger.info('Replying to message', { chatId: message.chatId, reason: `smart:${smart.reason}` });
        deps.onReplyExpected?.();
        return createAgentReply(message, llmInput, strippedText, deps, settings.locale);
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

  deps.onReplyExpected?.();
  return createAgentReply(message, llmInput, strippedText, deps, settings.locale);
}

function buildLlmInput(message: ChatMessage, strippedText: string): string {
  const quote = message.quotedMessage ? (() => {
    const { text, authorName } = message.quotedMessage!;
    const truncated = text.length > REPLY_QUOTE_MAX_CHARS ? `${text.slice(0, REPLY_QUOTE_MAX_CHARS)}…` : text;
    const attribution = authorName ? `${authorName}: ` : '';
    return `[quoted message: ${attribution}"${truncated}"]`;
  })() : undefined;
  const quotedImageHint = message.quotedImage
    ? '[An image is attached to the quoted message and was provided to the model separately.]'
    : undefined;
  const fileHint = message.attachments?.some((attachment) => attachment.kind === 'file')
    ? '[The text content of the attached file is available through grep_chat in /chat/attachments.]'
    : undefined;
  return [quote, quotedImageHint, strippedText, fileHint].filter(Boolean).join('\n');
}

async function createAgentReply(message: ChatMessage, llmInput: string, strippedText: string, deps: RouterDeps, locale: import('../memory/chatSettings').PromptLocale): Promise<SkillRunResult | null> {
  const toolContext: ToolContext = {
    store: deps.store,
    scheduler: deps.scheduler,
    timezone: deps.config.agentTimezone,
    locale,
    httpAllowedOrigins: deps.config.skillHttpAllowedOrigins,
    httpBlockedHosts: deps.config.httpBlockedHosts,
    httpAllowedPrivateHosts: deps.config.httpAllowedPrivateHosts,
    httpTimeoutMs: deps.config.skillHttpTimeoutMs,
    httpMaxRequestBytes: deps.config.skillHttpMaxRequestBytes,
    httpMaxResponseBytes: deps.config.skillHttpMaxResponseBytes,
    currentMessage: { ...message, text: strippedText },
    trustedSkills: deps.trustedSkills ?? [],
    mcp: deps.mcp,
  };
  return generateAgentResult({
    input: llmInput,
    images: [
      ...(message.quotedImage ? [{
        dataUrl: message.quotedImage.dataUrl,
        description: 'This image belongs to the quoted message, not the current request.',
      }] : []),
      ...(message.image ? [{
        dataUrl: message.image.dataUrl,
        description: 'This image belongs to the current user message.',
      }] : []),
    ],
    config: deps.config,
    store: deps.store,
    llm: deps.llm,
    tools: deps.tools,
    toolContext,
  });
}

function shouldCaptureFullChat(config: AppConfig, chatId: string): boolean {
  return config.chatFullCaptureIds.includes('*') || config.chatFullCaptureIds.includes(chatId);
}

async function persistIncomingMessage(message: ChatMessage, deps: RouterDeps, fullCapture: boolean): Promise<void> {
  const attachments = await persistIncomingAttachments(deps.store, message);
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
    attachments,
  });

  const recent = await readRecentMessages(deps.store);
  await maybeUpdateMood(deps.store, deps.llm, recent, deps.config.moodUpdateEveryMessages);

  if (!fullCapture && recent.length >= deps.config.interactionSummaryEveryMessages) {
    const summary = await summarizeAndResetInteractions(deps.store, recent, deps.config.summaryFileMaxChars);
    logger.info('Interaction messages summarized and reset', {
      chatId: message.chatId,
      messageCount: summary?.messageCount ?? recent.length,
    });
    return;
  }

  if (fullCapture) {
    await trimRecentMessages(
      deps.store,
      deps.config.recentMessagesFileLimit,
      deps.config.messagesToSummarizeOnRotation,
      deps.config.summaryFileMaxChars,
    );
  }
}
