import { Bot, Context } from 'grammy';
import type { Message } from 'grammy/types';
import { logger } from '../utils/logger';
import { markdownToTelegramHtml } from './formatting';

export async function replyMarkdown(
  ctx: Context,
  text: string,
  replyToMessageId?: number,
): Promise<Message.TextMessage> {
  const html = markdownToTelegramHtml(text);
  try {
    return await ctx.reply(html, {
      parse_mode: 'HTML',
      reply_to_message_id: replyToMessageId,
    });
  } catch (error) {
    logger.warn('Telegram rejected formatted reply, falling back to plain text', error);
    return ctx.reply(text, {
      reply_to_message_id: replyToMessageId,
    });
  }
}

export async function sendMarkdown(bot: Bot, chatId: string, text: string): Promise<Message.TextMessage> {
  const html = markdownToTelegramHtml(text);
  try {
    return await bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
    });
  } catch (error) {
    logger.warn('Telegram rejected formatted message, falling back to plain text', error);
    return bot.api.sendMessage(chatId, text);
  }
}
