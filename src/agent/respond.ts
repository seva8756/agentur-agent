import { AppConfig } from '../config';
import { isLlmContextLengthError } from '../llm/errors';
import { LlmAdapter } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { SkillRunResult, skillResultText, textSkillResult } from '../skills/result';
import { loadEnabledSkills } from '../skills/loader';
import { SkillPackage } from '../skills/schema';
import { TrustedSkillPromptInfo } from '../skills/trustedTypes';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../tools/types';
import { formatLogError, logger } from '../utils/logger';
import { buildChatContext, trimMessagesToBudget } from './contextBuilder';
import { limitOutput } from './outputLimiter';

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
  const artifactContext = buildArtifactToolsContext();
  const baseMessages = skillsContext
    ? [...context.slice(0, -1), { role: 'system' as const, content: [skillsContext, artifactContext].join('\n') }, context[context.length - 1]]
    : [...context.slice(0, -1), { role: 'system' as const, content: artifactContext }, context[context.length - 1]];
  const messages = attachImageToLastUserMessage(trimMessagesToBudget(baseMessages, params.config.contextMaxChars), params.image?.dataUrl);
  const text = await chatWithFallbacks({ ...params, toolContext }, messages);
  const reply = limitOutput(text || 'Не нашёл, что ответить.', params.config.agentMaxReplyChars);
  const queued = outbox.at(-1);
  if (queued?.send) {
    return {
      ...queued,
      reply: reply || queued.reply,
    };
  }
  return textSkillResult(reply);
}

function buildArtifactToolsContext(): string {
  return [
    'Artifact tools create and read chat-local files.',
    'Use create_artifact when the user asks you to produce a file instead of pasting long content.',
    'Use read_artifact before modifying or explaining an existing artifact unless its content is already visible.',
    'Use send_artifact to deliver an existing artifact to Telegram.',
    'When returning a send payload for an artifact, use send.kind="file" for generic files, send.kind="photo" for images, or send.kind="video" for videos.',
    'Never use send.kind="artifact"; artifact is only a source type: source={type:"artifact", artifactId:"art_..."}.',
    'Do not invent artifact IDs; use IDs returned by tools or visible in chat context.',
  ].join('\n');
}

async function buildEnabledSkillsContext(store: FileStore, trustedSkills: TrustedSkillPromptInfo[]): Promise<string> {
  const skills = await loadEnabledSkills(store);
  if (!skills.length && !trustedSkills.length) return '';
  return [
    'Enabled skill inventory for semantic selection.',
    'Use this inventory only to choose likely skills. It is intentionally compact: id, title, when_to_use, and slash command triggers.',
    'For chat-generated skills, if the user request matches an inventory item, first call `list_skill_packages` with that skill id/title to fetch full SKILL.md, triggers, tool names, and tool descriptions; then call `run_skill_tool` with the concrete skill and tool.',
    'Trusted native skill tools are available as direct tools; call their concrete tool names directly instead of `run_skill_tool`.',
    'Use skill tools only when the title or when_to_use clearly fits the user request.',
    'If multiple skill tools are needed, call each relevant tool and compose the final answer from their structured results.',
    'A skill result with reply=null means the tool completed but has nothing to say; do not treat it as an error.',
    'A skill result with data is machine-readable context for later tool calls.',
    'A skill result with send means the bot can send media/file directly; do not rewrite it as a plain Markdown link unless the tool reports an error.',
    ...trustedSkills.map(formatTrustedSkillForPrompt),
    ...skills.map(formatSkillForPrompt),
  ].join('\n');
}

function formatTrustedSkillForPrompt(skill: TrustedSkillPromptInfo): string {
  const whenToUse = skill.manifest.whenToUse ?? 'not specified';
  return `- trusted_skill=${skill.manifest.id}; title=${skill.manifest.title}; when_to_use=${whenToUse}; runtime=native`;
}

function formatSkillForPrompt(skill: SkillPackage): string {
  const triggers = formatCompactTriggers(skill);
  return `- skill=${skill.id}; title=${skill.title}; when_to_use=${skill.whenToUse}; triggers=${triggers}`;
}

function formatCompactTriggers(skill: SkillPackage): string {
  if (!skill.triggers.length) return 'none';
  const values = skill.triggers.flatMap((trigger) => {
    return [`/${trigger.command.replace(/^\//, '')}`];
  });
  return values.slice(0, 6).join(', ');
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
      [
        params.input,
        '',
        `К сообщению была приложена картинка, но текущая LLM/VLM конфигурация не смогла принять image input: ${reason}.`,
        'Ответь пользователю естественно: скажи, что картинку сейчас не получилось проанализировать, и кратко укажи причину. Если есть подпись/текст сообщения, можешь ответить по нему.',
      ].join('\n'),
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
  const notice = [
    'The previous model request exceeded the available context window.',
    'You are seeing a reduced subset of the chat context and no tools or image input are available in this fallback reply.',
    'Answer as well as possible from the visible context, and explicitly tell the user that some context was omitted because the model context limit was exceeded.',
  ].join(' ');
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
