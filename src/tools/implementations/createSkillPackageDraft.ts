import { z } from 'zod';
import { saveDraftSkill } from '../../skills/loader';
import { skillPackageSchema, triggerSchema } from '../../skills/schema';
import { computeEffectiveHttpOrigins, validateScriptedSkill } from '../../skills/scriptSandbox';
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
  whenToUse: z.string().min(1).max(1000).describe('Required routing guidance: when the agent should use this skill, and when it should not. Be specific enough to avoid broad accidental activation.'),
  skillMd: z.string().min(1).describe('SKILL.md instructions for when and how to use this skill'),
  pluginJs: z.string().min(1).max(12000).describe('Sandbox plugin.js. Must export/default { tools: { toolName(ctx,args) { ... } } }. Use ctx.api for SDK calls.'),
  tools: z.record(z.string(), toolSpecSchema).describe('Tool specs exposed by plugin.js'),
  triggers: z.array(looseTriggerSchema).optional().default([]).describe('Use [] by default. Only explicit slash commands are supported as direct triggers, e.g. {type:"command",command:"/balance",tool:"check"}. Plain strings must start with /. Never use phrase, keyword, contains, or natural-language triggers.'),
  httpOrigins: z.array(z.string().url()).default([]),
  secrets: z.array(z.string()).optional().default([]).describe('Secret key names required by the package'),
  storage: z.boolean().optional().default(true),
});

export const createSkillPackageDraftTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'create_skill_package_draft',
  description: [
    'Create a disabled chat-local sandbox skill from natural language.',
    'Generate SKILL.md instructions, skill.json metadata, and plugin.js with one or more tools.',
    'The skill runtime is always quickjs. The plugin tool signature is toolName(ctx, args). Use ctx.api.storage, ctx.api.lists, ctx.api.memory, ctx.api.http, ctx.api.mcp, ctx.api.secrets, ctx.api.log, ctx.api.sleep.',
    'SDK contract: export default {tools:{async name(ctx,args){...}}}; SDK is only ctx.api, never a third api arg; HTTP returns {ok,status,text,json,url}; use ctx.api.http.get/post/put/patch/delete/request; secrets/storage are sync, http/lists/memory/sleep are async.',
    'MCP SDK: ctx.api.mcp.listServers(), listTools(serverId), callTool(serverId, toolName, args), readResource(serverId, uri). Use only already connected MCP servers/tools; never connect/spawn/register MCP servers in plugin.js.',
    'Result contract: return {ok:true, reply?: string|null, data?: any, send?: media, error?: {code,message}}; use reply:null when done silently.',
    'Tiny example: export default {tools:{async check(ctx,args){const key=ctx.api.secrets.get("KEY"); const res=await ctx.api.http.get("https://example.com/api",{headers:{Authorization:"Bearer "+key}}); const value=res.json&&res.json.value!==undefined?res.json.value:res.text; return {ok:true, reply:String(value)}}}};',
    'No Node.js APIs, no fs/process/require/import/fetch/eval/Function.',
    'Default to triggers: [] so natural-language requests are selected semantically through whenToUse.',
    'Create a command trigger only when the user explicitly asks for a slash command or the skill is a deterministic repeatable shortcut. Commands must be explicit slash commands, e.g. {type:"command",command:"/balance",tool:"check"}.',
    'Do not invent broad convenience commands for exploratory/agentic skills. Do not create phrase/keyword/contains/message_contains triggers.',
    'For MCP/helper skills, prefer returning structured data/errors instead of raw JSON user-facing replies; let the LLM compose the final answer on semantic calls.',
    'HTTP origins and secrets must be declared explicitly.',
    'The user must enable the draft manually with /agentur skill enable <id>.',
  ].join(' '),
  schema: argsSchema,
  execute: async (args, context) => {
    const skill = skillPackageSchema.parse({
      id: toAsciiSlug(args.id ?? args.title, 'skill'),
      title: args.title,
      whenToUse: args.whenToUse,
      enabled: false,
      runtime: 'quickjs',
      source: 'chat_generated',
      version: 1,
      triggers: normalizeTriggers(args.triggers, Object.keys(args.tools)),
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
    if (errors.length) return `Черновик навыка отклонен: ${errors.join(', ')}`;
    const effectiveOrigins = computeEffectiveHttpOrigins(skill.permissions.httpOrigins, context.httpAllowedOrigins ?? []);
    const blockedOrigin = skill.permissions.httpOrigins.find((origin) => !effectiveOrigins.includes('*') && !effectiveOrigins.includes(origin));
    if (blockedOrigin) {
      return `HTTP-домен ${blockedOrigin} не разрешён настройками безопасности бота. Попроси администратора разрешить этот домен.`;
    }

    await saveDraftSkill(context.store, skill);

    const lines = [
      `Создан черновик навыка ${skill.id}.`,
      '',
      `Тулы: ${Object.keys(skill.tools).join(', ')}`,
      `Триггеры: ${skill.triggers.length ? skill.triggers.map((trigger) => `/${trigger.command}->${trigger.tool}`).join(', ') : 'semantic only'}`,
      `HTTP: ${skill.permissions.httpOrigins.length ? skill.permissions.httpOrigins.join(', ') : 'нет'}`,
      `Секреты: ${skill.permissions.secrets.length ? skill.permissions.secrets.join(', ') : 'нет'}`,
      '',
      `Включите с помощью /agentur skill enable ${skill.id}`,
    ];
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
