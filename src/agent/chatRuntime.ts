import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../config';
import { McpManager } from '../integrations/mcp/manager';
import { LlmAdapter } from '../llm/types';
import { FileStore, initializeDataDir } from '../memory/fileStore';
import { AgentScheduler } from '../scheduler/scheduler';
import { loadEnabledSkills } from '../skills/loader';
import { SkillRunResult, textSkillResult } from '../skills/result';
import { runSkillTool } from '../skills/runtime';
import { TrustedSkillPromptInfo } from '../skills/trustedTypes';
import { ChatMessage } from '../telegram/telegramTypes';
import { ToolRegistry } from '../tools/registry';
import { generateAgentReply } from './respond';

export type ChatRuntime = {
  chatId: string;
  store: FileStore;
  scheduler: AgentScheduler;
};

export class ChatRuntimeManager {
  private readonly runtimes = new Map<string, ChatRuntime>();

  constructor(
    private readonly config: AppConfig,
    public readonly llm: LlmAdapter,
    public readonly tools: ToolRegistry,
    private readonly sendMessage: (chatId: string, store: FileStore, result: SkillRunResult, threadId?: number | null) => Promise<void>,
    public readonly trustedSkills: TrustedSkillPromptInfo[] = [],
    public readonly mcp?: McpManager,
  ) {}

  isChatAllowed(chatId: string): boolean {
    return this.config.telegramAllowedChatIds.length === 0 || this.config.telegramAllowedChatIds.includes(chatId);
  }

  isFullCaptureChat(chatId: string): boolean {
    return this.config.telegramFullCaptureChatIds.includes('*') || this.config.telegramFullCaptureChatIds.includes(chatId);
  }

  async getRuntime(chatId: string): Promise<ChatRuntime | null> {
    if (!this.isChatAllowed(chatId)) return null;
    const existing = this.runtimes.get(chatId);
    if (existing) return existing;

    const store = new FileStore(this.getChatDataDir(chatId));
    await initializeDataDir(store);
    const runtime: { scheduler?: AgentScheduler } = {};
    const scheduler = new AgentScheduler(store, {
      sendMessage: async (text, threadId) => this.sendMessage(chatId, store, text, threadId),
      askAgent: async (prompt, job): Promise<string> =>
        generateAgentReply({
          input: prompt,
          config: this.config,
          store,
          llm: this.llm,
          tools: this.tools,
          toolContext: {
            store,
            scheduler: runtime.scheduler,
            timezone: this.config.agentTimezone,
            httpAllowedOrigins: this.config.skillHttpAllowedOrigins,
            httpTimeoutMs: this.config.skillHttpTimeoutMs,
            httpMaxRequestBytes: this.config.skillHttpMaxRequestBytes,
            httpMaxResponseBytes: this.config.skillHttpMaxResponseBytes,
            currentMessage: buildCronMessage(chatId, prompt, job.threadId),
            trustedSkills: this.trustedSkills,
            mcp: this.mcp,
          },
        }),
      runSkillTool: async (skillId, toolName, args, text, threadId) => {
        const skills = await loadEnabledSkills(store);
        const skill = skills.find((candidate) => candidate.id === skillId);
        if (!skill) return textSkillResult(`Навык не найден или не включён: ${skillId}`);
        return runSkillTool(
          store,
          skill,
          toolName,
          args,
          {
            messageId: Date.now(),
            chatId,
            threadId: threadId ?? undefined,
            chatType: 'group',
            text,
            date: new Date(),
            username: 'cron',
            displayName: 'Cron',
          },
          {
            httpAllowedOrigins: this.config.skillHttpAllowedOrigins,
            httpTimeoutMs: this.config.skillHttpTimeoutMs,
            httpMaxRequestBytes: this.config.skillHttpMaxRequestBytes,
            httpMaxResponseBytes: this.config.skillHttpMaxResponseBytes,
            mcp: this.mcp,
            mcpTimeoutMs: this.config.mcpTimeoutMs,
            mcpMaxResponseBytes: this.config.mcpMaxResponseBytes,
          },
        );
      },
    });
    runtime.scheduler = scheduler;
    await scheduler.load();

    const chatRuntime = { chatId, store, scheduler };
    this.runtimes.set(chatId, chatRuntime);
    return chatRuntime;
  }

  async loadKnownRuntimes(): Promise<void> {
    if (this.config.telegramAllowedChatIds.length > 0) {
      await Promise.all(this.config.telegramAllowedChatIds.map((chatId) => this.getRuntime(chatId)));
    }

    const chatsDir = path.join(this.config.agentDataDir, 'chats');
    await fs.mkdir(chatsDir, { recursive: true });
    const entries = await fs.readdir(chatsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const chatId = decodeChatDir(entry.name);
          if (chatId) await this.getRuntime(chatId);
        }),
    );
  }

  getChatDataDir(chatId: string): string {
    return path.join(this.config.agentDataDir, 'chats', encodeChatDir(chatId));
  }
}

function buildCronMessage(chatId: string, text: string, threadId?: number | null): ChatMessage {
  return {
    messageId: Date.now(),
    chatId,
    threadId: threadId ?? undefined,
    chatType: 'group',
    text,
    date: new Date(),
    username: 'cron',
    displayName: 'Cron',
  };
}

export function encodeChatDir(chatId: string): string {
  return Buffer.from(chatId, 'utf8').toString('base64url');
}

export function decodeChatDir(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
