import { z } from 'zod';
import { saveDraftSkill } from '../../skills/loader';
import { actionSchema, microSkillSchema, triggerSchema } from '../../skills/schema';
import { isOriginAllowed } from '../../skills/runtime';
import { toAsciiSlug } from '../../utils/slug';
import { AgentTool } from '../types';

const argsSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  trigger: triggerSchema,
  action: actionSchema,
});

export const createMicroSkillDraftTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'create_micro_skill_draft',
  description:
    'Create a safe declarative JSON micro-skill draft from natural language. Use ASCII id if possible; if unsure omit id. trigger and action must be objects, not strings. It is not enabled until command confirmation.',
  schema: argsSchema,
  execute: async (args, context) => {
    const skill = microSkillSchema.parse({
      id: toAsciiSlug(args.id ?? args.title, 'skill'),
      title: args.title,
      trigger: args.trigger,
      action: args.action,
      enabled: false,
      createdAt: new Date().toISOString(),
    });
    const blockedOrigin = findBlockedHttpOrigin(skill.action, context.httpAllowedOrigins ?? []);
    if (blockedOrigin) {
      return `HTTP-домен ${blockedOrigin} не разрешён настройками безопасности бота. Попроси администратора разрешить этот домен.`;
    }
    const oversizedBody = findOversizedBodyTemplate(skill.action, context.httpMaxRequestBytes);
    if (oversizedBody) {
      return `HTTP bodyTemplate слишком большой: ${oversizedBody.sizeBytes} байт при лимите ${oversizedBody.maxBytes}.`;
    }
    await saveDraftSkill(context.store, skill);
    return `Created draft skill ${skill.id}. Enable with /agentur skill enable ${skill.id}`;
  },
};

function findBlockedHttpOrigin(action: z.output<typeof actionSchema>, allowedOrigins: string[]): string | null {
  const actions = action.type === 'chain' ? action.actions : [action];
  for (const item of actions) {
    if (item.type !== 'http_request') continue;
    const origin = new URL(item.url).origin;
    if (!isOriginAllowed(origin, allowedOrigins)) return origin;
  }
  return null;
}

function findOversizedBodyTemplate(
  action: z.output<typeof actionSchema>,
  maxBytes?: number,
): { sizeBytes: number; maxBytes: number } | null {
  if (!maxBytes) return null;
  const actions = action.type === 'chain' ? action.actions : [action];
  for (const item of actions) {
    if (item.type !== 'http_request' || !item.bodyTemplate) continue;
    const sizeBytes = Buffer.byteLength(item.bodyTemplate, 'utf8');
    if (sizeBytes > maxBytes) return { sizeBytes, maxBytes };
  }
  return null;
}
