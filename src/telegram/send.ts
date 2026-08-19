import { Bot, Context, InputFile } from 'grammy';
import type { InputMediaDocument, InputMediaPhoto, InputMediaVideo, Message, ParseMode } from 'grammy/types';
import { artifactContentPath, readArtifactMeta } from '../memory/artifactStore';
import { FileStore } from '../memory/fileStore';
import { SKILL_SEND_MAX_ITEMS, SkillRunResult, SkillSend, skillResultText } from '../skills/result';
import { logger } from '../utils/logger';
import { hasTelegramRichMarkup, markdownToTelegramHtml } from './formatting';

const TELEGRAM_MESSAGE_MAX_CHARS = 4096;
const TELEGRAM_RICH_MESSAGE_MAX_CHARS = 32768;
const TELEGRAM_CAPTION_MAX_CHARS = 1024;
const TRUNCATED_SUFFIX = '\n\n...[сообщение обрезано]';

export async function replyMarkdown(
  ctx: Context,
  text: string,
  replyToMessageId?: number,
  threadId?: number,
): Promise<Message> {
  const replyOptions = {
    reply_to_message_id: replyToMessageId,
    message_thread_id: threadId,
  };
  return sendFormattedTelegramText({
    text,
    sendRich: (markdown) => ctx.replyWithRichMessage({ markdown }, {
      message_thread_id: threadId,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
    }),
    sendHtml: (html) => ctx.reply(html, { parse_mode: 'HTML', ...replyOptions }),
    sendPlain: (plain) => ctx.reply(plain, replyOptions),
  });
}

export async function sendMarkdown(bot: Bot, chatId: string, text: string, threadId?: number | null): Promise<Message> {
  const thread = { message_thread_id: threadId ?? undefined };
  return sendFormattedTelegramText({
    text,
    sendRich: (markdown) => bot.api.sendRichMessage(chatId, { markdown }, thread),
    sendHtml: (html) => bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...thread }),
    sendPlain: (plain) => bot.api.sendMessage(chatId, plain, thread),
  });
}

async function sendFormattedTelegramText(params: {
  text: string;
  sendRich: (markdown: string) => Promise<Message>;
  sendHtml: (html: string) => Promise<Message>;
  sendPlain: (text: string) => Promise<Message>;
}): Promise<Message> {
  const safeText = truncateForTelegram(params.text, TELEGRAM_MESSAGE_MAX_CHARS);
  if (!hasTelegramRichMarkup(params.text)) {
    return callTelegramWithRetry(() => params.sendPlain(safeText));
  }
  const richText = truncateForTelegram(params.text, TELEGRAM_RICH_MESSAGE_MAX_CHARS);
  try {
    return await callTelegramWithRetry(() => params.sendRich(richText));
  } catch (error) {
    if (!isTelegramBadRequest(error)) throw error;
    logger.warn('Telegram rejected rich markdown as a bad request, falling back to HTML', error);
  }
  try {
    return await callTelegramWithRetry(() => params.sendHtml(markdownToTelegramHtml(safeText)));
  } catch (error) {
    if (!isTelegramBadRequest(error)) throw error;
    logger.warn('Telegram rejected HTML formatting as a bad request, falling back to plain text', error);
    return callTelegramWithRetry(() => params.sendPlain(safeText));
  }
}

export async function replySkillResult(
  ctx: Context,
  store: FileStore,
  result: SkillRunResult,
  replyToMessageId?: number,
  threadId?: number,
  maxSendItems = SKILL_SEND_MAX_ITEMS,
): Promise<Message> {
  if (result.send?.length) {
    try {
      return await sendTelegramPayloads({
        store,
        sendMedia: (method, url, options) => ctx.api[method](ctx.chat!.id, url, {
          ...options,
          reply_to_message_id: replyToMessageId,
          message_thread_id: threadId,
        } as never),
        sendMediaGroup: (media, options) => ctx.api.sendMediaGroup(ctx.chat!.id, media as never, {
          ...options,
          reply_to_message_id: replyToMessageId,
          message_thread_id: threadId,
        } as never),
        sendRich: (markdown) => ctx.replyWithRichMessage({ markdown }, {
          message_thread_id: threadId,
          ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
        }),
        sendText: (text, options) => ctx.reply(text, {
          ...options,
          reply_to_message_id: replyToMessageId,
          message_thread_id: threadId,
        } as never),
        result,
        maxSendItems,
      });
    } catch (error) {
      logger.warn('Telegram rejected skill media reply, falling back to text', error);
      return replyMarkdown(ctx, fallbackSkillText(result), replyToMessageId, threadId);
    }
  }
  return replyMarkdown(ctx, skillResultText(result) ?? '', replyToMessageId, threadId);
}

export async function sendSkillResult(
  bot: Bot,
  store: FileStore,
  chatId: string,
  result: SkillRunResult,
  threadId?: number | null,
  maxSendItems = SKILL_SEND_MAX_ITEMS,
): Promise<Message> {
  if (result.send?.length) {
    try {
      return await sendTelegramPayloads({
        store,
        sendMedia: (method, url, options) => bot.api[method](chatId, url, {
          ...options,
          message_thread_id: threadId ?? undefined,
        } as never),
        sendMediaGroup: (media, options) => bot.api.sendMediaGroup(chatId, media as never, {
          ...options,
          message_thread_id: threadId ?? undefined,
        } as never),
        sendRich: (markdown) => bot.api.sendRichMessage(chatId, { markdown }, {
          message_thread_id: threadId ?? undefined,
        }),
        sendText: (text, options) => bot.api.sendMessage(chatId, text, {
          ...options,
          message_thread_id: threadId ?? undefined,
        } as never),
        result,
        maxSendItems,
      });
    } catch (error) {
      logger.warn('Telegram rejected skill media message, falling back to text', error);
      return sendMarkdown(bot, chatId, fallbackSkillText(result), threadId);
    }
  }
  return sendMarkdown(bot, chatId, skillResultText(result) ?? '', threadId);
}

function fallbackSkillText(result: SkillRunResult): string {
  const text = skillResultText(result);
  const sourceTexts = (result.send ?? []).flatMap((send) => {
    if (send.kind === 'message') return [];
    return send.url
      ?? (send.source?.type === 'url' ? send.source.url : undefined)
      ?? (send.source?.type === 'artifact' ? send.source.artifactId : undefined)
      ?? [];
  });
  return [text, ...sourceTexts].filter(Boolean).join('\n') || 'Готово.';
}

type MediaGroupInput = InputMediaPhoto | InputMediaDocument | InputMediaVideo;

type SendTelegramPayloadParams = {
  store: FileStore;
  result: SkillRunResult;
  maxSendItems: number;
  sendMedia: (
    method: 'sendPhoto' | 'sendDocument' | 'sendVideo',
    input: string | InputFile,
    options: Record<string, unknown>,
  ) => Promise<Message>;
  sendMediaGroup: (
    media: MediaGroupInput[],
    options: Record<string, unknown>,
  ) => Promise<Message[]>;
  sendRich: (markdown: string) => Promise<Message>;
  sendText: (text: string, options: Record<string, unknown>) => Promise<Message>;
};

async function sendTelegramPayloads(params: SendTelegramPayloadParams): Promise<Message> {
  assertSendItemLimit(params.result.send, params.maxSendItems);
  const sends = params.result.send;
  if (!sends?.length) throw new Error('Missing send payload');
  let last: Message | undefined;
  for (let index = 0; index < sends.length;) {
    const send = sends[index];
    if (send.kind === 'message') {
      last = await sendTextPayload(params, send, index);
      index += 1;
    } else {
      const group = collectCompatibleMediaGroup(sends, index);
      if (group.length >= 2) {
        last = await sendMediaGroupPayload(params, group, index);
      } else {
        last = await sendMediaPayload(params, send, index);
      }
      index += group.length;
    }
  }
  if (!last) throw new Error('Missing sent Telegram message');
  return last;
}

function assertSendItemLimit(send: SkillRunResult['send'], maxSendItems: number): void {
  if (!send?.length) return;
  const safeMaxSendItems = Math.max(1, Math.min(SKILL_SEND_MAX_ITEMS, Math.floor(maxSendItems)));
  if (send.length > safeMaxSendItems) {
    throw new Error(`Telegram send payload item limit exceeded: ${send.length}/${safeMaxSendItems}`);
  }
}

async function sendTextPayload(
  params: SendTelegramPayloadParams,
  send: Extract<SkillSend, { kind: 'message' }>,
  index: number,
): Promise<Message> {
  const text = send.text ?? send.caption ?? (index === 0 ? params.result.reply : undefined) ?? 'Готово.';
  return sendFormattedTelegramText({
    text,
    sendRich: params.sendRich,
    sendHtml: (html) => params.sendText(html, { parse_mode: 'HTML' as ParseMode }),
    sendPlain: (plain) => params.sendText(plain, {}),
  });
}

async function sendMediaPayload(
  params: SendTelegramPayloadParams,
  send: MediaSend,
  index: number,
): Promise<Message> {
  const caption = send.caption ?? (index === 0 ? params.result.reply : undefined) ?? undefined;
  const safeCaption = caption ? truncateForTelegram(caption, TELEGRAM_CAPTION_MAX_CHARS) : undefined;
  const options = {
    caption: safeCaption ? markdownToTelegramHtml(safeCaption) : undefined,
    parse_mode: safeCaption ? 'HTML' as ParseMode : undefined,
  };
  const input = await resolveTelegramInput(params.store, send);
  if (send.kind === 'photo') return callTelegramWithRetry(() => params.sendMedia('sendPhoto', input, options));
  if (send.kind === 'file') return callTelegramWithRetry(() => params.sendMedia('sendDocument', input, options));
  return callTelegramWithRetry(() => params.sendMedia('sendVideo', input, options));
}

type MediaSend = Extract<SkillSend, { kind: 'photo' | 'file' | 'video' }>;

async function sendMediaGroupPayload(
  params: SendTelegramPayloadParams,
  sends: MediaSend[],
  startIndex: number,
): Promise<Message> {
  const media: MediaGroupInput[] = [];
  for (let offset = 0; offset < sends.length; offset += 1) {
    media.push(await buildMediaGroupInput(params, sends[offset], startIndex + offset));
  }
  const messages = await callTelegramWithRetry(() => params.sendMediaGroup(media, {}));
  const last = messages[messages.length - 1];
  if (!last) throw new Error('Telegram media group returned no messages');
  return last;
}

async function buildMediaGroupInput(
  params: SendTelegramPayloadParams,
  send: MediaSend,
  index: number,
): Promise<MediaGroupInput> {
  const caption = send.caption ?? (index === 0 ? params.result.reply : undefined) ?? undefined;
  const safeCaption = caption ? truncateForTelegram(caption, TELEGRAM_CAPTION_MAX_CHARS) : undefined;
  const captionFields: { caption?: string; parse_mode?: ParseMode } = {};
  if (safeCaption) {
    captionFields.caption = markdownToTelegramHtml(safeCaption);
    captionFields.parse_mode = 'HTML';
  }
  const input = await resolveTelegramInput(params.store, send);
  if (send.kind === 'photo') return { type: 'photo', media: input, ...captionFields };
  if (send.kind === 'file') return { type: 'document', media: input, ...captionFields };
  return { type: 'video', media: input, ...captionFields };
}

function collectCompatibleMediaGroup(sends: SkillSend[], startIndex: number): MediaSend[] {
  const first = sends[startIndex];
  if (!first || first.kind === 'message') return [];
  const key = mediaGroupCompatibilityKey(first);
  const group: MediaSend[] = [];
  for (let index = startIndex; index < sends.length; index += 1) {
    const candidate = sends[index];
    if (candidate.kind === 'message' || mediaGroupCompatibilityKey(candidate) !== key) break;
    group.push(candidate);
  }
  return group;
}

function mediaGroupCompatibilityKey(send: MediaSend): 'document' | 'visual' {
  return send.kind === 'file' ? 'document' : 'visual';
}

async function resolveTelegramInput(
  store: FileStore,
  send: MediaSend,
): Promise<string | InputFile> {
  if (send.source?.type === 'url') return send.source.url;
  if (send.url) return send.url;
  if (send.source?.type === 'artifact') {
    const meta = await readArtifactMeta(store, send.source.artifactId);
    return new InputFile(artifactContentPath(store, meta.id), send.filename ?? meta.filename);
  }
  throw new Error('Media payload has no url or artifact source');
}

export function truncateForTelegram(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - TRUNCATED_SUFFIX.length);
  return `${text.slice(0, budget).trimEnd()}${TRUNCATED_SUFFIX}`;
}

async function callTelegramWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableTelegramError(error)) throw error;
      const delayMs = retryDelayMs(error, attempt);
      logger.warn('Retrying Telegram API call after transient failure', {
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        status: telegramStatus(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function isTelegramBadRequest(error: unknown): boolean {
  return telegramStatus(error) === 400;
}

function isRetryableTelegramError(error: unknown): boolean {
  const status = telegramStatus(error);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

function retryDelayMs(error: unknown, attempt: number): number {
  const retryAfter = telegramRetryAfterSeconds(error);
  if (retryAfter !== undefined) return Math.min(30_000, Math.max(1000, retryAfter * 1000));
  return Math.min(5000, 500 * 2 ** (attempt - 1));
}

function telegramStatus(error: unknown): number | undefined {
  const candidate = error as {
    status?: unknown;
    error_code?: unknown;
    error?: { status?: unknown; error_code?: unknown };
  } | undefined;
  const status = candidate?.error_code
    ?? candidate?.status
    ?? candidate?.error?.error_code
    ?? candidate?.error?.status;
  return typeof status === 'number' ? status : undefined;
}

function telegramRetryAfterSeconds(error: unknown): number | undefined {
  const candidate = error as {
    parameters?: { retry_after?: unknown };
    error?: { parameters?: { retry_after?: unknown } };
  } | undefined;
  const retryAfter = candidate?.parameters?.retry_after ?? candidate?.error?.parameters?.retry_after;
  return typeof retryAfter === 'number' ? retryAfter : undefined;
}
