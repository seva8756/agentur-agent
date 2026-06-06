import { AppConfig } from '../config';
import {
  ChatMcpServerConfig,
  deleteChatMcpServer,
  McpManager,
  readChatMcpConfig,
  upsertChatMcpServer,
} from '../integrations/mcp/manager';
import { runDoctor } from '../llm/doctor';
import { LlmAdapter } from '../llm/types';
import { listDecisions } from '../memory/decisions';
import { listFacts } from '../memory/facts';
import { FileStore } from '../memory/fileStore';
import { readSecrets, setSecret, deleteSecret } from '../memory/secrets';
import {
  isCensorModeEnabled,
  readChatSettings,
  replyModeSchema,
  setCensorMode,
  setReplyMode,
} from '../memory/chatSettings';
import { readIdentity, resetIdentity, writeIdentity } from '../memory/identity';
import { readMood, resetMood } from '../memory/moodDiary';
import { AgentScheduler } from '../scheduler/scheduler';
import { loadDraftSkills, loadEnabledSkills, enableSkill, disableSkill, deleteSkill, resolveSkillName, findSkill } from '../skills/loader';
import { skillSecrets } from '../skills/schema';

export type CommandDeps = {
  store: FileStore;
  config: AppConfig;
  scheduler: AgentScheduler;
  llm: LlmAdapter;
  mcp?: McpManager;
};

const COMMAND_PREFIX = '/agentur';

export async function handleAgentCommand(text: string, deps: CommandDeps): Promise<string> {
  const parts = text.trim().split(/\s+/);
  const command = parts[1] ?? 'help';
  if (command === 'help') return helpText();
  if (command === 'status') {
    const settings = await readChatSettings(deps.store);
    const scope = deps.config.telegramAllowedChatId
      ? `один чат: ${deps.config.telegramAllowedChatId}`
      : 'multi-chat: все чаты с отдельной памятью';
    const capture = deps.config.telegramFullCaptureChatIds.length
      ? deps.config.telegramFullCaptureChatIds.join(', ')
      : 'только обращения, навыки и команды';
    return `Работаю.\nОбласть: ${scope}.\nРежим ответа: ${settings.replyMode}.\nРежим цензуры: ${formatCensorMode(isCensorModeEnabled(settings))}.\nСбор контекста: ${capture}.\nTool Calling: ${deps.config.llmSupportsTools ? 'включен' : 'выключен'}.`;
  }
  if (command === 'doctor') return (await runDoctor(deps.config, deps.llm)).join('\n');
  if (command === 'mcp') return handleMcpCommand(text, parts, deps);
  if (command === 'reply-mode') return handleReplyModeCommand(parts, deps);
  if (command === 'censor-mode') return handleCensorModeCommand(parts, deps);
  if (command === 'identity') return handleIdentityCommand(text, deps);
  if (command === 'mood' && parts[2] === 'reset') {
    const mood = await resetMood(deps.store);
    return formatMood(mood);
  }
  if (command === 'mood') return formatMood(await readMood(deps.store));
  if (command === 'facts') {
    const facts = await listFacts(deps.store);
    return facts.length ? facts.map((f) => `- ${f.text}`).join('\n') : 'Фактов пока нет.';
  }
  if (command === 'decisions') {
    const decisions = await listDecisions(deps.store);
    return decisions.length ? decisions.map((d) => `- ${d.text}`).join('\n') : 'Решений пока нет.';
  }
  if (command === 'secrets') {
    const [drafts, enabled] = await Promise.all([loadDraftSkills(deps.store), loadEnabledSkills(deps.store)]);
    const allSkills = [...drafts, ...enabled];
    const allSecrets = await readSecrets(deps.store);
    
    // Собираем все уникальные требуемые секреты из всех зарегистрированных скиллов
    const requiredKeys = [...new Set(allSkills.flatMap((s) => skillSecrets(s)))];
    
    if (requiredKeys.length === 0 && Object.keys(allSecrets).length === 0) {
      return 'Секретов в этом чате нет, и ни один навык не требует секретов.';
    }
    
    const lines = ['Секреты чата:'];
    for (const key of requiredKeys) {
      const isSet = key in allSecrets;
      lines.push(`- ${key}: ${isSet ? '✅ Заполнен' : '❌ Не заполнен (требуется)'}`);
    }
    
    // Выведем также секреты, которые есть, но не требуются текущими навыками
    for (const key of Object.keys(allSecrets)) {
      if (!requiredKeys.includes(key)) {
        lines.push(`- ${key}: ✅ Заполнен (не используется навыками)`);
      }
    }
    
    return lines.join('\n');
  }
  if (command === 'secret' && parts[2] === 'set' && parts[3]) {
    const rawTail = text.trim().substring(text.indexOf('secret') + 'secret'.length).trim();
    const setMatch = rawTail.match(/^set\s+([A-Za-z0-9_.-]+)\s+([\s\S]+)$/i);
    if (!setMatch) {
      return `Используйте: \`${COMMAND_PREFIX} secret set KEY VALUE\``;
    }
    const [, key, value] = setMatch;
    await setSecret(deps.store, key.trim(), value.trim());
    return `Секрет ${key.trim()} успешно сохранён.`;
  }
  if (command === 'secret' && parts[2] === 'delete' && parts[3]) {
    const key = parts[3].trim();
    const deleted = await deleteSecret(deps.store, key);
    return deleted ? `Секрет ${key} удалён.` : `Секрет ${key} не найден.`;
  }
  if (command === 'skills') {
    const [drafts, enabled] = await Promise.all([loadDraftSkills(deps.store), loadEnabledSkills(deps.store)]);
    return [
      `Включены: ${enabled.length ? enabled.map((s) => s.id).join(', ') : 'нет'}`,
      `Черновики: ${drafts.length ? drafts.map((s) => s.id).join(', ') : 'нет'}`,
    ].join('\n');
  }
  if (command === 'skill' && parts[2] === 'enable' && parts[3]) {
    const name = commandTail(parts, 3);
    try {
      // Ищем сам навык сначала, чтобы проверить требуемые секреты
      const drafts = await loadDraftSkills(deps.store);
      const enabled = await loadEnabledSkills(deps.store);
      const targetSkill = findSkill([...drafts, ...enabled], name);
      
      let warnings = '';
      const requiredSecrets = targetSkill ? skillSecrets(targetSkill) : [];
      if (requiredSecrets.length > 0) {
        const allSecrets = await readSecrets(deps.store);
        const missingSecrets = requiredSecrets.filter((key) => !(key in allSecrets));
        if (missingSecrets.length > 0) {
          warnings = `\n\n⚠️ Внимание! Для полноценной работы навыка требуются секреты, которые еще не заполнены: ${missingSecrets.join(', ')}. Вы можете заполнить их командой:\n` +
            missingSecrets.map((key) => `/agentur secret set ${key} <значение>`).join('\n');
        }
      }

      const skill = await enableSkill(deps.store, name, {
        httpAllowedOrigins: deps.config.skillHttpAllowedOrigins,
        httpTimeoutMs: deps.config.skillHttpTimeoutMs,
        httpMaxRequestBytes: deps.config.skillHttpMaxRequestBytes,
        httpMaxResponseBytes: deps.config.skillHttpMaxResponseBytes,
      });
      return skill ? `Навык включён: ${skill.id}${warnings}` : `Навык не найден: ${name}`;
    } catch (error) {
      return `Навык не включён: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (command === 'skill' && parts[2] === 'disable' && parts[3]) {
    const name = commandTail(parts, 3);
    return (await disableSkill(deps.store, name)) ? `Навык выключен: ${name}` : `Навык не был включён или не найден: ${name}`;
  }
  if (command === 'skill' && parts[2] === 'delete' && parts[3]) {
    const name = commandTail(parts, 3);
    return (await deleteSkill(deps.store, name)) ? `Навык удалён: ${name}` : `Навык не найден: ${name}`;
  }
  if (command === 'cron' && parts[2] === 'list') {
    const jobs = await deps.scheduler.list();
    return jobs.length
      ? jobs.map((j) => `${j.enabled ? 'on' : 'off'} ${j.id}: ${j.title} (${j.cron}, ${j.timezone})`).join('\n')
      : 'Cron-задач пока нет.';
  }
  if (command === 'cron' && parts[2] === 'enable' && parts[3]) {
    const name = commandTail(parts, 3);
    const job = await deps.scheduler.enable(name);
    return job ? `Cron-задача включена: ${job.id}` : `Cron-задача не найдена: ${name}`;
  }
  if (command === 'cron' && parts[2] === 'disable' && parts[3]) {
    const name = commandTail(parts, 3);
    return (await deps.scheduler.disable(name)) ? `Cron-задача выключена: ${name}` : `Cron-задача не найдена: ${name}`;
  }
  if (command === 'cron' && parts[2] === 'delete' && parts[3]) {
    const name = commandTail(parts, 3);
    return (await deps.scheduler.delete(name)) ? `Cron-задача удалена: ${name}` : `Cron-задача не найдена: ${name}`;
  }
  return helpText();
}

function formatMood(mood: { warmth: number; tension: number; humor: number }): string {
  return `Настроение: тепло ${mood.warmth.toFixed(2)}, напряжение ${mood.tension.toFixed(2)}, юмор ${mood.humor.toFixed(2)}.`;
}

function helpText(): string {
  return [
    // Общая диагностика и справка
    `${COMMAND_PREFIX} help — список команд`,
    `${COMMAND_PREFIX} status — состояние бота в этом чате`,
    `${COMMAND_PREFIX} doctor — диагностика подключения и настроек`,
    '',
    // Режимы общения и цензура
    `${COMMAND_PREFIX} reply-mode — текущий режим ответа`,
    `${COMMAND_PREFIX} reply-mode called — отвечать только на обращение`,
    `${COMMAND_PREFIX} reply-mode smart — читать чат и вмешиваться по делу`,
    `${COMMAND_PREFIX} censor-mode — текущий режим цензуры`,
    `${COMMAND_PREFIX} censor-mode on — обычная речь`,
    `${COMMAND_PREFIX} censor-mode off — разрешить мат по тону`,
    '',
    // Характер, настроение и память
    `${COMMAND_PREFIX} identity — текущий характер агента`,
    `${COMMAND_PREFIX} identity set <описание> — задать характер`,
    `${COMMAND_PREFIX} identity reset — сбросить характер`,
    `${COMMAND_PREFIX} mood — настроение чата`,
    `${COMMAND_PREFIX} mood reset — сбросить настроение`,
    `${COMMAND_PREFIX} facts — сохранённые факты`,
    `${COMMAND_PREFIX} decisions — сохранённые решения`,
    '',
    // Секреты (API ключи и т.д.)
    `${COMMAND_PREFIX} secrets — требуемые и заполненные секреты чата`,
    `${COMMAND_PREFIX} secret set KEY VALUE — сохранить секрет чата`,
    `${COMMAND_PREFIX} secret delete KEY — удалить секрет чата`,
    '',
    // MCP integrations
    `${COMMAND_PREFIX} mcp servers — подключенные MCP servers`,
    `${COMMAND_PREFIX} mcp add-remote <id> <url> — добавить remote MCP server в этот чат`,
    `${COMMAND_PREFIX} mcp set-token <id> <SECRET_KEY> — использовать secret как Bearer token`,
    `${COMMAND_PREFIX} mcp tools <id> — показать tools MCP server`,
    `${COMMAND_PREFIX} mcp allow-tool <id> <tool> — разрешить конкретный tool`,
    `${COMMAND_PREFIX} mcp delete <id> — удалить MCP server из этого чата`,
    '',
    // Навыки (skills)
    `${COMMAND_PREFIX} skills — навыки и черновики`,
    `${COMMAND_PREFIX} skill enable <name> — включить навык`,
    `${COMMAND_PREFIX} skill disable <name> — выключить навык`,
    `${COMMAND_PREFIX} skill delete <name> — удалить навык`,
    '',
    // Планировщик задач (cron)
    `${COMMAND_PREFIX} cron list — список cron-задач`,
    `${COMMAND_PREFIX} cron enable <name> — включить cron-задачу`,
    `${COMMAND_PREFIX} cron disable <name> — выключить cron-задачу`,
    `${COMMAND_PREFIX} cron delete <name> — удалить cron-задачу`,
  ].join('\n');
}

async function handleMcpCommand(text: string, parts: string[], deps: CommandDeps): Promise<string> {
  const action = parts[2] ?? 'servers';
  if (action === 'servers') {
    const config = await readChatMcpConfig(deps.store);
    const ids = Object.keys(config.servers);
    if (!ids.length) return 'В этом чате нет подключенных MCP servers.';
    return ids.map((id) => {
      const server = config.servers[id]!;
      const tools = server.allowedTools.length ? server.allowedTools.join(', ') : 'all';
      const resources = server.allowedResources.length ? server.allowedResources.join(', ') : 'all';
      return `${server.enabled ? 'on' : 'off'} ${id}: ${server.url}; tools=${tools}; resources=${resources}`;
    }).join('\n');
  }

  if (action === 'add-remote' && parts[3] && parts[4]) {
    const id = parts[3];
    const url = parts[4];
    const server: ChatMcpServerConfig = {
      transport: 'streamable_http',
      url,
      enabled: true,
      title: id,
      allowedTools: [],
      allowedResources: [],
    };
    try {
      await upsertChatMcpServer(deps.store, id, server);
    } catch (error) {
      return `MCP server не добавлен: ${error instanceof Error ? error.message : String(error)}`;
    }
    return [
      `MCP server добавлен: ${id}`,
      `URL: ${url}`,
      '',
      `Если нужен токен, сохраните secret и привяжите его как Bearer token:`,
      `${COMMAND_PREFIX} secret set MCP_TOKEN <значение>`,
      `${COMMAND_PREFIX} mcp set-token ${id} MCP_TOKEN`,
      '',
      `Проверить tools: ${COMMAND_PREFIX} mcp tools ${id}`,
    ].join('\n');
  }

  if (action === 'set-token' && parts[3] && parts[4]) {
    const id = parts[3];
    const secretKey = parts[4];
    const config = await readChatMcpConfig(deps.store);
    const server = config.servers[id];
    if (!server) return `MCP server не найден: ${id}`;
    try {
      await upsertChatMcpServer(deps.store, id, {
        ...server,
        authSecretKey: secretKey,
      });
    } catch (error) {
      return `Token secret не сохранён: ${error instanceof Error ? error.message : String(error)}`;
    }
    return `Secret ${secretKey} будет использоваться как Authorization: Bearer <token> для MCP server ${id}.`;
  }

  if (action === 'tools' && parts[3]) {
    if (!deps.config.mcpEnabled || !deps.mcp) return 'MCP выключен в настройках приложения.';
    const serverId = parts[3];
    try {
      const tools = await deps.mcp.listAllowedTools({ store: deps.store, serverId });
      return tools.length
        ? tools.map((tool) => `- ${tool.name}: ${tool.description ?? 'без описания'}`).join('\n')
        : `MCP server ${serverId} не вернул tools или все tools отфильтрованы.`;
    } catch (error) {
      return `Не смог получить tools MCP server ${serverId}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (action === 'allow-tool' && parts[3] && parts[4]) {
    const id = parts[3];
    const toolName = parts[4];
    const config = await readChatMcpConfig(deps.store);
    const server = config.servers[id];
    if (!server) return `MCP server не найден: ${id}`;
    const allowedTools = [...new Set([...server.allowedTools, toolName])];
    await upsertChatMcpServer(deps.store, id, { ...server, allowedTools });
    return `Tool ${toolName} разрешён для MCP server ${id}.`;
  }

  if (action === 'allow-resource' && parts[3] && parts[4]) {
    const id = parts[3];
    const pattern = parts[4];
    const config = await readChatMcpConfig(deps.store);
    const server = config.servers[id];
    if (!server) return `MCP server не найден: ${id}`;
    const allowedResources = [...new Set([...server.allowedResources, pattern])];
    await upsertChatMcpServer(deps.store, id, { ...server, allowedResources });
    return `Resource pattern ${pattern} разрешён для MCP server ${id}.`;
  }

  if (action === 'delete' && parts[3]) {
    const id = parts[3];
    return (await deleteChatMcpServer(deps.store, id)) ? `MCP server удалён: ${id}` : `MCP server не найден: ${id}`;
  }

  return [
    `${COMMAND_PREFIX} mcp servers`,
    `${COMMAND_PREFIX} mcp add-remote <id> <url>`,
    `${COMMAND_PREFIX} mcp set-token <id> <SECRET_KEY>`,
    `${COMMAND_PREFIX} mcp tools <id>`,
    `${COMMAND_PREFIX} mcp allow-tool <id> <tool>`,
    `${COMMAND_PREFIX} mcp allow-resource <id> <uri-or-prefix*>`,
    `${COMMAND_PREFIX} mcp delete <id>`,
  ].join('\n');
}

function commandTail(parts: string[], startIndex: number): string {
  return parts.slice(startIndex).join(' ').trim();
}

async function handleReplyModeCommand(parts: string[], deps: CommandDeps): Promise<string> {
  const raw = parts[2]?.toLowerCase();
  if (!raw) {
    const settings = await readChatSettings(deps.store);
    return `Текущий режим ответа: ${settings.replyMode}.\n\n` +
      '`called` — отвечаю только на обращение, тег, ответ на сообщение, команду или навык.\n' +
      '`smart` — мониторю чат, сохраняю короткий буфер и сам решаю, когда стоит вмешаться.';
  }

  const parsed = replyModeSchema.safeParse(raw);
  if (!parsed.success) {
    return `Неизвестный режим. Используй \`${COMMAND_PREFIX} reply-mode called\` или \`${COMMAND_PREFIX} reply-mode smart\`.`;
  }
  const settings = await setReplyMode(deps.store, parsed.data);
  return settings.replyMode === 'smart'
    ? 'Режим ответа: smart. Буду мониторить чат и осторожно решать, когда вмешаться.'
    : 'Режим ответа: called. Буду отвечать только на явное обращение, ответ на сообщение, команды и навыки.';
}

async function handleCensorModeCommand(parts: string[], deps: CommandDeps): Promise<string> {
  const raw = parts[2]?.toLowerCase();
  if (!raw) {
    const settings = await readChatSettings(deps.store);
    return `Текущий режим цензуры: ${formatCensorMode(isCensorModeEnabled(settings))}.\n\n` +
      '`on` — обычная речь без мата без явной необходимости.\n' +
      '`off` — мат разрешён, если он уместен по тону.';
  }

  const parsed = parseCensorMode(raw);
  if (!parsed.success) {
    return `Неизвестный режим. Используй \`${COMMAND_PREFIX} censor-mode on\` или \`${COMMAND_PREFIX} censor-mode off\`.`;
  }
  const settings = await setCensorMode(deps.store, parsed.enabled);
  return formatCensorModeSaved(isCensorModeEnabled(settings));
}

function parseCensorMode(raw: string): { success: true; enabled: boolean } | { success: false } {
  if (raw === 'on') return { success: true, enabled: true };
  if (raw === 'off') return { success: true, enabled: false };
  return { success: false };
}

function formatCensorMode(enabled: boolean): string {
  return enabled ? 'включён' : 'выключен';
}

function formatCensorModeSaved(enabled: boolean): string {
  return enabled
    ? 'Режим цензуры: включён. Возвращаюсь к обычной речи.'
    : 'Режим цензуры: выключен. Мат разрешён, если он уместен по тону.';
}

async function handleIdentityCommand(text: string, deps: CommandDeps): Promise<string> {
  const match = text.match(/^\/agentur(?:@\w+)?\s+identity(?:\s+(set|reset))?(?:\s+([\s\S]*))?$/i);
  const action = match?.[1]?.toLowerCase();
  const body = match?.[2]?.trim() ?? '';

  if (action === 'reset') {
    await resetIdentity(deps.store);
    return 'Identity сброшена для этого чата.';
  }

  if (action === 'set') {
    if (!body) return `Пришли текст после \`${COMMAND_PREFIX} identity set ...\` или приложи \`.txt/.md\` файл с caption \`${COMMAND_PREFIX} identity set\`.`;
    const saved = await writeIdentity(deps.store, body, deps.config.agentIdentityMaxChars);
    return `Identity сохранена для этого чата (${saved.length} символов).`;
  }

  const identity = await readIdentity(deps.store);
  return identity ? `Текущая identity:\n\n${identity}` : 'Identity для этого чата не задана.';
}
