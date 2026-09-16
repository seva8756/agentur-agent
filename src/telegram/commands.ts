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
  localeSchema,
  readChatSettings,
  replyModeSchema,
  setCensorMode,
  setLocale,
  setReplyMode,
} from '../memory/chatSettings';
import { IDENTITY_MAX_CHARS, IdentityTooLongError, readIdentity, resetIdentity, writeIdentity } from '../memory/identity';
import { readMood, resetMood } from '../memory/moodDiary';
import { AgentScheduler } from '../scheduler/scheduler';
import { loadSkills, enableSkill, disableSkill, deleteSkill, findSkill } from '../skills/loader';
import { skillSecrets } from '../skills/schema';
import { commandMessages } from '../i18n/commands';

export type CommandDeps = {
  store: FileStore;
  config: AppConfig;
  scheduler: AgentScheduler;
  llm: LlmAdapter;
  mcp?: McpManager;
};

export async function handleAgentCommand(text: string, deps: CommandDeps): Promise<string> {
  const parts = text.trim().split(/\s+/);
  const command = parts[1] ?? 'help';
  const locale = (await readChatSettings(deps.store, deps.config.defaultLocale)).locale;
  const t = commandMessages(locale);
  if (command === 'help') return t.help;
  if (command === 'language') return handleLanguageCommand(parts, deps, locale, t);
  if (command === 'status') {
    const settings = await readChatSettings(deps.store, deps.config.defaultLocale);
    const capture = deps.config.chatFullCaptureIds.length
      ? deps.config.chatFullCaptureIds.join(', ')
      : t.contextCapture;
    return t.status(settings.replyMode, t.censorMode(isCensorModeEnabled(settings)), capture, deps.config.llmSupportsTools, settings.locale);
  }
  if (command === 'doctor') return (await runDoctor(deps.config, deps.llm)).join('\n');
  if (command === 'mcp') return handleMcpCommand(parts, deps, t);
  if (command === 'reply-mode') return handleReplyModeCommand(parts, deps, t);
  if (command === 'censor-mode') return handleCensorModeCommand(parts, deps, t);
  if (command === 'identity') return handleIdentityCommand(text, deps, t);
  if (command === 'mood' && parts[2] === 'reset') {
    const mood = await resetMood(deps.store);
    return formatMood(mood, locale);
  }
  if (command === 'mood') return formatMood(await readMood(deps.store), locale);
  if (command === 'facts') {
    const facts = await listFacts(deps.store);
    return facts.length ? facts.map((f) => `- ${f.text}`).join('\n') : t.noFacts;
  }
  if (command === 'decisions') {
    const decisions = await listDecisions(deps.store);
    return decisions.length ? decisions.map((d) => `- ${d.text}`).join('\n') : t.noDecisions;
  }
  if (command === 'secrets') {
    const allSkills = await loadSkills(deps.store);
    const allSecrets = await readSecrets(deps.store);
    
    // Собираем все уникальные требуемые секреты из всех зарегистрированных скиллов
    const requiredKeys = [...new Set(allSkills.flatMap((s) => skillSecrets(s)))];
    
    if (requiredKeys.length === 0 && Object.keys(allSecrets).length === 0) {
      return t.noSecrets;
    }
    
    const lines = [t.secretsHeader];
    for (const key of requiredKeys) {
      const isSet = key in allSecrets;
      lines.push(t.secretState(key, isSet, true));
    }
    
    // Выведем также секреты, которые есть, но не требуются текущими навыками
    for (const key of Object.keys(allSecrets)) {
      if (!requiredKeys.includes(key)) {
        lines.push(t.secretState(key, true, false));
      }
    }
    
    return lines.join('\n');
  }
  if (command === 'secret' && parts[2] === 'set' && parts[3]) {
    const rawTail = text.trim().substring(text.indexOf('secret') + 'secret'.length).trim();
    const setMatch = rawTail.match(/^set\s+([A-Za-z0-9_.-]+)\s+([\s\S]+)$/i);
    if (!setMatch) {
      return t.secretUsage;
    }
    const [, key, value] = setMatch;
    await setSecret(deps.store, key.trim(), value.trim());
    return t.secretSaved(key.trim());
  }
  if (command === 'secret' && parts[2] === 'delete' && parts[3]) {
    const key = parts[3].trim();
    const deleted = await deleteSecret(deps.store, key);
    return t.secretDeleted(key, deleted);
  }
  if (command === 'skills') {
    const skills = await loadSkills(deps.store);
    return skills.length
      ? skills.map((skill) => `${skill.enabled ? 'on' : 'off'} ${skill.id}`).join('\n')
      : t.noSkills;
  }
  if (command === 'skill' && parts[2] === 'enable' && parts[3]) {
    const name = commandTail(parts, 3);
    try {
      // Ищем сам навык сначала, чтобы проверить требуемые секреты
      const targetSkill = findSkill(await loadSkills(deps.store), name);
      
      let warnings = '';
      const requiredSecrets = targetSkill ? skillSecrets(targetSkill) : [];
      if (requiredSecrets.length > 0) {
        const allSecrets = await readSecrets(deps.store);
        const missingSecrets = requiredSecrets.filter((key) => !(key in allSecrets));
        if (missingSecrets.length > 0) {
          warnings = t.missingSecrets(missingSecrets);
        }
      }

      const skill = await enableSkill(deps.store, name, {
        httpAllowedOrigins: deps.config.skillHttpAllowedOrigins,
        httpBlockedHosts: deps.config.httpBlockedHosts,
        httpAllowedPrivateHosts: deps.config.httpAllowedPrivateHosts,
        httpTimeoutMs: deps.config.skillHttpTimeoutMs,
        httpMaxRequestBytes: deps.config.skillHttpMaxRequestBytes,
        httpMaxResponseBytes: deps.config.skillHttpMaxResponseBytes,
      });
      return skill ? t.skillEnabled(skill.id, warnings) : t.skillNotFound(name);
    } catch (error) {
      return t.skillNotEnabled(error instanceof Error ? error.message : String(error));
    }
  }
  if (command === 'skill' && parts[2] === 'disable' && parts[3]) {
    const name = commandTail(parts, 3);
    return t.skillDisabled(name, await disableSkill(deps.store, name));
  }
  if (command === 'skill' && parts[2] === 'delete' && parts[3]) {
    const name = commandTail(parts, 3);
    return t.skillDeleted(name, await deleteSkill(deps.store, name));
  }
  if (command === 'cron' && parts[2] === 'list') {
    const jobs = await deps.scheduler.list();
    return jobs.length
      ? jobs.map((j) => `${j.enabled ? 'on' : 'off'} ${j.id}: ${j.title} (${j.cron}, ${j.timezone})`).join('\n')
      : t.noCron;
  }
  if (command === 'cron' && parts[2] === 'enable' && parts[3]) {
    const name = commandTail(parts, 3);
    const job = await deps.scheduler.enable(name);
    return job ? t.cronEnabled(job.id) : t.cronNotFound(name);
  }
  if (command === 'cron' && parts[2] === 'disable' && parts[3]) {
    const name = commandTail(parts, 3);
    return t.cronDisabled(name, await deps.scheduler.disable(name));
  }
  if (command === 'cron' && parts[2] === 'delete' && parts[3]) {
    const name = commandTail(parts, 3);
    return t.cronDeleted(name, await deps.scheduler.delete(name));
  }
  return t.help;
}

function formatMood(mood: { warmth: number; tension: number; humor: number }, locale: 'ru' | 'en' = 'ru'): string {
  return commandMessages(locale).mood(mood.warmth.toFixed(2), mood.tension.toFixed(2), mood.humor.toFixed(2));
}

async function handleLanguageCommand(parts: string[], deps: CommandDeps, currentLocale: 'ru' | 'en', t: ReturnType<typeof commandMessages>): Promise<string> {
  const raw = parts[2]?.toLowerCase();
  if (!raw) {
    return t.languageCurrent(currentLocale);
  }
  const parsed = localeSchema.safeParse(raw);
  if (!parsed.success) {
    return t.languageInvalid;
  }
  await setLocale(deps.store, parsed.data);
  return t.languageSaved(parsed.data);
}

async function handleMcpCommand(parts: string[], deps: CommandDeps, t: ReturnType<typeof commandMessages>): Promise<string> {
  const action = parts[2] ?? 'servers';
  if (action === 'servers') {
    const config = await readChatMcpConfig(deps.store);
    const ids = Object.keys(config.servers);
    if (!ids.length) return t.mcpNone;
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
      return t.mcpAddFailed(error instanceof Error ? error.message : String(error));
    }
    return t.mcpAdded(id, url);
  }

  if (action === 'set-token' && parts[3] && parts[4]) {
    const id = parts[3];
    const secretKey = parts[4];
    const config = await readChatMcpConfig(deps.store);
    const server = config.servers[id];
    if (!server) return t.mcpNotFound(id);
    try {
      await upsertChatMcpServer(deps.store, id, {
        ...server,
        authSecretKey: secretKey,
      });
    } catch (error) {
      return t.mcpTokenFailed(error instanceof Error ? error.message : String(error));
    }
    return t.mcpTokenSaved(secretKey, id);
  }

  if (action === 'tools' && parts[3]) {
    if (!deps.config.mcpEnabled || !deps.mcp) return t.mcpDisabled;
    const serverId = parts[3];
    try {
      const tools = await deps.mcp.listAllowedTools({ store: deps.store, serverId });
      return tools.length
        ? tools.map((tool) => `- ${tool.name}: ${tool.description ?? t.mcpNoDescription}`).join('\n')
        : t.mcpNoTools(serverId);
    } catch (error) {
      return t.mcpToolsFailed(serverId, error instanceof Error ? error.message : String(error));
    }
  }

  if (action === 'allow-tool' && parts[3] && parts[4]) {
    const id = parts[3];
    const toolName = parts[4];
    const config = await readChatMcpConfig(deps.store);
    const server = config.servers[id];
    if (!server) return t.mcpNotFound(id);
    const allowedTools = [...new Set([...server.allowedTools, toolName])];
    await upsertChatMcpServer(deps.store, id, { ...server, allowedTools });
    return t.mcpToolAllowed(toolName, id);
  }

  if (action === 'allow-resource' && parts[3] && parts[4]) {
    const id = parts[3];
    const pattern = parts[4];
    const config = await readChatMcpConfig(deps.store);
    const server = config.servers[id];
    if (!server) return t.mcpNotFound(id);
    const allowedResources = [...new Set([...server.allowedResources, pattern])];
    await upsertChatMcpServer(deps.store, id, { ...server, allowedResources });
    return t.mcpResourceAllowed(pattern, id);
  }

  if (action === 'delete' && parts[3]) {
    const id = parts[3];
    return t.mcpDeleted(id, await deleteChatMcpServer(deps.store, id));
  }

  return t.mcpHelp;
}

function commandTail(parts: string[], startIndex: number): string {
  return parts.slice(startIndex).join(' ').trim();
}

async function handleReplyModeCommand(parts: string[], deps: CommandDeps, t: ReturnType<typeof commandMessages>): Promise<string> {
  const raw = parts[2]?.toLowerCase();
  if (!raw) {
    const settings = await readChatSettings(deps.store);
    return t.replyModeCurrent(settings.replyMode);
  }

  const parsed = replyModeSchema.safeParse(raw);
  if (!parsed.success) {
    return t.replyModeInvalid;
  }
  const settings = await setReplyMode(deps.store, parsed.data);
  return t.replyModeSaved(settings.replyMode);
}

async function handleCensorModeCommand(parts: string[], deps: CommandDeps, t: ReturnType<typeof commandMessages>): Promise<string> {
  const raw = parts[2]?.toLowerCase();
  if (!raw) {
    const settings = await readChatSettings(deps.store);
    return t.censorCurrent(t.censorMode(isCensorModeEnabled(settings)));
  }

  const parsed = parseCensorMode(raw);
  if (!parsed.success) {
    return t.censorInvalid;
  }
  const settings = await setCensorMode(deps.store, parsed.enabled);
  return t.censorSaved(isCensorModeEnabled(settings));
}

function parseCensorMode(raw: string): { success: true; enabled: boolean } | { success: false } {
  if (raw === 'on') return { success: true, enabled: true };
  if (raw === 'off') return { success: true, enabled: false };
  return { success: false };
}

async function handleIdentityCommand(text: string, deps: CommandDeps, t: ReturnType<typeof commandMessages>): Promise<string> {
  const match = text.match(/^\/agentur(?:@\w+)?\s+identity(?:\s+(set|reset))?(?:\s+([\s\S]*))?$/i);
  const action = match?.[1]?.toLowerCase();
  const body = match?.[2]?.trim() ?? '';

  if (action === 'reset') {
    await resetIdentity(deps.store);
    return t.identityReset;
  }

  if (action === 'set') {
    if (!body) return t.identitySetUsage;
    const saved = await writeIdentity(deps.store, body, IDENTITY_MAX_CHARS).catch((error) => {
      if (error instanceof IdentityTooLongError) return error;
      throw error;
    });
    if (saved instanceof IdentityTooLongError) {
      return t.identityTooLong(saved.length, saved.maxChars);
    }
    return t.identitySaved(saved.length);
  }

  const identity = await readIdentity(deps.store);
  return t.identityCurrent(identity);
}
