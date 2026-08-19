import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { TELEGRAM_SEND_MAX_ITEMS_LIMIT } from './telegram/sendLimits';
import { validateTimeZone } from './utils/time';

dotenv.config();

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : value.toLowerCase() === 'true'));

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const commaList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_ID: commaList.default(''),
  TELEGRAM_BOT_USERNAME: optionalNonEmpty.transform((v) => v?.replace(/^@/, '')),
  TELEGRAM_FULL_CAPTURE_CHAT_IDS: commaList.default(''),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_SUPPORTS_TOOLS: booleanFromString.default('true'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(1),
  LLM_TOOL_LOOP_RETRIES: z.coerce.number().int().min(0).default(1),
  AGENT_DATA_DIR: z.string().min(1).default('./data'),
  AGENT_TIMEZONE: z.string().min(1).refine(validateTimeZone, 'Invalid IANA timezone').default('Europe/Amsterdam'),
  AGENT_MAX_TOOL_STEPS: z.coerce.number().int().positive().default(6),
  TELEGRAM_IMAGE_MAX_BYTES: z.coerce.number().int().positive().default(5242880),
  TELEGRAM_SEND_MAX_ITEMS: z.coerce.number().int().min(1).max(TELEGRAM_SEND_MAX_ITEMS_LIMIT).default(TELEGRAM_SEND_MAX_ITEMS_LIMIT),
  CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().default(50000),
  CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(30000),
  REPLY_MAX_TOKENS: z.coerce.number().int().positive().default(1400),
  RECENT_MESSAGES_FILE_LIMIT: z.coerce.number().int().positive().default(300),
  MESSAGES_TO_SUMMARIZE_ON_ROTATION: z.coerce.number().int().positive().default(200),
  SUMMARY_FILE_MAX_CHARS: z.coerce.number().int().positive().default(3000),
  MOOD_UPDATE_EVERY_MESSAGES: z.coerce.number().int().positive().default(20),
  INTERACTION_SUMMARY_EVERY_MESSAGES: z.coerce.number().int().positive().default(50),
  SKILL_HTTP_ALLOWED_ORIGINS: commaList.default(''),
  SKILL_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  SKILL_HTTP_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(131072),
  SKILL_HTTP_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(1048576),
  MCP_ENABLED: booleanFromString.default('false'),
  MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  MCP_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(262144),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const v = parsed.data;
  return {
    telegramBotToken: v.TELEGRAM_BOT_TOKEN,
    telegramAllowedChatIds: v.TELEGRAM_ALLOWED_CHAT_ID,
    telegramBotUsername: v.TELEGRAM_BOT_USERNAME,
    telegramMultiChat: v.TELEGRAM_ALLOWED_CHAT_ID.length !== 1,
    telegramFullCaptureChatIds: v.TELEGRAM_FULL_CAPTURE_CHAT_IDS,
    llmBaseUrl: v.LLM_BASE_URL,
    llmApiKey: v.LLM_API_KEY,
    llmModel: v.LLM_MODEL,
    llmSupportsTools: v.LLM_SUPPORTS_TOOLS,
    llmTimeoutMs: v.LLM_TIMEOUT_MS,
    llmMaxRetries: v.LLM_MAX_RETRIES,
    llmToolLoopRetries: v.LLM_TOOL_LOOP_RETRIES,
    agentDataDir: path.resolve(v.AGENT_DATA_DIR),
    agentTimezone: v.AGENT_TIMEZONE,
    agentMaxToolSteps: v.AGENT_MAX_TOOL_STEPS,
    telegramImageMaxBytes: v.TELEGRAM_IMAGE_MAX_BYTES,
    telegramSendMaxItems: v.TELEGRAM_SEND_MAX_ITEMS,
    contextWindowTokens: v.CONTEXT_WINDOW_TOKENS,
    contextBudgetTokens: v.CONTEXT_BUDGET_TOKENS,
    replyMaxTokens: v.REPLY_MAX_TOKENS,
    recentMessagesFileLimit: v.RECENT_MESSAGES_FILE_LIMIT,
    messagesToSummarizeOnRotation: v.MESSAGES_TO_SUMMARIZE_ON_ROTATION,
    summaryFileMaxChars: v.SUMMARY_FILE_MAX_CHARS,
    moodUpdateEveryMessages: v.MOOD_UPDATE_EVERY_MESSAGES,
    interactionSummaryEveryMessages: v.INTERACTION_SUMMARY_EVERY_MESSAGES,
    skillHttpAllowedOrigins: v.SKILL_HTTP_ALLOWED_ORIGINS,
    skillHttpTimeoutMs: v.SKILL_HTTP_TIMEOUT_MS,
    skillHttpMaxRequestBytes: v.SKILL_HTTP_MAX_REQUEST_BYTES,
    skillHttpMaxResponseBytes: v.SKILL_HTTP_MAX_RESPONSE_BYTES,
    mcpEnabled: v.MCP_ENABLED,
    mcpTimeoutMs: v.MCP_TIMEOUT_MS,
    mcpMaxResponseBytes: v.MCP_MAX_RESPONSE_BYTES,
  };
}
