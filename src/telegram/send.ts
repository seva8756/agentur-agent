import { Bot, Context, InputFile } from 'grammy';
import type { Message, ParseMode } from 'grammy/types';
import { artifactContentPath, readArtifactMeta } from '../memory/artifactStore';
import { FileStore } from '../memory/fileStore';
import { SkillRunResult, skillResultText } from '../skills/result';
import { logger } from '../utils/logger';
import { markdownToTelegramHtml } from './formatting';

const TELEGRAM_MESSAGE_MAX_CHARS = 4096;
const TELEGRAM_CAPTION_MAX_CHARS = 1024;
const TRUNCATED_SUFFIX = '\n\n...[сообщение обрезано]';

export async function replyMarkdown(
  ctx: Context,
  text: string,
  replyToMessageId?: number,
  threadId?: number,
): Promise<Message.TextMessage> {
  const safeText = truncateForTelegram(text, TELEGRAM_MESSAGE_MAX_CHARS);
  const html = markdownToTelegramHtml(safeText);
  try {
    return await callTelegramWithRetry(() => ctx.reply(html, {
      parse_mode: 'HTML',
      reply_to_message_id: replyToMessageId,
      message_thread_id: threadId,
    }));
  } catch (error) {
    logger.warn('Telegram rejected formatted reply, falling back to plain text', error);
    return callTelegramWithRetry(() => ctx.reply(safeText, {
      reply_to_message_id: replyToMessageId,
      message_thread_id: threadId,
    }));
  }
}

export async function sendMarkdown(bot: Bot, chatId: string, text: string, threadId?: number | null): Promise<Message.TextMessage> {
  const safeText = truncateForTelegram(text, TELEGRAM_MESSAGE_MAX_CHARS);
  const html = markdownToTelegramHtml(safeText);
  try {
    return await callTelegramWithRetry(() => bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      message_thread_id: threadId ?? undefined,
    }));
  } catch (error) {
    logger.warn('Telegram rejected formatted message, falling back to plain text', error);
    return callTelegramWithRetry(() => bot.api.sendMessage(chatId, safeText, {
      message_thread_id: threadId ?? undefined,
    }));
  }
}

export async function replySkillResult(
  ctx: Context,
  store: FileStore,
  result: SkillRunResult,
  replyToMessageId?: number,
  threadId?: number,
): Promise<Message> {
  if (result.send) {
    try {
      return await sendTelegramPayload({
        store,
        send: (method, url, options) => ctx.api[method](ctx.chat!.id, url, {
          ...options,
          reply_to_message_id: replyToMessageId,
          message_thread_id: threadId,
        } as never),
        result,
      });
    } catch (error) {
      logger.warn('Telegram rejected skill media reply, falling back to text', error);
      return replyMarkdown(ctx, fallbackSkillText(result), replyToMessageId, threadId);
    }
  }
  return replyMarkdown(ctx, skillResultText(result) ?? '', replyToMessageId, threadId);
}

export async function sendSkillResult(bot: Bot, store: FileStore, chatId: string, result: SkillRunResult, threadId?: number | null): Promise<Message> {
  if (result.send) {
    try {
      return await sendTelegramPayload({
        store,
        send: (method, url, options) => bot.api[method](chatId, url, {
          ...options,
          message_thread_id: threadId ?? undefined,
        } as never),
        result,
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
  const sourceText = result.send && result.send.kind !== 'message'
    ? result.send.url
      ?? (result.send.source?.type === 'url' ? result.send.source.url : undefined)
      ?? (result.send.source?.type === 'artifact' ? result.send.source.artifactId : undefined)
    : undefined;
  return [text, sourceText].filter(Boolean).join('\n') || 'Готово.';
}

async function sendTelegramPayload(params: {
  store: FileStore;
  result: SkillRunResult;
  send: (
    method: 'sendPhoto' | 'sendDocument' | 'sendVideo',
    input: string | InputFile,
    options: Record<string, unknown>,
  ) => Promise<Message>;
}): Promise<Message> {
  const { send } = params.result;
  if (!send) throw new Error('Missing send payload');
  if (send.kind === 'message') {
    throw new Error('Message payload should be sent as text');
  }
  const caption = send.caption ?? params.result.reply ?? undefined;
  const safeCaption = caption ? truncateForTelegram(caption, TELEGRAM_CAPTION_MAX_CHARS) : undefined;
  const options = {
    caption: safeCaption ? markdownToTelegramHtml(safeCaption) : undefined,
    parse_mode: safeCaption ? 'HTML' as ParseMode : undefined,
  };
  const input = await resolveTelegramInput(params.store, send);
  if (send.kind === 'photo') return callTelegramWithRetry(() => params.send('sendPhoto', input, options));
  if (send.kind === 'file') return callTelegramWithRetry(() => params.send('sendDocument', input, options));
  return callTelegramWithRetry(() => params.send('sendVideo', input, options));
}

async function resolveTelegramInput(
  store: FileStore,
  send: Exclude<SkillRunResult['send'], undefined>,
): Promise<string | InputFile> {
  if (send.kind === 'message') throw new Error('Message payload should be sent as text');
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
  const candidate = error as { status?: unknown; error?: { status?: unknown } } | undefined;
  const status = candidate?.status ?? candidate?.error?.status;
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
