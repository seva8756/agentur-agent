import { Bot, Context } from 'grammy';
import { AppConfig } from '../config';
import { ChatRuntimeManager } from '../agent/chatRuntime';
import { decideReply } from '../agent/replyPolicy';
import { isLlmContextLengthError } from '../llm/errors';
import { appendRecentMessage, readRecentMessages } from '../memory/recentMessages';
import type { RecentAttachment } from '../memory/recentMessages';
import { summarizeAndResetInteractions } from '../memory/interactionSummary';
import { IDENTITY_MAX_CHARS, IdentityTooLongError, writeIdentity } from '../memory/identity';
import { ConversationQueue } from '../messaging/conversationQueue';
import { buildPhotoDownloadFailureUserPrompt } from '../prompts/catalog';
import { logger } from '../utils/logger';
import { routeMessage } from './messageRouter';
import { replyMarkdown, replySkillResult } from './send';
import { ChatMessage } from './telegramTypes';

type TelegramBotParams = {
  config: AppConfig;
  runtimeManager: ChatRuntimeManager;
  messageQueue: ConversationQueue;
};

export async function createTelegramBot(params: TelegramBotParams): Promise<{ bot: Bot; botUsername: string }> {
  const bot = new Bot(params.config.telegramBotToken);
  const me = await bot.api.getMe();
  const botUsername = params.config.telegramBotUsername ?? me.username;

  bot.use((ctx, next) => {
    if (!ctx.chat) return next();
    void params.messageQueue.enqueue(String(ctx.chat.id), next).catch((error) => {
      logger.error('Could not process Telegram update', error);
    });
  });

  bot.on('message:text', async (ctx) => {
    const message = toChatMessage(ctx, botUsername);
    if (!message) return;

    // Если это команда установки секрета, ПЫТАЕМСЯ удалить сообщение пользователя в группе
    // (работает, если бот является администратором с правами на удаление сообщений)
    if (/^\/agentur(?:@\w+)?\s+secret\s+set\b/i.test(message.text.trim()) && ctx.chat?.type !== 'private') {
      await ctx.deleteMessage().catch((err) => {
        logger.debug('Could not delete secret set message (missing admin rights?)', err);
      });
    }

    await handleIncomingChatMessage(ctx, message, botUsername, params);
  });
  bot.on('message:photo', async (ctx) => {
    try {
      const message = await toPhotoChatMessage(ctx, botUsername, params.config, bot);
      if (!message) return;
      await handleIncomingChatMessage(ctx, message, botUsername, params);
    } catch (error) {
      logger.warn('Could not process Telegram photo', error);
      const fallback = toPhotoFallbackChatMessage(ctx, botUsername, humanErrorReason(error));
      if (!fallback) {
        await replyMarkdown(ctx, 'Не смог обработать картинку.', ctx.message.message_id, ctx.message.message_thread_id);
        return;
      }
      await handleIncomingChatMessage(ctx, fallback, botUsername, params);
    }
  });
  bot.on('message:document', async (ctx) => {
    const caption = ctx.message.caption?.trim() ?? '';
    if (!/^\/agentur(?:@\w+)?\s+identity\s+set\b/i.test(caption)) {
      const message = toDocumentChatMessage(ctx, botUsername);
      if (!message) return;
      await handleIncomingChatMessage(ctx, message, botUsername, params);
      return;
    }
    const runtime = await params.runtimeManager.getRuntime(String(ctx.message.chat.id));
    if (!runtime) return;
    await ctx.api.sendChatAction(ctx.message.chat.id, 'typing', threadOptions(ctx.message.message_thread_id)).catch((error) =>
      logger.debug('Could not send typing action', error),
    );

    const document = ctx.message.document;
    if (!isIdentityDocument(document.file_name, document.mime_type)) {
      await replyMarkdown(ctx, 'Identity можно задать только `.txt` или `.md` файлом.', ctx.message.message_id, ctx.message.message_thread_id);
      return;
    }
    if (document.file_size && document.file_size > IDENTITY_MAX_CHARS * 4) {
      await replyMarkdown(ctx, `Файл слишком большой. Лимит: ${IDENTITY_MAX_CHARS} символов.`, ctx.message.message_id, ctx.message.message_thread_id);
      return;
    }

    try {
      const text = await downloadTelegramTextFile(
        params.config.telegramBotToken,
        document.file_id,
        IDENTITY_MAX_CHARS * 4,
        bot,
      );
      const saved = await writeIdentity(runtime.store, text, IDENTITY_MAX_CHARS);
      await replyMarkdown(ctx, `Identity сохранена для этого чата (${saved.length} символов).`, ctx.message.message_id, ctx.message.message_thread_id);
    } catch (error) {
      if (error instanceof IdentityTooLongError) {
        await replyMarkdown(ctx, `Identity слишком длинная: ${error.length} символов. Сократи до ${error.maxChars} символов и попробуй снова.`, ctx.message.message_id, ctx.message.message_thread_id);
        return;
      }
      logger.warn('Could not save identity from Telegram document', error);
      await replyMarkdown(ctx, 'Не смог прочитать identity-файл. Проверь, что это UTF-8 `.txt` или `.md`.', ctx.message.message_id, ctx.message.message_thread_id);
    }
  });
  bot.catch((error) => logger.error('Telegram bot error', error));
  return { bot, botUsername };
}

async function handleIncomingChatMessage(
  ctx: Context,
  message: ChatMessage,
  botUsername: string,
  params: TelegramBotParams,
): Promise<void> {
  const runtime = await params.runtimeManager.getRuntime(message.chatId);
  if (!runtime) return;
  const stopTyping = shouldShowTyping(message, botUsername)
    ? startTypingHeartbeat(ctx, message.chatId, message.threadId)
    : () => undefined;

  let reply: Awaited<ReturnType<typeof routeMessage>>;
  try {
    reply = await routeMessage(message, {
      config: params.config,
      botUsername,
      store: runtime.store,
      llm: params.runtimeManager.llm,
      tools: params.runtimeManager.tools,
      trustedSkills: params.runtimeManager.trustedSkills,
      mcp: params.runtimeManager.mcp,
      scheduler: runtime.scheduler,
    });
  } catch (error) {
    logger.error('Could not create Telegram reply', error);
    if (isLlmContextLengthError(error)) {
      await replyMarkdown(
        ctx,
        'Не смог получить ответ от модели: превышен лимит контекста. Попробуй сократить запрос или историю/вложения.',
        ctx.message?.message_id,
        message.threadId,
      );
      return;
    }
    await replyMarkdown(ctx, 'Не смог получить ответ от модели: провайдер не ответил вовремя 😔', ctx.message?.message_id, message.threadId);
    return;
  } finally {
    stopTyping();
  }
  if (!reply || !ctx.message) return;
  const sent = await replySkillResult(ctx, runtime.store, reply, ctx.message.message_id, message.threadId, params.config.telegramSendMaxItems);
  await appendRecentMessage(runtime.store, {
    id: sent.message_id,
    chatId: String(sent.chat.id),
    threadId: message.threadId,
    text: messageTextForMemory(reply),
    date: new Date((sent.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    isBot: true,
    attachments: skillResultAttachmentsForMemory(reply),
  });
  const recent = await readRecentMessages(runtime.store);
  if (!params.runtimeManager.isFullCaptureChat(message.chatId) && recent.length >= params.config.interactionSummaryEveryMessages) {
    await summarizeAndResetInteractions(runtime.store, recent, params.config.summaryFileMaxChars);
  }
}

function messageTextForMemory(result: Awaited<ReturnType<typeof routeMessage>>): string {
  if (!result) return '';
  if (result.reply?.trim()) return result.reply.trim();
  if (!result.send?.length) return '';
  return result.send.map((send) => {
    if (send.kind === 'message') return send.text ?? send.caption ?? '';
    return send.caption ?? '';
  }).filter(Boolean).join('\n');
}

function skillResultAttachmentsForMemory(result: Awaited<ReturnType<typeof routeMessage>>): RecentAttachment[] | undefined {
  const attachments = (result?.send ?? []).flatMap((send): RecentAttachment[] => {
    if (send.kind === 'message') return [];
    const artifactId = send.source?.type === 'artifact' ? send.source.artifactId : undefined;
    const url = send.url ?? (send.source?.type === 'url' ? send.source.url : undefined);
    return [{
      kind: send.kind,
      artifactId,
      url,
      filename: send.filename,
    }];
  });
  return attachments.length ? attachments : undefined;
}

function isIdentityDocument(fileName: string | undefined, mimeType: string | undefined): boolean {
  const name = fileName?.toLowerCase() ?? '';
  return name.endsWith('.txt') || name.endsWith('.md') || mimeType === 'text/plain' || mimeType === 'text/markdown';
}

async function downloadTelegramTextFile(
  botToken: string,
  fileId: string,
  maxBytes: number,
  bot: Bot,
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram file_path is empty');
  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('Telegram file exceeds identity byte limit');
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function downloadTelegramImageDataUrl(
  botToken: string,
  fileId: string,
  maxBytes: number,
  bot: Bot,
): Promise<{ dataUrl: string; mimeType: string; sizeBytes: number }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram file_path is empty');
  const mimeType = mimeTypeFromPath(file.file_path);
  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram image download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('Telegram image exceeds byte limit');
  const base64 = Buffer.from(bytes).toString('base64');
  return { dataUrl: `data:${mimeType};base64,${base64}`, mimeType, sizeBytes: bytes.byteLength };
}

function mimeTypeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function shouldShowTyping(message: ChatMessage, botUsername: string): boolean {
  return decideReply(message, botUsername, false).shouldReply;
}

function startTypingHeartbeat(ctx: Context, chatId: string, threadId: number | undefined): () => void {
  let stopped = false;
  const sendTyping = async () => {
    if (stopped) return;
    await ctx.api.sendChatAction(chatId, 'typing', threadOptions(threadId)).catch((error) =>
      logger.debug('Could not send typing action', error),
    );
  };
  void sendTyping();
  const interval = setInterval(() => void sendTyping(), 4000);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function toChatMessage(ctx: Context, botUsername: string): ChatMessage | null {
  const message = ctx.message;
  if (!message || !('text' in message) || !message.text) return null;
  const from = message.from;
  const replyFrom = message.reply_to_message?.from;
  const replyMsg = message.reply_to_message;
  const quotedMessage = (() => {
    if (!replyMsg) return undefined;
    const rawText = ('text' in replyMsg && typeof replyMsg.text === 'string')
      ? replyMsg.text
      : ('caption' in replyMsg && typeof replyMsg.caption === 'string')
        ? replyMsg.caption
        : undefined;
    if (!rawText?.trim()) return undefined;
    const authorName = replyMsg.from
      ? ([replyMsg.from.first_name, replyMsg.from.last_name].filter(Boolean).join(' ') || replyMsg.from.username)
      : undefined;
    return { text: rawText.trim(), authorName };
  })();
  return {
    messageId: message.message_id,
    chatId: String(message.chat.id),
    threadId: message.message_thread_id,
    chatType: message.chat.type,
    fromId: from ? String(from.id) : undefined,
    username: from?.username,
    displayName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username,
    text: message.text,
    date: new Date(message.date * 1000),
    replyToBot: Boolean(replyFrom?.is_bot && replyFrom.username?.toLowerCase() === botUsername.toLowerCase()),
    quotedMessage,
    entities: message.entities,
  };
}

async function toPhotoChatMessage(
  ctx: Context,
  botUsername: string,
  config: AppConfig,
  bot: Bot,
): Promise<ChatMessage | null> {
  const message = ctx.message;
  if (!message || !('photo' in message) || !message.photo?.length) return null;
  const photo = [...message.photo].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  if (!photo) return null;
  if (photo.file_size && photo.file_size > config.telegramImageMaxBytes) {
    throw new Error(`Telegram photo exceeds byte limit: ${photo.file_size}`);
  }
  const image = await downloadTelegramImageDataUrl(
    config.telegramBotToken,
    photo.file_id,
    config.telegramImageMaxBytes,
    bot,
  );
  const from = message.from;
  const replyFrom = message.reply_to_message?.from;
  const caption = message.caption?.trim();
  return {
    messageId: message.message_id,
    chatId: String(message.chat.id),
    threadId: message.message_thread_id,
    chatType: message.chat.type,
    fromId: from ? String(from.id) : undefined,
    username: from?.username,
    displayName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username,
    text: caption ? `[изображение] ${caption}` : '[изображение]',
    image,
    attachments: [{
      kind: 'photo',
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    }],
    date: new Date(message.date * 1000),
    replyToBot: Boolean(replyFrom?.is_bot && replyFrom.username?.toLowerCase() === botUsername.toLowerCase()),
    entities: message.caption_entities,
  };
}

function toDocumentChatMessage(ctx: Context, botUsername: string): ChatMessage | null {
  const message = ctx.message;
  if (!message || !('document' in message) || !message.document) return null;
  const from = message.from;
  const replyFrom = message.reply_to_message?.from;
  const caption = message.caption?.trim();
  const filename = message.document.file_name;
  const label = filename ? `[файл: ${filename}]` : '[файл]';
  return {
    messageId: message.message_id,
    chatId: String(message.chat.id),
    threadId: message.message_thread_id,
    chatType: message.chat.type,
    fromId: from ? String(from.id) : undefined,
    username: from?.username,
    displayName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username,
    text: caption ? `${label} ${caption}` : label,
    attachments: [{
      kind: 'file',
      filename,
      mimeType: message.document.mime_type,
      sizeBytes: message.document.file_size,
    }],
    date: new Date(message.date * 1000),
    replyToBot: Boolean(replyFrom?.is_bot && replyFrom.username?.toLowerCase() === botUsername.toLowerCase()),
    entities: message.caption_entities,
  };
}

function toPhotoFallbackChatMessage(
  ctx: Context,
  botUsername: string,
  reason: string,
): ChatMessage | null {
  const message = ctx.message;
  if (!message || !('photo' in message)) return null;
  const from = message.from;
  const replyFrom = message.reply_to_message?.from;
  const caption = message.caption?.trim();
  return {
    messageId: message.message_id,
    chatId: String(message.chat.id),
    threadId: message.message_thread_id,
    chatType: message.chat.type,
    fromId: from ? String(from.id) : undefined,
    username: from?.username,
    displayName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username,
    text: buildPhotoDownloadFailureUserPrompt(caption, reason),
    attachments: [{
      kind: 'photo',
    }],
    date: new Date(message.date * 1000),
    replyToBot: Boolean(replyFrom?.is_bot && replyFrom.username?.toLowerCase() === botUsername.toLowerCase()),
    entities: message.caption_entities,
  };
}

function threadOptions(threadId: number | undefined): { message_thread_id?: number } | undefined {
  return threadId ? { message_thread_id: threadId } : undefined;
}

function humanErrorReason(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? ((error as { error?: { message?: unknown }; message?: unknown }).error?.message ?? (error as { message?: unknown }).message)
    : undefined;
  const message = typeof candidate === 'string' ? candidate : 'unknown error';
  return message
    .replace(/\/mnt\/models\/\S+/g, 'configured model')
    .slice(0, 300);
}
