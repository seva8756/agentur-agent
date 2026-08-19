import { AppConfig } from '../config';
import { isLlmContextLengthError } from '../llm/errors';
import type { LlmAdapter, LlmContextBudget } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { SkillRunResult, skillResultText, textSkillResult } from '../skills/result';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../tools/types';
import { formatLogError, logger } from '../utils/logger';
import { buildChatContext } from './context';
import type { ContextAllocation } from './context';
import { limitOutput } from './outputLimiter';
import {
  buildContextLimitFallbackNotice,
  buildImageInputFailureUserPrompt,
} from '../prompts/catalog';

export async function generateAgentReply(params: {
  input: string;
  image?: {
    dataUrl: string;
  };
  config: AppConfig;
  store: FileStore;
  llm: LlmAdapter;
  tools: ToolRegistry;
  toolContext: ToolContext;
}): Promise<string> {
  return skillResultText(await generateAgentResult(params)) ?? '';
}

export async function generateAgentResult(params: {
  input: string;
  image?: {
    dataUrl: string;
  };
  config: AppConfig;
  store: FileStore;
  llm: LlmAdapter;
  tools: ToolRegistry;
  toolContext: ToolContext;
}): Promise<SkillRunResult | null> {
  const outbox: SkillRunResult[] = [];
  const toolContext = { ...params.toolContext, outbox };
  const context = await buildChatContext(params.store, params.input, {
    contextWindowTokens: params.config.contextWindowTokens,
    contextBudgetTokens: params.config.contextBudgetTokens,
    replyMaxTokens: params.config.replyMaxTokens,
    timezone: params.config.agentTimezone,
    currentThreadId: toolContext.currentMessage?.threadId,
    trustedSkills: params.toolContext.trustedSkills ?? [],
  });
  logger.info('LLM context budget', formatContextAllocationLog(context.allocation));
  const messages = attachImageToLastUserMessage(context.messages, params.image?.dataUrl);
  const text = await chatWithFallbacks(
    { ...params, toolContext },
    messages,
    { allocation: context.allocation, policy: context.policy },
  );
  const modelReply = text.trim() ? limitOutput(text, replyCharsFallback(params.config.replyMaxTokens)) : '';
  const queuedSend = outbox.flatMap((result) => result.send ?? []);
  if (queuedSend.length) {
    const queued = outbox.at(-1);
    const result = {
      ...(queued ?? { ok: true }),
      send: queuedSend,
      reply: modelReply || queued?.reply,
    };
    return withModelMediaCaption(result, modelReply);
  }
  const reply = modelReply || limitOutput('Не нашёл, что ответить.', replyCharsFallback(params.config.replyMaxTokens));
  return textSkillResult(reply);
}

function withModelMediaCaption(result: SkillRunResult, modelReply: string): SkillRunResult {
  if (!modelReply || !result.send?.length) return result;
  let captionApplied = false;
  return {
    ...result,
    send: result.send.map((send) => {
      if (captionApplied || send.kind === 'message') return send;
      captionApplied = true;
      return { ...send, caption: modelReply };
    }),
  };
}

async function chatWithFallbacks(
  params: {
    input: string;
    image?: { dataUrl: string };
    config: AppConfig;
    store: FileStore;
    llm: LlmAdapter;
    tools: ToolRegistry;
    toolContext: ToolContext;
  },
  messages: Awaited<ReturnType<typeof buildChatContext>>['messages'],
  contextBudget?: LlmContextBudget,
): Promise<string> {
  try {
    return await params.llm.chat(messages, {
      tools: params.config.llmSupportsTools && !params.image ? params.tools : undefined,
      toolContext: params.toolContext,
      maxSteps: params.config.agentMaxToolSteps,
      maxTokens: params.config.replyMaxTokens,
      contextBudget,
    });
  } catch (error) {
    if (isLlmContextLengthError(error)) {
      logger.warn('LLM context limit exceeded; retrying with reduced context', { error: formatLogError(error) });
      return chatWithReducedContextFallback(params, messages);
    }
    if (!params.image) throw error;
    const reason = humanErrorReason(error);
    const fallbackContext = await buildChatContext(
      params.store,
      buildImageInputFailureUserPrompt(params.input, reason),
      {
        contextWindowTokens: params.config.contextWindowTokens,
        contextBudgetTokens: params.config.contextBudgetTokens,
        replyMaxTokens: params.config.replyMaxTokens,
        timezone: params.config.agentTimezone,
        currentThreadId: params.toolContext.currentMessage?.threadId,
        trustedSkills: params.toolContext.trustedSkills ?? [],
      },
    );
    return params.llm.chat(fallbackContext.messages, {
      tools: undefined,
      toolContext: params.toolContext,
      maxSteps: params.config.agentMaxToolSteps,
      maxTokens: params.config.replyMaxTokens,
    });
  }
}

async function chatWithReducedContextFallback(
  params: {
    config: AppConfig;
    llm: LlmAdapter;
    toolContext: ToolContext;
  },
  messages: Awaited<ReturnType<typeof buildChatContext>>['messages'],
): Promise<string> {
  const reducedMessages = withContextLimitNotice(stripImageInputs(messages));
  return params.llm.chat(reducedMessages, {
    tools: undefined,
    toolContext: params.toolContext,
    maxSteps: params.config.agentMaxToolSteps,
    maxTokens: params.config.replyMaxTokens,
  });
}

function withContextLimitNotice(messages: Awaited<ReturnType<typeof buildChatContext>>['messages']): Awaited<ReturnType<typeof buildChatContext>>['messages'] {
  const notice = buildContextLimitFallbackNotice();
  const first = messages[0];
  if (first?.role === 'system') {
    return [
      { ...first, content: `${notice}\n\n${messageContentToText(first.content)}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: 'system', content: notice }, ...messages];
}

function stripImageInputs(messages: Awaited<ReturnType<typeof buildChatContext>>['messages']): Awaited<ReturnType<typeof buildChatContext>>['messages'] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const textParts = message.content
      .filter((part) => typeof part === 'object' && part !== null && 'type' in part && part.type === 'text')
      .map((part) => 'text' in part && typeof part.text === 'string' ? part.text : '')
      .filter(Boolean);
    return {
      ...message,
      content: [
        ...textParts,
        '[Изображение было опущено: предыдущий запрос превысил лимит контекста модели.]',
      ].join('\n'),
    } as typeof message;
  });
}

function attachImageToLastUserMessage(messages: Awaited<ReturnType<typeof buildChatContext>>['messages'], dataUrl: string | undefined) {
  if (!dataUrl) return messages;
  const copy = [...messages];
  const last = copy[copy.length - 1];
  if (!last || last.role !== 'user') return copy;
  copy[copy.length - 1] = {
    ...last,
    content: [
      { type: 'text', text: typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '') },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  } as typeof last;
  return copy;
}

function messageContentToText(content: Awaited<ReturnType<typeof buildChatContext>>['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return JSON.stringify(content);
}

function replyCharsFallback(replyMaxTokens: number): number {
  return Math.max(500, replyMaxTokens * 6);
}

function formatContextAllocationLog(allocation: ContextAllocation) {
  return [
    `hard=${allocation.usableHardTokens}`,
    `soft=${allocation.softBudgetTokens}`,
    `free=${allocation.freeTokens}`,
    `userExtra=${allocation.userExtraTokens}`,
    `userOverflow=${allocation.userOverflowTokens}`,
    `take=system:${allocation.takes.system},time:${allocation.takes.time},skills:${allocation.takes.skills},user:${allocation.takes.user},memory:${allocation.takes.memory},tool:${allocation.takes.toolObservation}`,
  ].join(' ');
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
