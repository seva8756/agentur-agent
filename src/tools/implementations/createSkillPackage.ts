import { z } from 'zod';
import { saveSkill } from '../../skills/loader';
import { skillPackageSchema, triggerSchema } from '../../skills/schema';
import { computeEffectiveHttpOrigins, validateScriptedSkill } from '../../skills/scriptSandbox';
import { TOOL_PROMPTS } from '../../prompts/catalog';
import { toAsciiSlug } from '../../utils/slug';
import { AgentTool } from '../types';

const toolSpecSchema = z.object({
  description: z.string().min(1),
  schema: z.record(z.unknown()).optional().default({ type: 'object', properties: {} }),
});

const looseTriggerSchema = z.union([triggerSchema, z.string().min(1), z.record(z.unknown())]);

const argsSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1).max(1000).describe(TOOL_PROMPTS.createSkillPackage.describeDescription),
  skillMd: z.string().min(1).describe(TOOL_PROMPTS.createSkillPackage.skillMd),
  pluginJs: z.string().min(1).max(12000).describe(TOOL_PROMPTS.createSkillPackage.pluginJs),
  tools: z.record(z.string(), toolSpecSchema).describe(TOOL_PROMPTS.createSkillPackage.tools),
  triggers: z.array(looseTriggerSchema).optional().default([]).describe(TOOL_PROMPTS.createSkillPackage.triggers),
  httpOrigins: z.array(z.string().url()).default([]),
  secrets: z.array(z.string()).optional().default([]).describe(TOOL_PROMPTS.createSkillPackage.secrets),
  storage: z.boolean().optional().default(true),
});

export const createSkillPackageTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'create_skill_package',
  description: TOOL_PROMPTS.createSkillPackage.description,
  schema: argsSchema,
  execute: async (args, context) => {
    const skill = skillPackageSchema.parse({
      id: toAsciiSlug(args.id ?? args.title, `skill_${crypto.randomUUID().slice(0, 8)}`),
      title: args.title,
      description: args.description,
      enabled: false,
      runtime: 'quickjs',
      source: 'chat_generated',
      version: 1,
      triggers: normalizeTriggers(args.triggers ?? [], Object.keys(args.tools)),
      tools: args.tools,
      permissions: {
        httpOrigins: args.httpOrigins,
        storage: args.storage,
        secrets: args.secrets,
      },
      createdAt: new Date().toISOString(),
      skillMd: args.skillMd,
      pluginJs: args.pluginJs,
    });

    const errors = validateScriptedSkill(skill);
    if (errors.length) return `Навык отклонен: ${errors.join(', ')}`;
    const effectiveOrigins = computeEffectiveHttpOrigins(skill.permissions.httpOrigins, context.httpAllowedOrigins ?? []);
    const blockedOrigin = skill.permissions.httpOrigins.find((origin) => !effectiveOrigins.includes('*') && !effectiveOrigins.includes(origin));
    if (blockedOrigin) {
      return `HTTP-домен ${blockedOrigin} не разрешён настройками безопасности бота. Попроси администратора разрешить этот домен.`;
    }

    const saved = await saveSkill(context.store, skill);

    const lines = [
      `Создан навык ${saved.id}.`,
      '',
      `Тулы: ${Object.keys(skill.tools).join(', ')}`,
      `Триггеры: ${skill.triggers.length ? skill.triggers.map((trigger) => `/${trigger.command}->${trigger.tool}`).join(', ') : 'semantic only'}`,
      `HTTP: ${skill.permissions.httpOrigins.length ? skill.permissions.httpOrigins.join(', ') : 'нет'}`,
      `Секреты: ${skill.permissions.secrets.length ? skill.permissions.secrets.join(', ') : 'нет'}`,
      '',
      `Включите с помощью /agentur skill enable ${saved.id}`,
    ];
    if (!skill.triggers.length) {
      lines.push('', 'Навык будет доступен по смысловому выбору агента. Если нужна отдельная Telegram-команда, её можно привязать к конкретному tool отдельной доработкой.');
    }
    if (skill.permissions.secrets.length > 0) {
      lines.push('', 'Перед включением заполните секреты:', ...skill.permissions.secrets.map((key) => `/agentur secret set ${key} <значение>`));
    }
    return lines.join('\n');
  },
};

function normalizeTriggers(triggers: Array<z.output<typeof looseTriggerSchema>>, toolNames: string[]): Array<z.output<typeof triggerSchema>> {
  return triggers.map((trigger) => {
    if (typeof trigger !== 'string') return normalizeTriggerObject(trigger, toolNames);
    if (toolNames.length !== 1) {
      throw new Error('Plain string triggers are only supported when the skill has exactly one tool. Use trigger objects with an explicit tool field.');
    }
    const text = trigger.trim();
    const tool = toolNames[0]!;
    if (!text.startsWith('/')) {
      throw new Error('Plain string triggers must be explicit slash commands like "/balance". Use triggers: [] for semantic-only skills.');
    }
    return { type: 'command', command: normalizeRequiredCommand(text), tool };
  });
}

function normalizeTriggerObject(trigger: Record<string, unknown>, toolNames: string[]): z.output<typeof triggerSchema> {
  const tool = typeof trigger.tool === 'string' && trigger.tool.trim()
    ? trigger.tool.trim()
    : toolNames.length === 1
      ? toolNames[0]!
      : undefined;
  if (trigger.type === 'command') {
    const command = firstString(trigger.command);
    if (!command?.startsWith('/')) {
      throw new Error('Command triggers must use an explicit slash command like "/balance". Use triggers: [] for semantic-only skills.');
    }
    return triggerSchema.parse({ type: 'command', command: normalizeCommand(command), tool });
  }
  return triggerSchema.parse(trigger);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function normalizeCommand(command: string | undefined): string | undefined {
  return command?.replace(/^\//, '').trim();
}

function normalizeRequiredCommand(command: string): string {
  return command.replace(/^\//, '').trim();
}
