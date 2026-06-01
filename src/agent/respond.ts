import { AppConfig } from '../config';
import { LlmAdapter } from '../llm/types';
import { FileStore } from '../memory/fileStore';
import { loadEnabledSkills } from '../skills/loader';
import { AtomicSkillAction, MicroSkill, SkillAction } from '../skills/schema';
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
  const context = await buildChatContext(params.store, params.input, {
    maxChars: params.config.contextMaxChars,
    recentLimit: params.config.recentMessagesContextLimit,
    factsMaxChars: params.config.factsMaxChars,
    timezone: params.config.agentTimezone,
  });
  const skillsContext = await buildEnabledSkillsContext(params.store);
  const baseMessages = skillsContext
    ? [...context.slice(0, -1), { role: 'system' as const, content: skillsContext }, context[context.length - 1]]
    : context;
  const messages = attachImageToLastUserMessage(trimMessagesToBudget(baseMessages, params.config.contextMaxChars), params.image?.dataUrl);
  const text = await chatWithImageFallback(params, messages);
  return limitOutput(text || 'Не нашёл, что ответить.', params.config.agentMaxReplyChars);
}

async function buildEnabledSkillsContext(store: FileStore): Promise<string> {
  const skills = await loadEnabledSkills(store);
  if (!skills.length) return '';
  return [
    'Enabled micro-skills available for semantic execution.',
    'If the user asks for something that matches a skill, call `execute_micro_skill` directly; do not tell the user to type the skill command.',
    'Use a skill only when its title/name/action clearly fits the user request.',
    ...skills.map(formatSkillForPrompt),
  ].join('\n');
}

function formatSkillForPrompt(skill: MicroSkill): string {
  const trigger = skill.trigger.type === 'command'
    ? `command /${skill.trigger.command.replace(/^\//, '')}`
    : `contains ${skill.trigger.phrases.map((phrase) => JSON.stringify(phrase)).join(', ')}`;
  return `- name=${skill.id}; title=${skill.title}; trigger=${trigger}; actions=${formatActionTypes(skill.action)}`;
}

function formatActionTypes(action: SkillAction): string {
  const actions: AtomicSkillAction[] = action.type === 'chain' ? action.actions : [action];
  return actions.map((item) => item.type).join(' -> ');
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
        factsMaxChars: params.config.factsMaxChars,
        timezone: params.config.agentTimezone,
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
