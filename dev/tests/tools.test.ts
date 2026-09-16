import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { allocateContextStages } from '../../src/agent/context';
import { limitOutput } from '../../src/agent/outputLimiter';
import { runToolLoop } from '../../src/llm/toolLoop';
import { appendRecentMessage } from '../../src/memory/recentMessages';
import { createTextArtifact } from '../../src/memory/artifactStore';
import { persistIncomingAttachments } from '../../src/memory/attachmentStore';
import { runCronJob } from '../../src/scheduler/jobRuntime';
import { cronJobSchema } from '../../src/scheduler/schema';
import { skillResultText, textSkillResult } from '../../src/skills/result';
import { runSkill } from '../../src/skills/runtime';
import { ToolRegistry } from '../../src/tools/registry';
import { createBuiltinToolRegistry } from '../../src/tools/builtinTools';
import { AgentTool, ToolContext, toOpenAITool } from '../../src/tools/types';
import { createCronJobTool } from '../../src/tools/implementations/createCronJob';
import { createSkillPackageTool } from '../../src/tools/implementations/createSkillPackage';
import { grepChatTool } from '../../src/tools/implementations/grepChat';
import { readChatTool } from '../../src/tools/implementations/readChat';
import { listChatFilesTool } from '../../src/tools/implementations/listChatFiles';
import { readAgentDocsTool } from '../../src/tools/implementations/readAgentDocs';
import { buildContextPolicy } from '../../src/agent/context/policy';
import { TELEGRAM_CHAT_ID, tempStore, msg, skillSchema } from './helpers';

describe('agent docs', () => {
  it('registers the documentation tool for model discovery', () => {
    const tool = createBuiltinToolRegistry().get('read_agent_docs');
    expect(tool?.description).toContain('why it did or did not respond');
  });

  it('loads concise user-facing capabilities and troubleshooting guidance', async () => {
    const docs = await readAgentDocsTool.execute({}, { store: (await tempStore()).store, timezone: 'Europe/Moscow' });
    expect(docs).toContain('/agentur help');
    expect(docs).toContain('/agentur doctor');
    expect(docs).toContain('smart');
    expect(docs).toContain('Если что-то не работает');
    expect(docs.length).toBeLessThanOrEqual(12_000);
  });
});

describe('chat knowledge tools', () => {
  it('searches chat-local messages and reads the returned virtual path', async () => {
    const { store } = await tempStore();
    await appendRecentMessage(store, {
      id: 77,
      chatId: TELEGRAM_CHAT_ID,
      displayName: 'Seva',
      text: 'Оплатить счёт необходимо до 25 сентября.',
      date: '2026-09-16T10:00:00.000Z',
      isBot: false,
      attachments: [{ kind: 'file', filename: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }],
    });
    const context: ToolContext = { store, timezone: 'Europe/Moscow' };

    const grep = await grepChatTool.execute({
      pattern: 'оплатить', path: '/chat', regex: false, ignore_case: true, before_context: 1, after_context: 1, max_results: 20,
    }, context);
    expect(grep).toContain('/chat/messages/recent.jsonl:1:');
    expect(grep).toContain('Оплатить счёт');

    const read = await readChatTool.execute({ path: '/chat/messages/recent.jsonl', start_line: 1, end_line: 20 }, context);
    expect(read).toContain('"displayName":"Seva"');
    expect(read).toContain('Оплатить счёт необходимо');
  });

  it('searches text artifacts and keeps virtual paths read-only', async () => {
    const { store } = await tempStore();
    await createTextArtifact(store, {
      filename: 'quarterly-report.md',
      mimeType: 'text/markdown',
      text: '# Report\nRevenue grew by 12%.',
    }, { kind: 'agent' });
    const context: ToolContext = { store, timezone: 'Europe/Moscow' };
    const result = await grepChatTool.execute({
      pattern: 'revenue\\s+grew', path: '/chat/artifacts', regex: true, ignore_case: true, before_context: 0, after_context: 0, max_results: 20,
    }, context);
    expect(result).toContain('/chat/artifacts/quarterly-report.md--');
    expect(result).toContain('Revenue grew by 12%.');
    await expect(readChatTool.execute({ path: '/chat/../secrets.txt', start_line: 1, end_line: 1 }, context)).rejects.toThrow('/chat');
  });

  it('indexes extracted text from a separately stored incoming attachment', async () => {
    const { store } = await tempStore();
    const attachments = await persistIncomingAttachments(store, {
      messageId: 91,
      date: new Date('2026-09-16T10:00:00.000Z'),
      attachments: [{
        kind: 'file', filename: 'plan.md', mimeType: 'text/markdown', sizeBytes: 44,
        extractedText: '# Plan\nShip knowledge retrieval on Friday.',
      }],
    });
    await appendRecentMessage(store, {
      id: 91, chatId: TELEGRAM_CHAT_ID, text: '[файл: plan.md]', date: '2026-09-16T10:00:00.000Z', isBot: false, attachments,
    });
    const context: ToolContext = { store, timezone: 'Europe/Moscow' };
    const grep = await grepChatTool.execute({
      pattern: 'knowledge retrieval', path: '/chat/attachments', regex: false, ignore_case: true, before_context: 0, after_context: 0, max_results: 20,
    }, context);
    expect(grep).toContain('/chat/attachments/plan.md--');
    expect(grep).toContain('Ship knowledge retrieval on Friday.');
  });

  it('stores original bytes alongside metadata and extracted text for an incoming attachment', async () => {
    const { store } = await tempStore();
    const original = new TextEncoder().encode('# Plan\nKeep the source file.');
    const attachments = await persistIncomingAttachments(store, {
      messageId: 92,
      date: new Date('2026-09-16T10:00:00.000Z'),
      attachments: [{
        kind: 'file', filename: 'plan.md', mimeType: 'text/markdown', originalBytes: original,
        extractedText: new TextDecoder().decode(original),
      }],
    });
    const attachmentId = attachments?.[0]?.attachmentId;
    expect(attachmentId).toBeDefined();
    expect(await fs.readFile(store.resolve('attachments', attachmentId!, 'original'))).toEqual(Buffer.from(original));
    const meta = JSON.parse(await fs.readFile(store.resolve('attachments', attachmentId!, 'meta.json'), 'utf8'));
    expect(meta.originalStored).toBe(true);
  });

  it('lists only available attachments and artifacts as readable virtual files', async () => {
    const { store } = await tempStore();
    await persistIncomingAttachments(store, {
      messageId: 92,
      date: new Date('2026-09-16T10:00:00.000Z'),
      attachments: [{ kind: 'file', filename: 'plan.md', mimeType: 'text/markdown', extractedText: '# Plan' }],
    });
    await createTextArtifact(store, {
      filename: 'report.md', mimeType: 'text/markdown', text: '# Report',
    }, { kind: 'agent' });

    const inventory = await listChatFilesTool.execute({}, { store, timezone: 'Europe/Moscow' });
    expect(inventory).toContain('Attachments:');
    expect(inventory).toContain('/chat/attachments/plan.md--');
    expect(inventory).toContain('meta.txt, content.txt');
    expect(inventory).toContain('Artifacts:');
    expect(inventory).toContain('/chat/artifacts/report.md--');
    expect(inventory).not.toContain('/chat/messages');
  });

  it('rejects regex features that could cause unsafe backtracking', async () => {
    const { store } = await tempStore();
    await expect(grepChatTool.execute({
      pattern: '(a+)+$', path: '/chat', regex: true, ignore_case: true, before_context: 0, after_context: 0, max_results: 20,
    }, { store, timezone: 'Europe/Moscow' })).rejects.toThrow('groups are not supported');
  });
});

describe('cron schema', () => {
  it('validates cron expression', () => {
    expect(() => cronJobSchema.parse({
      id: 'cron_test',
      title: 'Test',
      enabled: false,
      cron: '0 10 * * 3',
      timezone: 'Europe/Amsterdam',
      action: { type: 'send_static_message', text: 'hi' },
      createdAt: new Date().toISOString(),
    })).not.toThrow();
    expect(() => cronJobSchema.parse({
      id: 'cron_bad', title: 'Bad', enabled: false, cron: 'bad', timezone: 'Europe/Amsterdam', action: { type: 'send_static_message', text: 'hi' }, createdAt: new Date().toISOString(),
    })).toThrow();
  });

  it('supports cron actions that run enabled skills', async () => {
    const sent: Array<{ text: string; threadId?: number | null }> = [];
    const toolThreads: Array<number | null | undefined> = [];
    await runCronJob(
      cronJobSchema.parse({
        id: 'cron_skill_test',
        title: 'Run skill',
        enabled: true,
        cron: '* * * * *',
        timezone: 'UTC',
        threadId: 42,
        action: { type: 'run_skill_tool', skillId: 'hello', toolName: 'main', args: {}, text: 'cron input', sendResult: true },
        createdAt: new Date().toISOString(),
      }),
      {
        sendMessage: async (result, threadId) => {
          sent.push({ text: skillResultText(result) ?? '', threadId });
        },
        askAgent: async () => 'agent',
        runSkillTool: async (skillId, _toolName, _args, text, threadId) => {
          toolThreads.push(threadId);
          return textSkillResult(`${skillId}:${text}`);
        },
      },
    );
    expect(toolThreads).toEqual([42]);
    expect(sent).toEqual([{ text: 'hello:cron input', threadId: 42 }]);
  });

  it('passes cron job context to agent actions', async () => {
    const job = cronJobSchema.parse({
      id: 'cron_agent_test',
      title: 'Ask agent',
      enabled: true,
      cron: '* * * * *',
      timezone: 'UTC',
      threadId: 42,
      action: { type: 'ask_agent_and_send', prompt: 'cron prompt' },
      createdAt: new Date().toISOString(),
    });
    const agentCalls: Array<{ prompt: string; threadId?: number | null }> = [];
    const sent: Array<{ text: string; threadId?: number | null }> = [];

    await runCronJob(job, {
      sendMessage: async (result, threadId) => {
        sent.push({ text: skillResultText(result) ?? '', threadId });
      },
      askAgent: async (prompt, passedJob) => {
        agentCalls.push({ prompt, threadId: passedJob.threadId });
        return 'agent reply';
      },
      runSkillTool: async () => null,
    });

    expect(agentCalls).toEqual([{ prompt: 'cron prompt', threadId: 42 }]);
    expect(sent).toEqual([{ text: 'agent reply', threadId: 42 }]);
  });

  it('keeps cron silent when skill has no reply', async () => {
    const sent: string[] = [];
    await runCronJob(
      cronJobSchema.parse({
        id: 'cron_silent_skill_test',
        title: 'Check condition',
        enabled: true,
        cron: '* * * * *',
        timezone: 'UTC',
        action: { type: 'run_skill_tool', skillId: 'silent', toolName: 'main', args: {}, text: 'cron input', sendResult: true },
        createdAt: new Date().toISOString(),
      }),
      {
        sendMessage: async (result) => {
          sent.push(skillResultText(result) ?? '');
        },
        askAgent: async () => 'agent',
        runSkillTool: async () => null,
      },
    );
    expect(sent).toEqual([]);
  });

  it('deletes cron jobs from scheduler storage by visible title', async () => {
    const { scheduler } = await tempStore();
    await scheduler.saveDraft(cronJobSchema.parse({
      id: 'cron_delete_test',
      title: 'Delete me',
      enabled: false,
      cron: '* * * * *',
      timezone: 'UTC',
      action: { type: 'send_static_message', text: 'hi' },
      createdAt: new Date().toISOString(),
    }));
    expect(await scheduler.delete('Delete me')).toBe(true);
    expect(await scheduler.list()).toHaveLength(0);
    expect(await scheduler.delete('cron_delete_test')).toBe(false);
  });
});

describe('output limiter', () => {
  it('cuts to maximum characters', () => {
    expect(limitOutput('a'.repeat(100), 20).length).toBeLessThanOrEqual(20);
  });
});

describe('tool loop', () => {
  it('adds a native tool-calling instruction when tools are available', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop',
      description: 'noop',
      schema: z.object({}),
      execute: async () => 'ok',
    });
    let sawNotice = false;
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            sawNotice = messages.some((message: any) =>
              message.role === 'system'
              && String(message.content).includes('Native tool calling is available')
              && String(message.content).includes('use only the API-provided tool_calls')
              && String(message.content).includes('Do not write tool calls')
            );
            return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
          },
        },
      },
    };
    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'system', content: 'base' }, { role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
    });
    expect(result).toBe('ok');
    expect(sawNotice).toBe(true);
  });

  it('stops at max steps', async () => {
    const registry = new ToolRegistry();
    const tool: AgentTool<Record<string, never>> = {
      name: 'noop',
      description: 'noop',
      schema: z.object({}),
      execute: async () => 'ok',
    };
    registry.register(tool);
    const fakeClient = {
      chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'noop', arguments: '{}' } }] } }] }) } },
    };
    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
    });
    expect(result).toContain('internal action limit');
  });

  it('returns structured validation errors to the model when tool arguments are invalid', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'needs_object',
      description: 'needs object',
      schema: z.object({ item: z.object({ name: z.string() }) }),
      execute: async () => 'ok',
    });
    const toolMessages: string[] = [];
    let calls = 0;
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            calls += 1;
            const lastTool = messages.filter((message: any) => message.role === 'tool').at(-1);
            if (lastTool) {
              toolMessages.push(lastTool.content);
              return { choices: [{ message: { role: 'assistant', content: 'handled' } }] };
            }
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'bad-1',
                    type: 'function',
                    function: { name: 'needs_object', arguments: '{"item":"wrong"}' },
                  }],
                },
              }],
            };
          },
        },
      },
    };
    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
    });
    expect(result).toBe('handled');
    expect(calls).toBe(2);
    expect(JSON.parse(toolMessages[0]!).error.code).toBe('invalid_tool_arguments');
  });

  it('retries transient LLM failures inside the tool loop without rerunning tools', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => 'tool result');
    registry.register({
      name: 'side_effect',
      description: 'side effect',
      schema: z.object({}),
      execute,
    });
    let calls = 0;
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            calls += 1;
            if (!messages.some((message: any) => message.role === 'tool')) {
              return {
                choices: [{
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'side_effect', arguments: '{}' },
                    }],
                  },
                }],
              };
            }
            if (calls === 2) throw new Error('Request timed out.');
            return { choices: [{ message: { role: 'assistant', content: 'handled after retry' } }] };
          },
        },
      },
    };
    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 3,
      completionRetries: 1,
    });
    expect(result).toBe('handled after retry');
    expect(calls).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('trims oversized tool observations before the next tool-loop iteration', async () => {
    const registry = new ToolRegistry();
    const hugeResult = 'данные '.repeat(10000);
    registry.register({
      name: 'huge_tool',
      description: 'huge',
      schema: z.object({}),
      execute: async () => hugeResult,
    });
    let capturedToolContent = '';
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            const lastTool = messages.filter((message: any) => message.role === 'tool').at(-1);
            if (lastTool) {
              capturedToolContent = lastTool.content;
              return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
            }
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'huge-1',
                    type: 'function',
                    function: { name: 'huge_tool', arguments: '{}' },
                  }],
                },
              }],
            };
          },
        },
      },
    };
    const budgetConfig = { contextWindowTokens: 2000, contextBudgetTokens: 100, replyMaxTokens: 10 };
    const policy = buildContextPolicy(budgetConfig);
    policy.stages.toolObservation.maxTokens = 20;
    const allocation = allocateContextStages(
      [{ kind: 'user', content: 'go' }],
      budgetConfig,
    );

    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
      contextBudget: { allocation, policy },
    });

    expect(result).toBe('done');
    expect(capturedToolContent.length).toBeLessThan(hugeResult.length);
    expect(capturedToolContent).toContain('[truncated: tool result exceeded context budget]');
  });

  it('counts tool schemas when fitting tool observations', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'schema_heavy_tool',
      description: 'описание '.repeat(2000),
      schema: z.object({}),
      execute: async () => 'small result',
    });
    let capturedToolContent = '';
    const fakeClient = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            const lastTool = messages.filter((message: any) => message.role === 'tool').at(-1);
            if (lastTool) {
              capturedToolContent = lastTool.content;
              return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
            }
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'schema-heavy-1',
                    type: 'function',
                    function: { name: 'schema_heavy_tool', arguments: '{}' },
                  }],
                },
              }],
            };
          },
        },
      },
    };
    const budgetConfig = { contextWindowTokens: 1000, contextBudgetTokens: 100, replyMaxTokens: 10 };
    const policy = buildContextPolicy(budgetConfig);
    policy.stages.toolObservation.maxTokens = 20;
    const allocation = allocateContextStages(
      [{ kind: 'user', content: 'go' }],
      budgetConfig,
    );

    const result = await runToolLoop({
      client: fakeClient as any,
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      registry,
      context: { store: (await tempStore()).store, timezone: 'UTC' },
      maxSteps: 2,
      contextBudget: { allocation, policy },
    });

    expect(result).toBe('done');
    expect(capturedToolContent).toBe('[Tool result omitted: context window exhausted.]');
  });

});

describe('tool schemas', () => {
  it('exposes nested package fields as objects for OpenAI tool calling', () => {
    const skillSchema = toOpenAITool(createSkillPackageTool).function.parameters as any;
    expect(skillSchema.properties.triggers.items.anyOf[0].type).toBe('object');
    expect(skillSchema.properties.triggers.items.anyOf[1].type).toBe('string');
    expect(skillSchema.properties.tools.additionalProperties.type).toBe('object');

    const cronSchema = toOpenAITool(createCronJobTool).function.parameters as any;
    expect(cronSchema.properties.action.oneOf[0].type).toBe('object');
    expect(cronSchema.required).not.toContain('id');
  });

  it('normalizes natural-language cron ids before saving drafts', async () => {
    const { store, scheduler } = await tempStore();
    const result = await createCronJobTool.execute(
      {
        id: 'я спамер',
        title: 'я спамер',
        cron: '*/3 * * * *',
        action: { type: 'send_static_message', text: 'Привет мир' },
      },
      { store, scheduler, timezone: 'Europe/Moscow' },
    );
    expect(result).toContain('cron_ya_spamer');
    expect((await scheduler.list())[0]?.id).toBe('cron_ya_spamer');
  });

  it('stores Telegram thread id on cron drafts created from a topic message', async () => {
    const { store, scheduler } = await tempStore();
    await createCronJobTool.execute(
      {
        title: 'Topic reminder',
        cron: '*/5 * * * *',
        action: { type: 'send_static_message', text: 'Проверить topic' },
      },
      { store, scheduler, timezone: 'Europe/Moscow', currentMessage: msg({ threadId: 777 }) },
    );
    expect((await scheduler.list())[0]?.threadId).toBe(777);
  });

  it('runs template and blocks non-allowlisted HTTP actions', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'webhook_test',
      title: 'Webhook test',
      enabled: true,
      trigger: { type: 'command', command: 'ping' },
      action: {
        type: 'chain',
        actions: [
          { type: 'reply_template', template: 'item={{item}} user={{username}}' },
          { type: 'http_request', method: 'GET', url: 'https://example.com/hook?text={{item}}' },
        ],
      },
      createdAt: new Date().toISOString(),
    });
    const reply = await runSkill(
      store,
      skill,
      msg({ text: 'ping hello', username: 'seva' }),
      { httpAllowedOrigins: [], httpTimeoutMs: 100 },
    );
    expect(skillResultText(reply)).toContain('item=hello user=seva');
    expect(skillResultText(reply)).toContain('blocked by security settings');
  });

  it('allows wildcard HTTP origins with response size limits', async () => {
    const { store } = await tempStore();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      return new Response(JSON.stringify({ path: new URL(requestUrl).pathname }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const skill = skillSchema.parse({
        id: 'wildcard_http_test',
        title: 'Wildcard HTTP test',
        enabled: true,
        trigger: { type: 'command', command: 'ping' },
        action: {
          type: 'http_request',
          method: 'GET',
          url: 'https://unknown.example/hook?text={{item}}',
          responseTemplate: 'status={{status}} path={{path}} json={{json.path}} body={{body}}',
        },
        createdAt: new Date().toISOString(),
      });
      const reply = await runSkill(store, skill, msg({ text: 'ping hello' }), {
        httpAllowedOrigins: ['*'],
        httpTimeoutMs: 1000,
        httpMaxRequestBytes: 128,
        httpMaxResponseBytes: 1024,
      });
      expect(skillResultText(reply)).toContain('status=200');
      expect(skillResultText(reply)).toContain('path=/hook');
      expect(skillResultText(reply)).toContain('json=/hook');
      expect(skillResultText(reply)).toContain('/hook');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('blocks oversized HTTP request bodies before sending', async () => {
    const { store } = await tempStore();
    const skill = skillSchema.parse({
      id: 'oversized_http_body_test',
      title: 'Oversized HTTP body test',
      enabled: true,
      trigger: { type: 'command', command: 'ping' },
      action: {
        type: 'http_request',
        method: 'POST',
        url: 'https://example.com/hook',
        bodyTemplate: '0123456789',
      },
      createdAt: new Date().toISOString(),
    });
    const reply = await runSkill(store, skill, msg({ text: 'ping' }), {
      httpAllowedOrigins: ['*'],
      httpTimeoutMs: 100,
      httpMaxRequestBytes: 5,
      httpMaxResponseBytes: 1024,
    });
    expect(skillResultText(reply)).toContain('HTTP request body exceeds 5 bytes');
  });
});

describe('execute_http_query tool', () => {
  it('executes simple GET query and returns results when origin is allowed', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ some: 'data' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await executeHttpQueryTool.execute(
        { url: 'https://api.external.com/v1/info', method: 'GET' },
        { store, timezone: 'UTC', httpAllowedOrigins: ['https://api.external.com'] }
      );
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe(200);
      expect(JSON.parse(parsed.body)).toEqual({ some: 'data' });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('blocks private IPs and localhost hosts', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');
    
    const resultLocalhost = await executeHttpQueryTool.execute(
      { url: 'http://localhost/secret', method: 'GET' },
      { store, timezone: 'UTC', httpAllowedOrigins: ['*'] }
    );
    expect(resultLocalhost).toContain('forbidden');

    const resultLoopbackIp = await executeHttpQueryTool.execute(
      { url: 'http://127.0.0.1/admin', method: 'GET' },
      { store, timezone: 'UTC', httpAllowedOrigins: ['*'] }
    );
    expect(resultLoopbackIp).toContain('forbidden');
  });

  it('blocks hosts configured in HTTP_BLOCKED_HOSTS', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');
    const result = await executeHttpQueryTool.execute(
      { url: 'https://staging.example.com/health', method: 'GET' },
      { store, timezone: 'UTC', httpAllowedOrigins: ['*'], httpBlockedHosts: ['api.example.com', 'Staging.example.com'] },
    );
    expect(result).toContain('forbidden');
  });

  it('blocks private networks unless the hostname is explicitly allowed', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');
    const blocked = await executeHttpQueryTool.execute(
      { url: 'http://192.168.1.10/health', method: 'GET' },
      { store, timezone: 'UTC', httpAllowedOrigins: ['*'] },
    );
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    let allowed: string;
    let blockedByPriority: string;
    try {
      allowed = await executeHttpQueryTool.execute(
        { url: 'http://localhost/health', method: 'GET' },
        { store, timezone: 'UTC', httpAllowedOrigins: ['*'], httpAllowedPrivateHosts: ['localhost'] },
      );
      blockedByPriority = await executeHttpQueryTool.execute(
        { url: 'http://localhost/health', method: 'GET' },
        { store, timezone: 'UTC', httpAllowedOrigins: ['*'], httpBlockedHosts: ['localhost'], httpAllowedPrivateHosts: ['localhost'] },
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
    expect(blocked).toContain('forbidden');
    expect(JSON.parse(allowed!).status).toBe(200);
    expect(blockedByPriority!).toContain('forbidden');
  });

  it('blocks queries to origins that are not allowed', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');

    const result = await executeHttpQueryTool.execute(
      { url: 'https://malicious.com/api', method: 'GET' },
      { store, timezone: 'UTC', httpAllowedOrigins: ['https://safe.com'] }
    );
    expect(result).toContain('blocked by security settings');
  });

  it('safely follows redirects and validates security on every hop', async () => {
    const { store } = await tempStore();
    const { executeHttpQueryTool } = await import('../../src/tools/implementations/executeHttpQuery');
    const originalFetch = globalThis.fetch;
    
    // Мокаем цепочку редиректов: safe.com -> redirect -> localhost/secret
    let callIndex = 0;
    const fetchMock = vi.fn(async () => {
      if (callIndex === 0) {
        callIndex++;
        return new Response('', {
          status: 302,
          headers: { 'location': 'http://localhost/secret' },
        });
      }
      return new Response('secret data', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await executeHttpQueryTool.execute(
        { url: 'https://safe.com/start', method: 'GET' },
        { store, timezone: 'UTC', httpAllowedOrigins: ['*'] }
      );
      // Должно заблокировать на втором хопе редиректа!
      expect(result).toContain('forbidden');
      expect(fetchMock).toHaveBeenCalledOnce(); // Второй запрос (к localhost) совершаться не должен
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });
});
