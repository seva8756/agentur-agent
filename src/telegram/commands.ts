import { AppConfig } from '../config';
import { runDoctor } from '../llm/doctor';
import { LlmAdapter } from '../llm/types';
import { listDecisions } from '../memory/decisions';
import { listFacts } from '../memory/facts';
import { FileStore } from '../memory/fileStore';
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
import { loadDraftSkills, loadEnabledSkills, enableSkill, disableSkill, deleteSkill } from '../skills/loader';

export type CommandDeps = {
  store: FileStore;
  config: AppConfig;
  scheduler: AgentScheduler;
  llm: LlmAdapter;
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
    return `Работаю. Область: ${scope}. Режим ответа: ${settings.replyMode}. Режим цензуры: ${formatCensorMode(isCensorModeEnabled(settings))}. Сбор контекста: ${capture}. Действия: ${deps.config.llmSupportsTools ? 'включены' : 'выключены'}.`;
  }
  if (command === 'doctor') return (await runDoctor(deps.config, deps.llm)).join('\n');
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
  if (command === 'skills') {
    const [drafts, enabled] = await Promise.all([loadDraftSkills(deps.store), loadEnabledSkills(deps.store)]);
    return [
      `Включены: ${enabled.length ? enabled.map((s) => s.id).join(', ') : 'нет'}`,
      `Черновики: ${drafts.length ? drafts.map((s) => s.id).join(', ') : 'нет'}`,
    ].join('\n');
  }
  if (command === 'skill' && parts[2] === 'enable' && parts[3]) {
    const name = commandTail(parts, 3);
    const skill = await enableSkill(deps.store, name);
    return skill ? `Навык включён: ${skill.id}` : `Навык не найден: ${name}`;
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
    `${COMMAND_PREFIX} help — список команд`,
    `${COMMAND_PREFIX} status — состояние бота в этом чате`,
    `${COMMAND_PREFIX} doctor — диагностика подключения и настроек`,
    `${COMMAND_PREFIX} reply-mode — текущий режим ответа`,
    `${COMMAND_PREFIX} reply-mode called — отвечать только на обращение`,
    `${COMMAND_PREFIX} reply-mode smart — читать чат и вмешиваться по делу`,
    `${COMMAND_PREFIX} censor-mode — текущий режим цензуры`,
    `${COMMAND_PREFIX} censor-mode on — обычная речь`,
    `${COMMAND_PREFIX} censor-mode off — разрешить мат по тону`,
    `${COMMAND_PREFIX} identity — текущий характер агента`,
    `${COMMAND_PREFIX} identity set <описание> — задать характер`,
    `${COMMAND_PREFIX} identity reset — сбросить характер`,
    `${COMMAND_PREFIX} mood — настроение чата`,
    `${COMMAND_PREFIX} mood reset — сбросить настроение`,
    `${COMMAND_PREFIX} facts — сохранённые факты`,
    `${COMMAND_PREFIX} decisions — сохранённые решения`,
    `${COMMAND_PREFIX} skills — навыки и черновики`,
    `${COMMAND_PREFIX} skill enable <name> — включить навык`,
    `${COMMAND_PREFIX} skill disable <name> — выключить навык`,
    `${COMMAND_PREFIX} skill delete <name> — удалить навык`,
    `${COMMAND_PREFIX} cron list — список cron-задач`,
    `${COMMAND_PREFIX} cron enable <name> — включить cron-задачу`,
    `${COMMAND_PREFIX} cron disable <name> — выключить cron-задачу`,
    `${COMMAND_PREFIX} cron delete <name> — удалить cron-задачу`,
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
