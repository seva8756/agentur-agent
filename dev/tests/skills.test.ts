import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { readArtifactText } from '../../src/memory/artifactStore';
import { enableSkill, disableSkill, saveSkill, loadSkills, loadEnabledSkills, deleteSkill, rollbackSkill } from '../../src/skills/loader';
import { matchSkill, matchesCommand } from '../../src/skills/matcher';
import { skillResultText } from '../../src/skills/result';
import { skillPackageSchema } from '../../src/skills/schema';
import { runSkill, runSkillTool } from '../../src/skills/runtime';
import { createBuiltinToolRegistry } from '../../src/tools/builtinTools';
import { ToolContext } from '../../src/tools/types';
import { createSkillPackageTool } from '../../src/tools/implementations/createSkillPackage';
import { readTrustedSkillInstructionsTool } from '../../src/tools/implementations/readTrustedSkillInstructions';
import { runSkillToolTool } from '../../src/tools/implementations/runSkillTool';
import { listSkillPackagesTool } from '../../src/tools/implementations/listSkillPackages';
import { tempStore, msg, packageSkill, skillSchema } from './helpers';

describe('trusted skill instructions', () => {
  it('registers a read-only tool for loaded trusted skills', () => {
    const tool = createBuiltinToolRegistry().get('read_trusted_skill_instructions');
    expect(tool?.description).toContain('SKILL.md');
  });

  it('returns instructions only for an enabled trusted skill by exact id', async () => {
    const { store } = await tempStore();
    const context: ToolContext = {
      store,
      timezone: 'Europe/Moscow',
      trustedSkills: [{
        manifest: {
          id: 'mcp', title: 'MCP', description: 'Use MCP tools for connected services.', enabled: true, runtime: 'native', source: 'system',
          version: 1, triggers: [], tools: {}, createdAt: '2026-06-03T00:00:00.000Z',
        },
        skillMd: 'Use MCP tools for connected services.',
      }, {
        manifest: {
          id: 'disabled', title: 'Disabled', description: 'Disabled test skill.', enabled: false, runtime: 'native', source: 'system',
          version: 1, triggers: [], tools: {}, createdAt: '2026-06-03T00:00:00.000Z',
        },
        skillMd: 'Should not be exposed.',
      }],
    };
    expect(JSON.parse(await readTrustedSkillInstructionsTool.execute({ skillId: 'mcp' }, context))).toEqual({
      ok: true, skillId: 'mcp', instructions: 'Use MCP tools for connected services.',
    });
    expect(JSON.parse(await readTrustedSkillInstructionsTool.execute({ skillId: 'disabled' }, context)).ok).toBe(false);
    expect(JSON.parse(await readTrustedSkillInstructionsTool.execute({ skillId: 'missing' }, context)).ok).toBe(false);
    expect(() => readTrustedSkillInstructionsTool.schema.parse({ skillId: '../mcp' })).toThrow();
  });
});

describe('skills', () => {
  it('validates schema', () => {
    const skill = skillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping list',
      enabled: false,
      trigger: { type: 'command', command: 'buy' },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    });
    expect(skill.id).toBe('shopping_list');
  });

  it('validates scripted skill schema', () => {
    const skill = skillSchema.parse({
      id: 'counter',
      title: 'Counter',
      enabled: false,
      trigger: { type: 'command', command: 'count' },
      code: 'async (ctx) => ({ reply: ctx.text })',
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect('pluginJs' in skill).toBe(true);
  });

  it('matches slash commands against command triggers', () => {
    const skill = skillSchema.parse({
      id: 'jsonbin_fetch',
      title: 'Fetch JSONBin data',
      enabled: true,
      trigger: { type: 'command', command: 'jsonbin' },
      action: { type: 'reply_static', text: 'ok' },
      createdAt: new Date().toISOString(),
    });
    expect(matchesCommand('/jsonbin', 'jsonbin')).toBe(true);
    expect(matchesCommand('/jsonbin@agentbot arg', '/jsonbin')).toBe(true);
    expect(matchesCommand('/jsonbin_extra', 'jsonbin')).toBe(false);
    expect(matchSkill(msg({ text: '/jsonbin' }), [skill])?.skill.id).toBe('jsonbin_fetch');
  });

  it('enables and disables JSON skill', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping list',
      enabled: false,
      trigger: { type: 'command', command: 'buy' },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    });
    await saveSkill(store, skill);
    expect(await enableSkill(store, 'shopping_list')).not.toBeNull();
    expect(await loadEnabledSkills(store)).toHaveLength(1);
    expect(await disableSkill(store, 'shopping_list')).toBe(true);
  });

  it('keeps one revision and restores it without changing enabled state', async () => {
    const { store } = await tempStore();
    const original = packageSkill({
      id: 'weather',
      title: 'Weather v1',
      enabled: true,
      description: 'Use for the current weather.',
      skillMd: '# Weather v1',
      pluginJs: 'export default { tools: { async current() { return { ok: true, reply: "v1" }; } } };',
      tools: { current: { description: 'Get current weather', schema: { type: 'object', properties: {} } } },
      permissions: { httpOrigins: ['https://weather.example'], storage: true, secrets: ['WEATHER_KEY'] },
    });
    await saveSkill(store, original);
    await saveSkill(store, {
      ...original,
      title: 'Weather v2',
      description: 'Use for the forecast.',
      enabled: false,
      skillMd: '# Weather v2',
      pluginJs: 'export default { tools: { async forecast() { return { ok: true, reply: "v2" }; } } };',
      tools: { forecast: { description: 'Get forecast', schema: { type: 'object', properties: {} } } },
      permissions: { httpOrigins: [], storage: false, secrets: [] },
    });

    const restored = await rollbackSkill(store, 'weather');

    expect(restored).toMatchObject({
      title: 'Weather v1',
      enabled: true,
      version: 1,
      skillMd: '# Weather v1',
      tools: { current: { description: 'Get current weather' } },
      permissions: { httpOrigins: ['https://weather.example'], storage: true, secrets: ['WEATHER_KEY'] },
    });
    expect(restored?.pluginJs).toContain('"v1"');
    expect((await loadSkills(store))[0]).toMatchObject({ title: 'Weather v1', enabled: true, version: 1 });
    expect(await fs.readFile(store.resolve('skills', 'custom', 'weather', 'revisions', 'v2', 'snapshot.json'), 'utf8')).toContain('Weather v2');
  });

  it('deletes skill drafts and enabled copies', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping list',
      enabled: false,
      trigger: { type: 'command', command: 'buy' },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    });
    await saveSkill(store, skill);
    await enableSkill(store, 'shopping_list');
    expect(await deleteSkill(store, 'shopping_list')).toBe(true);
    expect(await loadSkills(store)).toHaveLength(0);
    expect(await loadEnabledSkills(store)).toHaveLength(0);
    expect(await deleteSkill(store, 'shopping_list')).toBe(false);
  });

  it('resolves skill commands by visible title', async () => {
    const { store } = await tempStore();
    await saveSkill(store, skillSchema.parse({
      id: 'shopping_list',
      title: 'Shopping List',
      enabled: false,
      trigger: { type: 'command', command: 'buy' },
      action: { type: 'append_to_list', listName: 'shopping', itemExtractionHint: 'item after phrase' },
      createdAt: new Date().toISOString(),
    }));
    expect((await enableSkill(store, 'Shopping List'))?.id).toBe('shopping_list');
    expect(await disableSkill(store, 'Shopping List')).toBe(true);
    await enableSkill(store, 'shopping_list');
    expect(await deleteSkill(store, 'Shopping List')).toBe(true);
    expect(await loadEnabledSkills(store)).toHaveLength(0);
  });

  it('executes enabled skill tool by visible title', async () => {
    const { store } = await tempStore();
    await saveSkill(store, skillSchema.parse({
      id: 'cat_image',
      title: 'Generate Cat Image',
      enabled: false,
      trigger: { type: 'command', command: 'cat' },
      action: { type: 'reply_template', template: 'generated for {{text}}' },
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'Generate Cat Image');
    const result = await runSkillToolTool.execute(
      { skillId: 'Generate Cat Image', toolName: 'main', args: {}, input: 'сгенерь котика' },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(JSON.parse(result)).toEqual({
      ok: true,
      skillId: 'cat_image',
      title: 'Generate Cat Image',
      toolName: 'main',
      reply: 'generated for сгенерь котика',
      data: null,
      send: null,
      error: null,
    });
  });

  it('returns structured no-output result from skill tool', async () => {
    const { store } = await tempStore();
    await saveSkill(store, skillSchema.parse({
      id: 'silent_check',
      title: 'Silent Check',
      enabled: false,
      trigger: { type: 'command', command: 'silent' },
      action: { type: 'remember_fact', extractionHint: 'whole message' },
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'Silent Check');
    const result = await runSkillToolTool.execute(
      { skillId: 'Silent Check', toolName: 'main', args: {}, input: 'проверить условие' },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(JSON.parse(result)).toEqual({
      ok: true,
      skillId: 'silent_check',
      title: 'Silent Check',
      toolName: 'main',
      reply: null,
      data: null,
      send: null,
      error: null,
    });
  });

  it('returns media payload from skill tool without queueing it automatically', async () => {
    const { store } = await tempStore();
    await saveSkill(store, skillSchema.parse({
      id: 'photo_tool',
      title: 'Photo Tool',
      enabled: false,
      trigger: { type: 'command', command: 'photo' },
      code: `async () => ({
        send: { kind: 'photo', url: 'https://cdn.example.com/cat.png', caption: 'Кот' }
      })`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    await enableSkill(store, 'Photo Tool');
    const context: ToolContext = { store, timezone: 'Europe/Moscow', outbox: [] };
    const result = await runSkillToolTool.execute(
      { skillId: 'Photo Tool', toolName: 'main', args: {}, input: 'сгенерь кота' },
      context,
    );
    expect(JSON.parse(result)).toEqual({
      ok: true,
      skillId: 'photo_tool',
      title: 'Photo Tool',
      toolName: 'main',
      reply: 'Кот',
      data: null,
      send: [{ kind: 'photo', url: 'https://cdn.example.com/cat.png', caption: 'Кот' }],
      error: null,
    });
    expect(context.outbox).toEqual([]);
  });

  it('runs scripted skill in sandbox with scoped storage', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'counter',
      title: 'Counter',
      enabled: true,
      trigger: { type: 'command', command: 'count' },
      code: `async (ctx) => {
        const current = await ctx.api.storage.get('count') || 0;
        await ctx.api.storage.set('count', current + 1);
        return { reply: ctx.text + ':' + (current + 1) };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/count' })))).toBe('/count:1');
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/count' })))).toBe('/count:2');
  });

  it('passes extracted ctx.item and stores scripted logs in audit', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'item_logger',
      title: 'Item Logger',
      enabled: true,
      trigger: { type: 'command', command: 'item' },
      code: `async (ctx) => {
        ctx.api.log('item=' + ctx.item);
        return { reply: ctx.item };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/item hello world' })))).toBe('hello world');
    const audit = await store.readJsonl(z.object({
      details: z.object({
        logs: z.array(z.string()).optional(),
      }).passthrough(),
    }).passthrough(), 'skills', 'audit', 'item_logger.jsonl');
    expect(audit.at(-1)?.details.logs).toEqual(['item=hello world']);
  });

  it('supports scripted media send results with public URLs', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'media_sender',
      title: 'Media Sender',
      enabled: true,
      trigger: { type: 'command', command: 'media' },
      code: `async () => ({
        reply: 'Документ готов',
        send: {
          kind: 'file',
          url: 'https://cdn.example.com/report.pdf',
          caption: 'Отчёт',
          filename: 'report.pdf'
        }
      })`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    const result = await runSkill(store, skill, msg({ text: '/media' }));
    expect(result?.reply).toBe('Документ готов');
    expect(result?.send).toEqual([{
      kind: 'file',
      url: 'https://cdn.example.com/report.pdf',
      caption: 'Отчёт',
      filename: 'report.pdf',
    }]);
  });

  it('supports scripted artifact send results', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'html_sender',
      title: 'HTML Sender',
      enabled: true,
      trigger: { type: 'command', command: 'html' },
      code: `async (ctx) => {
        const artifact = await ctx.api.artifacts.createText({
          filename: 'index.html',
          mimeType: 'text/html',
          text: '<h1>Hi</h1>'
        });
        return {
          reply: 'HTML готов',
          send: {
            kind: 'file',
            source: { type: 'artifact', artifactId: artifact.id },
            caption: 'index.html'
          }
        };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    const result = await runSkill(store, skill, msg({ text: '/html' }));
    const artifactId = result?.send?.[0]?.kind !== 'message' && result?.send?.[0]?.source?.type === 'artifact'
      ? result.send[0].source.artifactId
      : '';
    expect(artifactId).toMatch(/^art_/);
    expect((await readArtifactText(store, artifactId)).text).toBe('<h1>Hi</h1>');
    expect(result?.send).toEqual([{
      kind: 'file',
      source: { type: 'artifact', artifactId },
      caption: 'index.html',
    }]);
  });

  it('allows root helper methods without exposing them as tools', async () => {
    const { store } = await tempStore();
    const skill = packageSkill({
      id: 'helper_skill',
      title: 'Helper Skill',
      enabled: true,
      triggers: [{ type: 'command', command: 'helper', tool: 'main' }],
      tools: { main: { description: 'Main tool', schema: { type: 'object', properties: {} } } },
      pluginJs: `export default {
        formatReply(value) {
          return 'helper:' + String(value).trim().toUpperCase();
        },
        tools: {
          async main(ctx) {
            return { ok: true, reply: this.formatReply(ctx.item) };
          }
        }
      };`,
    });

    expect(skillResultText(await runSkill(store, skill, msg({ text: '/helper hello' })))).toBe('helper:HELLO');
    expect(skillResultText(await runSkillTool(store, skill, 'formatReply', { value: 'hello' }, msg({ text: '/helper hello' })))).toContain('does not contain tool');
  });

  it('rejects scripted media send results with non-public URLs', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'unsafe_media_sender',
      title: 'Unsafe Media Sender',
      enabled: true,
      trigger: { type: 'command', command: 'unsafe' },
      code: `async () => ({
        send: { kind: 'photo', url: 'data:image/png;base64,AAAA', caption: 'bad' }
      })`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/unsafe' })))).toBe('Skill Unsafe Media Sender did not complete.');
  });

  it('lets scripted skills delete scoped storage keys', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'storage_delete',
      title: 'Storage Delete',
      enabled: true,
      trigger: { type: 'command', command: 'drop' },
      code: `async (ctx) => {
        ctx.api.storage.set('token', 'value');
        ctx.api.storage.delete('token');
        ctx.api.storage.set('legacy', 'value');
        ctx.api.storage.set('legacy', null);
        return { reply: String(ctx.api.storage.get('token')) + ':' + String(ctx.api.storage.get('legacy')) };
      }`,
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    });
    expect(skillResultText(await runSkill(store, skill, msg({ text: '/drop' })))).toBe('null:null');
  });

  it('lets scripted skills use generic HTTP methods with request limits', async () => {
    const { store } = await tempStore();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      return new Response(JSON.stringify({
        method: init?.method,
        path: new URL(requestUrl).pathname,
        body: init?.body,
        header: init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>)['x-test']
          : null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const skill = skillSchema.parse({
        id: 'scripted_http_patch',
        title: 'Scripted HTTP PATCH',
        enabled: true,
        trigger: { type: 'command', command: 'patch' },
        code: `async (ctx) => {
          const res = await ctx.api.http.request({
            method: 'PATCH',
            url: 'https://api.example/items/1',
            headers: { 'x-test': 'ok' },
            body: { text: ctx.text }
          });
          return { reply: res.json.method + ':' + res.json.path + ':' + res.json.header + ':' + res.json.body };
        }`,
        permissions: { httpOrigins: ['https://api.example'] },
        version: 1,
        createdAt: new Date().toISOString(),
      });
      const reply = await runSkill(store, skill, msg({ text: '/patch hi' }), {
        httpAllowedOrigins: ['*'],
        httpTimeoutMs: 1000,
        httpMaxRequestBytes: 128,
        httpMaxResponseBytes: 1024,
      });
      expect(skillResultText(reply)).toContain('PATCH:/items/1:ok:{"text":"/patch hi"}');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('blocks oversized scripted HTTP request bodies before sending', async () => {
    const { store } = await tempStore();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const skill = skillSchema.parse({
        id: 'scripted_oversized_http_body',
        title: 'Scripted Oversized HTTP Body',
        enabled: true,
        trigger: { type: 'command', command: 'big' },
        code: `async (ctx) => {
          await ctx.api.http.post('https://api.example/hook', '0123456789');
          return { reply: 'sent' };
        }`,
        permissions: { httpOrigins: ['https://api.example'] },
        version: 1,
        createdAt: new Date().toISOString(),
      });
      const reply = await runSkill(store, skill, msg({ text: '/big' }), {
        httpAllowedOrigins: ['*'],
        httpTimeoutMs: 1000,
        httpMaxRequestBytes: 5,
        httpMaxResponseBytes: 1024,
      });
      expect(skillResultText(reply)).toBe('Skill Scripted Oversized HTTP Body did not complete.');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('does not enable scripted skill that fails static validation', async () => {
    const { store } = await tempStore();
    await saveSkill(store, skillSchema.parse({
      id: 'bad_script',
      title: 'Bad Script',
      enabled: false,
      trigger: { type: 'command', command: 'bad' },
      code: 'async () => ({ reply: String(process.env.SECRET) })',
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    await expect(enableSkill(store, 'bad_script')).rejects.toThrow('forbidden token');
    expect(await loadEnabledSkills(store)).toHaveLength(0);
  });

  it('creates skill drafts through tool', async () => {
    const { store } = await tempStore();
    const result = await createSkillPackageTool.execute(
      {
        title: 'Echo Script',
        description: 'Use when the user asks to echo text.',
        skillMd: '# Echo Script\n\nUse when the user asks to echo text.',
        pluginJs: 'export default { tools: { async echo(ctx) { return { ok: true, reply: ctx.text }; } } };',
        tools: { echo: { description: 'Echo text', schema: { type: 'object', properties: {} } } },
        triggers: [{ type: 'command', command: '/echo', tool: 'echo' }],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('"ok":true');
    expect(result).toContain('"id":"echo_script"');
    const skills = await loadSkills(store);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('Use when the user asks to echo text.');
  });

  it('keeps skill drafts semantic-only by default and mentions optional command binding', async () => {
    const { store } = await tempStore();
    const result = await createSkillPackageTool.execute(
      {
        title: 'Semantic Echo',
        description: 'Use when the user asks to echo text.',
        skillMd: '# Semantic Echo\n\nUse when the user asks to echo text.',
        pluginJs: 'export default { tools: { async echo(ctx) { return { ok: true, reply: ctx.text }; } } };',
        tools: { echo: { description: 'Echo text', schema: { type: 'object', properties: {} } } },
        triggers: [],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('"triggers":[]');
    expect(result).toContain('semantic selection');
    const skills = await loadSkills(store);
    expect(skills[0]?.triggers).toEqual([]);
  });

  it('normalizes explicit slash string triggers as commands when creating one-tool skill drafts', async () => {
    const { store } = await tempStore();
    const result = await createSkillPackageTool.execute(
      {
        title: 'Balance Check',
        description: 'Use when the user asks for balance.',
        skillMd: '# Balance Check\n\nUse when the user asks for balance.',
        pluginJs: 'export default { tools: { async check() { return { ok: true, reply: "ok" }; } } };',
        tools: { check: { description: 'Check balance', schema: { type: 'object', properties: {} } } },
        triggers: ['/balance', '/баланс'],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('"ok":true');
    const [skill] = await loadSkills(store);
    expect(skill?.triggers).toEqual([
      { type: 'command', command: 'balance', tool: 'check' },
      { type: 'command', command: 'баланс', tool: 'check' },
    ]);
  });

  it('rejects non-slash plain string triggers', async () => {
    const { store } = await tempStore();
    await expect(createSkillPackageTool.execute(
      {
        title: 'Balance Check',
        description: 'Use when the user asks for balance.',
        skillMd: '# Balance Check\n\nUse when the user asks for balance.',
        pluginJs: 'export default { tools: { async check() { return { ok: true, reply: "ok" }; } } };',
        tools: { check: { description: 'Check balance', schema: { type: 'object', properties: {} } } },
        triggers: ['баланс'],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    )).rejects.toThrow('Plain string triggers must be explicit slash commands');
  });

  it('rejects message_contains triggers', () => {
    expect(() => skillPackageSchema.parse({
      id: 'contains_trigger',
      title: 'Contains Trigger',
      enabled: false,
      runtime: 'quickjs',
      source: 'chat_generated',
      version: 1,
      triggers: [{ type: 'message_contains', phrases: ['ping'], tool: 'main' }],
      tools: { main: { description: 'Main tool', schema: { type: 'object', properties: {} } } },
      permissions: { httpOrigins: [], storage: true, secrets: [] },
      createdAt: new Date().toISOString(),
      skillMd: '# Contains Trigger',
      pluginJs: 'export default { tools: { async main() { return { ok: true, reply: "ok" }; } } };',
    })).toThrow();
  });

  it('normalizes loose trigger objects when creating one-tool skill drafts', async () => {
    const { store } = await tempStore();
    const result = await createSkillPackageTool.execute(
      {
        title: 'Loose Trigger',
        description: 'Use when the user asks for a loose trigger test.',
        skillMd: '# Loose Trigger\n\nUse when testing loose triggers.',
        pluginJs: 'export default { tools: { async inspect() { return { ok: true, reply: "ok" }; } } };',
        tools: { inspect: { description: 'Inspect', schema: { type: 'object', properties: {} } } },
        triggers: [{ type: 'command', command: '/inspect' }],
        httpOrigins: [],
        secrets: [],
        storage: true,
      },
      { store, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('"ok":true');
    const [skill] = await loadSkills(store);
    expect(skill?.triggers).toEqual([{ type: 'command', command: 'inspect', tool: 'inspect' }]);
  });

  it('normalizes short scripted skill errors', async () => {
    const { store } = await tempStore();
    const skill = packageSkill({
      id: 'short_error',
      title: 'Short Error',
      pluginJs: 'export default { tools: { async main() { return { ok: false, error: "missing token" }; } } };',
    });
    const reply = await runSkill(store, skill, msg({ text: '/short_error' }));
    expect(reply?.ok).toBe(false);
    expect(reply?.error).toEqual({ code: 'skill_error', message: 'missing token' });
  });

  it('lists skills in lightweight format by default and full format by name', async () => {
    const { store } = await tempStore();
    
    // Создаем выключенный скриптовый навык
    await saveSkill(store, skillSchema.parse({
      id: 'test_script_skill',
      title: 'Test Script',
      enabled: false,
      trigger: { type: 'command', command: 'test' },
      code: 'async () => ({ reply: "hello" })',
      permissions: { httpOrigins: [] },
      version: 1,
      createdAt: new Date().toISOString(),
    }));

    // 1. Проверяем вызов без параметров (облегченный формат)
    const listResult = await listSkillPackagesTool.execute({}, { store, timezone: 'UTC' });
    const parsedList = JSON.parse(listResult);
    
    expect(parsedList.skills).toHaveLength(1);
    expect(parsedList.skills[0].id).toBe('test_script_skill');
    expect(parsedList.skills[0].pluginJs).toBeUndefined();
    expect(parsedList.skills[0].hasPluginJs).toBe(true);

    // 2. Проверяем вызов с указанием конкретного имени
    const detailsResult = await listSkillPackagesTool.execute({ name: 'Test Script' }, { store, timezone: 'UTC' });
    const parsedDetails = JSON.parse(detailsResult);
    
    expect(parsedDetails.ok).toBe(true);
    expect(parsedDetails.skill.id).toBe('test_script_skill');
    expect(parsedDetails.skill.pluginJs).toContain('async () => ({ reply: "hello" })');

    // 3. Проверяем вызов с несуществующим именем
    const missingResult = await listSkillPackagesTool.execute({ name: 'Unknown Skill' }, { store, timezone: 'UTC' });
    const parsedMissing = JSON.parse(missingResult);
    expect(parsedMissing.ok).toBe(false);
    expect(parsedMissing.error).toContain('not found');
  });
});
