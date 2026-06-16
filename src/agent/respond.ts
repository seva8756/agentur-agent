import { AppConfig } from '../config';
import { LlmAdapter } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { SkillRunResult, skillResultText, textSkillResult } from '../skills/result';
import { loadEnabledSkills } from '../skills/loader';
import { SkillPackage } from '../skills/schema';
import { TrustedSkillPromptInfo } from '../skills/trustedTypes';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../tools/types';
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
  const text = await chatWithImageFallback({ ...params, toolContext }, messages);
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

async function chatWithImageFallback(
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

function humanErrorReason(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? ((error as { error?: { message?: unknown }; message?: unknown }).error?.message ?? (error as { message?: unknown }).message)
    : undefined;
  const message = typeof candidate === 'string' ? candidate : 'unknown error';
  return message
    .replace(/\/mnt\/models\/\S+/g, 'configured model')
    .slice(0, 300);
}
