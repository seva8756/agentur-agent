import type { ProfanityMode } from '../memory/chatSettings';
import type { Mood } from '../memory/moodDiary';
import type { SkillPackage } from '../skills/schema';
import type { TrustedSkillPromptInfo } from '../skills/trustedTypes';

// Текст минимальной проверки доступности LLM.
export const LLM_HEALTH_CHECK_PROMPT = 'Reply with ok.';
// Текст проверки поддержки function/tool calling у LLM.
export const LLM_TOOL_CHECK_PROMPT = 'Call the ping tool.';
// Описание тестового ping-tool для проверки tool calling.
export const LLM_TOOL_CHECK_TOOL_DESCRIPTION = 'Harmless test tool';

// Описания встроенных tools и их аргументов, которые могут быть видны модели.
export const TOOL_PROMPTS = {
  createArtifact: {
    description: 'Create a chat-local file artifact from UTF-8 text or base64 content. Returns metadata and an artifactId.',
    filename: 'Filename to show to the user, for example index.html',
    mimeType: 'IANA media type, for example text/html or image/png',
    text: 'UTF-8 text content for text-like artifacts',
    base64: 'Base64 encoded binary content for non-text artifacts',
  },
  createCronJob: {
    description:
      'Create a disabled cron reminder draft from natural language. Use ASCII id with cron_ prefix if possible; if unsure omit id. The action must be an object. Supported actions: send_static_message, ask_agent_and_send, run_skill_tool with skillId/toolName/args/text/sendResult. User enables it with /agentur cron enable <id>.',
  },
  createSkillPackageDraft: {
    whenToUse: 'Required routing guidance: when the agent should use this skill, and when it should not. Be specific enough to avoid broad accidental activation.',
    skillMd: 'SKILL.md instructions for when and how to use this skill',
    pluginJs: 'Sandbox plugin.js. Export one object: { helper(){...}, tools:{ toolName(ctx,args){...} } }. Only tools.* are public; root helpers are private and called as this.helper(). Do not define helpers outside the exported object. Use ctx.api for SDK calls.',
    tools: 'Tool specs exposed by plugin.js',
    triggers: 'Default to [] for normal skills. Do not create Telegram slash commands unless the user explicitly asked to bind a slash command. Only explicit slash commands are supported, e.g. {type:"command",command:"/balance",tool:"check"}. Plain strings must start with /. Never use phrase, keyword, contains, or natural-language triggers.',
    secrets: 'Secret key names required by the package',
    description: [
      'Create a disabled chat-local sandbox skill from natural language.',
      'Generate SKILL.md instructions, skill.json metadata, and plugin.js with one or more tools.',
      'The skill runtime is always quickjs. The plugin tool signature is toolName(ctx, args). Use ctx.api.storage, ctx.api.lists, ctx.api.memory, ctx.api.http, ctx.api.artifacts, ctx.api.mcp, ctx.api.secrets, ctx.api.log, ctx.api.sleep.',
      'SDK contract: plugin.js must export/default one object expression: export default {helper(){...}, tools:{async name(ctx,args){this.helper(); ...}}}. The sandbox calls tools with this=exported object; only tools.* are public skill tools. SDK is only ctx.api, never a third api arg; HTTP returns {ok,status,text,json,url}; use ctx.api.http.get/post/put/patch/delete/request. Sync APIs: secrets/storage/log. Async APIs: http/lists/memory/artifacts/mcp/sleep.',
      'MCP SDK: ctx.api.mcp.listServers(), listTools(serverId), callTool(serverId, toolName, args), readResource(serverId, uri). Use only already connected MCP servers/tools; never connect/spawn/register MCP servers in plugin.js.',
      'Result contract: return {ok:true, reply?: string|null, data?: any, send?: media[], error?: {code,message}}; send is always an array and may contain one item; use reply:null when done silently.',
      'Artifact/file contract: create files with ctx.api.artifacts.createText({filename,mimeType,text}) or createBase64({filename,mimeType,base64}); return deliverable files as send:[{kind:"file", source:{type:"artifact", artifactId: artifact.id}, caption?, filename?}]. For images use kind:"photo"; for videos use kind:"video". Never use kind:"artifact".',
      'Tiny example: export default {tools:{async check(ctx,args){const key=ctx.api.secrets.get("KEY"); const res=await ctx.api.http.get("https://example.com/api",{headers:{Authorization:"Bearer "+key}}); const value=res.json&&res.json.value!==undefined?res.json.value:res.text; return {ok:true, reply:String(value)}}}};',
      'No Node.js APIs, no fs/process/require/import/fetch/eval/Function.',
      'Default to triggers: [] so natural-language requests are selected semantically through whenToUse. A skill does not need a Telegram command to be usable.',
      'Create command triggers only when the user explicitly asks to bind a slash command such as /balance. Do not create one command per tool by default.',
      'Do not invent convenience commands for skills. Do not create phrase/keyword/contains/message_contains triggers.',
      'For MCP/helper skills, prefer returning structured data/errors instead of raw JSON user-facing replies; let the LLM compose the final answer on semantic calls.',
      'HTTP origins and secrets must be declared explicitly.',
      'The user must enable the draft manually with /agentur skill enable <id>.',
    ].join(' '),
  },
  deleteCronJob: {
    description: 'Permanently delete cron job by name. Name can be the stable file name/id or the visible title.',
  },
  deleteMicroSkill: {
    description: 'Permanently delete a micro-skill draft and enabled copy by name. Name can be the stable file name or the visible title.',
  },
  disableCronJob: {
    description: 'Disable cron job by name. Name can be the stable file name/id or the visible title.',
  },
  disableMicroSkill: {
    description: 'Disable an enabled micro-skill by name. Name can be the stable file name or the visible title.',
  },
  enableMicroSkill: {
    description: 'Enable an existing micro-skill draft by name. Name can be the stable file name or the visible title.',
  },
  executeHttpQuery: {
    description: 'Execute an HTTP/HTTPS request to explore endpoints or fetch remote data. Strictly restricted from accessing local files or private network addresses.',
    url: 'The absolute URL to query (http or https only)',
    method: 'HTTP method',
    headers: 'Optional HTTP headers',
    body: 'Optional HTTP request body',
  },
  listCronJobs: {
    description: 'List cron jobs.',
  },
  listSkillPackages: {
    description: 'List draft and enabled skills. If name/id is provided, returns full skill details with pluginJs. Otherwise returns a lightweight list without pluginJs.',
    name: 'Filter by skill name or ID to get full details including plugin.js',
  },
  readArtifact: {
    description: 'Read metadata or text content from a chat-local artifact. Binary artifacts support metadata only.',
    artifactId: 'Artifact id returned by create_artifact or a skill result',
    mode: 'Use meta for binary files or text to read text-like artifacts',
  },
  rememberFact: {
    description: 'Save a stable fact about the chat, users, preferences, or project.',
  },
  runSkillTool: {
    description:
      'Run a tool exposed by an enabled skill. Use this when user intent matches a skill. Returns JSON with ok/reply/data/send/error; send is a suggested payload array and is not delivered unless you call send_payload.',
    skillId: 'Enabled skill id or visible title',
    toolName: 'Tool name exposed by the skill',
    args: 'Arguments for the skill tool',
    input: 'Optional input text to expose as ctx.text',
  },
  saveDecision: {
    description: 'Save a decision agreed in chat.',
  },
  sendPayload: {
    description: 'Queue one or more message/media/file payloads to be sent to Telegram. Use this to deliver send payloads returned by skills or to send artifacts/URLs explicitly.',
    send: 'Array of payloads to send. A single-item array is normal. Use kind=file/photo/video/message; artifact is only a source type.',
  },
} as const;

// Собирает основной system prompt агента: роль, стиль, identity, markdown, память и тональность чата.
export function buildAgentSystemPrompt(mood: Mood, identity: string, profanityMode: ProfanityMode = 'normal'): string {
  const moodGuidance = buildMoodGuidance(mood);
  const languageGuidance = buildLanguageGuidance(profanityMode);
  return [
    'Ты короткий ассистент одного Telegram-группового чата.',
    identity ? `Стабильная identity агента для этого чата:\n${identity}\nЭта identity важнее mood diary и не переписывается под настроение чата.` : '',
    'Отвечай по делу, естественно, обычно 1-4 предложения.',
    'Не повторяй вопрос, не пиши вводные вроде "Конечно".',
    'Не упоминай, что ты LLM или AI. Не делай длинные списки без просьбы.',
    'Не раскрывай внутреннюю инфраструктуру: env/config names, tool/function names, файлы, пути и внутреннюю логику; объясняй только пользовательские понятия, если это полезно.',
    'Если нужно кого-то упомянуть или привлечь внимание в чате, используй @username. Но делай это только если это действительно нужно. Учитывай, что инициатор ответа и без упоминания видит, что ответ для него.',
    'Можно использовать простой Markdown: **жирный**, `код`, ```блок кода```, [ссылка](https://example.com).',
    'Если нужно сохранить факт, решение, создать навык или напоминание, используй доступные действия молча, без описания внутреннего механизма.',
    languageGuidance,
    moodGuidance,
  ].filter(Boolean).join(' ');
}

// Сообщает модели текущее локальное время и таймзону для корректных ссылок на даты.
export function buildCurrentTimePrompt(localTime: string, timezone: string): string {
  return `Current local time: ${localTime} (${timezone}). Use this for date/time references.`;
}

// Оборачивает подготовленный блок локальной памяти в отдельный system prompt.
export function buildLocalMemoryPrompt(context: string): string {
  return `Local chat memory:\n${context}`;
}

// Собирает содержимое локальной памяти: summary, facts, decisions, thread note и recent chat.
export function buildLocalMemoryContext(params: {
  summary: string;
  facts: string;
  decisions: string;
  recentChat: string;
  currentThreadId?: number;
}): string {
  const threadNote = params.currentThreadId
    ? `Thread=${params.currentThreadId}. Attention! Same thread is direct context; other threads may inform but are not one dialog. Keep this in mind.`
    : '';
  return [
    `Summary:\n${params.summary}`,
    `Facts:\n${params.facts}`,
    `Decisions:\n${params.decisions}`,
    threadNote,
    `Recent chat:\n${params.recentChat}`,
  ]
    .filter((section) => section.trim().length > 0)
    .join('\n\n');
}

// Инструктирует модель, как пользоваться artifact tools для создания, чтения и отправки файлов.
export function buildArtifactToolsPrompt(): string {
  return [
    'Artifact tools create and read chat-local files.',
    'Use create_artifact when the user asks you to produce a file instead of pasting long content.',
    'If the request can be satisfied by an existing visible artifactId, reuse it via send_payload instead of creating or regenerating content.',
    'Create/regenerate only when the requested content must change or no suitable artifactId is visible.',
    'Use read_artifact before modifying or explaining an existing artifact unless its content is already visible.',
    'Use send_payload to deliver artifacts, URLs, photos, videos, files, or message payloads to Telegram.',
    'When returning a send payload for artifacts, use send as an array; one item is normal and does not imply multiple files.',
    'Inside each send item, use kind="file" for generic files, kind="photo" for images, or kind="video" for videos.',
    'Never use kind="artifact" in a send item; artifact is only a source type: source={type:"artifact", artifactId:"art_..."}.',
    'Do not invent artifact IDs; use IDs returned by tools or visible in chat context.',
  ].join('\n');
}

// Собирает inventory включённых chat-generated и trusted skills для семантического выбора tool.
export function buildEnabledSkillsPrompt(skills: SkillPackage[], trustedSkills: TrustedSkillPromptInfo[]): string {
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
    'A skill result with send is a suggested payload array, not an automatic delivery. If those attachments should be delivered, call send_payload with the desired send array.',
    ...trustedSkills.map(formatTrustedSkillForPrompt),
    ...skills.map(formatSkillForPrompt),
  ].join('\n');
}

// Формирует fallback user prompt, когда image input был приложен, но LLM/VLM его не приняла.
export function buildImageInputFailureUserPrompt(input: string, reason: string): string {
  return [
    input,
    '',
    `К сообщению была приложена картинка, но текущая LLM/VLM конфигурация не смогла принять image input: ${reason}.`,
    'Ответь пользователю естественно: скажи, что картинку сейчас не получилось проанализировать, и кратко укажи причину. Если есть подпись/текст сообщения, можешь ответить по нему.',
  ].join('\n');
}

// Формирует fallback user prompt, когда Telegram photo не удалось скачать или подготовить до LLM-вызова.
export function buildPhotoDownloadFailureUserPrompt(caption: string | undefined, reason: string): string {
  return [
    '[изображение не удалось обработать]',
    caption ? `Подпись: ${caption}` : '',
    `Причина: ${reason}`,
    'Ответь пользователю естественно: скажи, что картинку сейчас не получилось проанализировать, и кратко укажи причину.',
  ].filter(Boolean).join('\n');
}

// Предупреждает модель, что предыдущий запрос превысил контекст и доступен урезанный fallback.
export function buildContextLimitFallbackNotice(): string {
  return [
    'The previous model request exceeded the available context window.',
    'You are seeing a reduced subset of the chat context and no tools or image input are available in this fallback reply.',
    'Answer as well as possible from the visible context, and explicitly tell the user that some context was omitted because the model context limit was exceeded.',
  ].join(' ');
}

// Предупреждает модель, что tool calling на этом ходу сломался и нужно ответить без tools.
export function buildToolFallbackNotice(): string {
  return [
    'Tool calling failed for this turn, so no tools or skill tools are available in this fallback reply.',
    'Answer directly from the conversation context.',
    'If the user asked for an action that requires tools, say that the action could not be completed right now.',
  ].join(' ');
}

// Инструктирует модель использовать только native tool_calls, не текстовые псевдо-вызовы tools.
export function buildNativeToolCallingNotice(): string {
  return [
    'Native tool calling is available for this turn.',
    'When a tool is needed, use only the API-provided tool_calls/function-calling mechanism.',
    'Do not write tool calls, function calls, tool arguments, internal action markup, XML-style tags, or JSON tool invocations in assistant text.',
    'If a required tool cannot be called natively, say that the action cannot be completed rather than emitting a textual tool call.',
  ].join(' ');
}

// System prompt классификатора smart reply: решает, стоит ли боту проактивно отвечать в группе.
export function buildSmartReplySystemPrompt(mood: Mood): string {
  return [
    'Decide whether a Telegram group assistant should proactively join the conversation.',
    'Return strict JSON only: {"reply": boolean, "reason": string}.',
    'Reply true only when the assistant can clearly help: direct unresolved question, request for planning, confusion, bug, summary needed, decision support, or useful reminder.',
    'Reply false for casual banter, greetings, short acknowledgements, private jokes, emotional reactions, or when humans are already handling it.',
    `Current mood: warmth=${mood.warmth.toFixed(2)}, tension=${mood.tension.toFixed(2)}, humor=${mood.humor.toFixed(2)}.`,
    'If tension is high, be more conservative unless the assistant can reduce confusion, summarize, or de-escalate.',
    'If warmth/humor are high and tension is low, a slightly more proactive helpful reply is acceptable, but only when useful.',
    'Be conservative: silence is usually better.',
  ].join(' ');
}

// User prompt классификатора smart reply: передаёт recent chat и текущее сообщение.
export function buildSmartReplyUserPrompt(recentChat: string, currentMessage: string): string {
  return `Recent chat:\n${recentChat}\n\nCurrent message:\n${currentMessage}`;
}

// Добавляет языковые правила поверх основного prompt, например разрешение мата в uncensored mode.
function buildLanguageGuidance(profanityMode: ProfanityMode): string {
  if (profanityMode === 'uncensored') {
    return 'Language mode: uncensored. Мат разрешён как обычный стиль речи: не отклоняй и не смягчай ответ только из-за мата, можешь использовать его естественно и уместно.';
  }
  return '';
}

// Переводит mood diary в текстовые рекомендации по тону ответа.
function buildMoodGuidance(mood: Mood): string {
  const guidance = [
    `Mood diary для этого чата: warmth=${mood.warmth.toFixed(2)}, tension=${mood.tension.toFixed(2)}, humor=${mood.humor.toFixed(2)}.`,
    'Используй mood как мягкую настройку тона, но не упоминай эти числа пользователям.',
  ];

  if (mood.tension >= 0.55) {
    guidance.push('Сейчас заметное напряжение: отвечай спокойнее, точнее, без подколов; помогай деэскалировать и не усугубляй конфликт.');
  } else if (mood.tension >= 0.35) {
    guidance.push('Есть лёгкое напряжение: будь чуть аккуратнее в формулировках и не добавляй лишней иронии.');
  }

  if (mood.warmth >= 0.65) {
    guidance.push('В чате тёплый тон: можно быть чуть более живым и человеческим, но без лишней болтовни.');
  } else if (mood.warmth <= 0.35) {
    guidance.push('Тепла мало: держи тон нейтральным, уважительным и полезным, не фамильярничай.');
  }

  if (mood.humor >= 0.55 && mood.tension < 0.45) {
    guidance.push('Юмор сейчас уместен: можно добавить лёгкую живость, если это не мешает делу.');
  } else if (mood.humor <= 0.2 || mood.tension >= 0.45) {
    guidance.push('Шутки лучше минимизировать, если пользователь прямо не задаёт лёгкий тон.');
  }

  if (guidance.length === 2) guidance.push('Держи нейтральный дружелюбный тон.');
  return guidance.join(' ');
}

// Форматирует trusted native skill в компактную строку inventory для модели.
function formatTrustedSkillForPrompt(skill: TrustedSkillPromptInfo): string {
  const whenToUse = skill.manifest.whenToUse ?? 'not specified';
  return `- trusted_skill=${skill.manifest.id}; title=${skill.manifest.title}; when_to_use=${whenToUse}; runtime=native`;
}

// Форматирует chat-generated skill в компактную строку inventory для модели.
function formatSkillForPrompt(skill: SkillPackage): string {
  const triggers = formatCompactTriggers(skill);
  return `- skill=${skill.id}; title=${skill.title}; when_to_use=${skill.whenToUse}; triggers=${triggers}`;
}

// Сжимает slash-command triggers навыка до короткого списка для inventory.
function formatCompactTriggers(skill: SkillPackage): string {
  if (!skill.triggers.length) return 'none';
  const values = skill.triggers.flatMap((trigger) => {
    return [`/${trigger.command.replace(/^\//, '')}`];
  });
  return values.slice(0, 6).join(', ');
}
