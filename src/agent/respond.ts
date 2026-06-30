import { AppConfig } from '../config';
import { isLlmContextLengthError } from '../llm/errors';
import { LlmAdapter } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { SkillRunResult, skillResultText, textSkillResult } from '../skills/result';
import { loadEnabledSkills } from '../skills/loader';
import { TrustedSkillPromptInfo } from '../skills/trustedTypes';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../tools/types';
import { formatLogError, logger } from '../utils/logger';
import { buildChatContext, trimMessagesToBudget } from './contextBuilder';
import { limitOutput } from './outputLimiter';
import {
  buildArtifactToolsPrompt,
  buildContextLimitFallbackNotice,
  buildEnabledSkillsPrompt,
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
    maxChars: params.config.contextMaxChars,
    recentLimit: params.config.recentMessagesContextLimit,
    recentMessageMaxChars: params.config.recentMessageContextMaxChars,
    factsMaxChars: params.config.factsMaxChars,
    timezone: params.config.agentTimezone,
    currentThreadId: toolContext.currentMessage?.threadId,
  });
  const skillsContext = await buildEnabledSkillsContext(params.store, params.toolContext.trustedSkills ?? []);
  const artifactContext = buildArtifactToolsPrompt();
  const baseMessages = skillsContext
    ? [...context.slice(0, -1), { role: 'system' as const, content: [skillsContext, artifactContext].join('\n') }, context[context.length - 1]]
    : [...context.slice(0, -1), { role: 'system' as const, content: artifactContext }, context[context.length - 1]];
  const messages = attachImageToLastUserMessage(trimMessagesToBudget(baseMessages, params.config.contextMaxChars), params.image?.dataUrl);
  const text = await chatWithFallbacks({ ...params, toolContext }, messages);
  const modelReply = text.trim() ? limitOutput(text, params.config.agentMaxReplyChars) : '';
  const queued = outbox.at(-1);
  if (queued?.send) {
    const result = {
      ...queued,
      reply: modelReply || queued.reply,
    };
    return withModelMediaCaption(result, modelReply);
  }
  const reply = modelReply || limitOutput('Не нашёл, что ответить.', params.config.agentMaxReplyChars);
  return textSkillResult(reply);
}

function withModelMediaCaption(result: SkillRunResult, modelReply: string): SkillRunResult {
  if (!modelReply || !result.send || result.send.kind === 'message') return result;
  return {
    ...result,
    send: {
      ...result.send,
      caption: modelReply,
    },
  };
}

async function buildEnabledSkillsContext(store: FileStore, trustedSkills: TrustedSkillPromptInfo[]): Promise<string> {
  const skills = await loadEnabledSkills(store);
  return buildEnabledSkillsPrompt(skills, trustedSkills);
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
  messages: ReturnType<typeof trimMessagesToBudget>,
): Promise<string> {
  try {
    return await params.llm.chat(messages, {
      tools: params.config.llmSupportsTools && !params.image ? params.tools : undefined,
      toolContext: params.toolContext,
      maxSteps: params.config.agentMaxToolSteps,
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
        maxChars: params.config.contextMaxChars,
        recentLimit: params.config.recentMessagesContextLimit,
        recentMessageMaxChars: params.config.recentMessageContextMaxChars,
        factsMaxChars: params.config.factsMaxChars,
        timezone: params.config.agentTimezone,
        currentThreadId: params.toolContext.currentMessage?.threadId,
      },
    );
    const fallbackMessages = trimMessagesToBudget(fallbackContext, params.config.contextMaxChars);
    return params.llm.chat(fallbackMessages, {
      tools: undefined,
      toolContext: params.toolContext,
      maxSteps: params.config.agentMaxToolSteps,
    });
  }
}

async function chatWithReducedContextFallback(
  params: {
    config: AppConfig;
    llm: LlmAdapter;
    toolContext: ToolContext;
  },
  messages: ReturnType<typeof trimMessagesToBudget>,
): Promise<string> {
  const fallbackBudget = Math.max(2000, Math.floor(params.config.contextMaxChars / 3));
  const reducedMessages = trimMessagesToBudget(
    withContextLimitNotice(trimMessagesToBudget(stripImageInputs(messages), fallbackBudget)),
    fallbackBudget,
  );
  return params.llm.chat(reducedMessages, {
    tools: undefined,
    toolContext: params.toolContext,
    maxSteps: params.config.agentMaxToolSteps,
  });
}

function withContextLimitNotice(messages: ReturnType<typeof trimMessagesToBudget>): ReturnType<typeof trimMessagesToBudget> {
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

function stripImageInputs(messages: ReturnType<typeof trimMessagesToBudget>): ReturnType<typeof trimMessagesToBudget> {
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

function attachImageToLastUserMessage(messages: ReturnType<typeof trimMessagesToBudget>, dataUrl: string | undefined) {
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

function messageContentToText(content: ReturnType<typeof trimMessagesToBudget>[number]['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return JSON.stringify(content);
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
