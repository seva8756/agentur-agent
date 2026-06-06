import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { AppConfig } from '../../config';
import { FileStore } from '../../memory/fileStore';
import { readSecrets } from '../../memory/secrets';
import { logger } from '../../utils/logger';

export type McpServerInfo = {
  id: string;
  title: string;
  description: string;
  transport: 'streamable_http';
  scope: 'chat';
};

export type McpToolInfo = {
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpManager = {
  listAllowedServers(params: { store: FileStore; chatId?: string }): Promise<McpServerInfo[]>;
  listAllowedTools(params: { store: FileStore; chatId?: string; serverId?: string }): Promise<McpToolInfo[]>;
  callTool(params: {
    store: FileStore;
    chatId?: string;
    serverId: string;
    toolName: string;
    args: Record<string, unknown>;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<unknown>;
  readResource(params: {
    store: FileStore;
    chatId?: string;
    serverId: string;
    uri: string;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<unknown>;
};

const chatHttpServerSchema = z.object({
  transport: z.literal('streamable_http'),
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().url().refine(isSafePublicHttpUrl, 'Chat MCP URL must be public http/https'),
  enabled: z.boolean().default(true),
  authSecretKey: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
  allowedTools: z.array(z.string()).default([]),
  allowedResources: z.array(z.string()).default([]),
});

const chatMcpConfigSchema = z.object({
  servers: z.record(chatHttpServerSchema).default({}),
});

export type ChatMcpServerConfig = z.output<typeof chatHttpServerSchema>;
export type ChatMcpConfig = z.output<typeof chatMcpConfigSchema>;
type ResolvedMcpServer = {
  id: string;
  scope: 'chat';
  transport: 'streamable_http';
  title?: string;
  description?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedTools: string[];
  allowedResources: string[];
  fingerprint: string;
};
type McpConnection = {
  client: Client;
};

export async function readChatMcpConfig(store: FileStore): Promise<ChatMcpConfig> {
  return store.readJson(chatMcpConfigSchema, { servers: {} }, 'integrations', 'mcp', 'servers.json');
}

export async function writeChatMcpConfig(store: FileStore, config: ChatMcpConfig): Promise<void> {
  await store.writeJson(chatMcpConfigSchema.parse(config), 'integrations', 'mcp', 'servers.json');
}

export async function upsertChatMcpServer(store: FileStore, id: string, server: ChatMcpServerConfig): Promise<ChatMcpConfig> {
  const config = await readChatMcpConfig(store);
  const next = {
    servers: {
      ...config.servers,
      [assertMcpServerId(id)]: chatHttpServerSchema.parse(server),
    },
  };
  await writeChatMcpConfig(store, next);
  return next;
}

export async function deleteChatMcpServer(store: FileStore, id: string): Promise<boolean> {
  const config = await readChatMcpConfig(store);
  if (!(id in config.servers)) return false;
  const { [id]: _removed, ...servers } = config.servers;
  await writeChatMcpConfig(store, { servers });
  return true;
}

export class SdkMcpManager implements McpManager {
  private readonly clients = new Map<string, Promise<McpConnection>>();

  constructor(private readonly config: AppConfig) {}

  async listAllowedServers(params: { store: FileStore; chatId?: string }): Promise<McpServerInfo[]> {
    const servers = await this.listResolvedServers(params.store);
    return servers.map((server) => ({
      id: server.id,
      title: server.title ?? server.id,
      description: server.description ?? `${server.scope} ${server.transport} MCP server`,
      transport: server.transport,
      scope: server.scope,
    }));
  }

  async listAllowedTools(params: { store: FileStore; chatId?: string; serverId?: string }): Promise<McpToolInfo[]> {
    const servers = params.serverId
      ? [await this.requireResolvedServer(params.store, params.serverId)]
      : await this.listResolvedServers(params.store);
    const results = await Promise.allSettled(servers.map((server) => this.listToolsForServer(server, params.store)));
    const tools: McpToolInfo[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        tools.push(...result.value);
      } else {
        logger.warn('Could not list MCP tools', { serverId: servers[index]?.id, error: result.reason });
      }
    });
    if (params.serverId && results[0]?.status === 'rejected') throw results[0].reason;
    return tools;
  }

  async callTool(params: {
    store: FileStore;
    chatId?: string;
    serverId: string;
    toolName: string;
    args: Record<string, unknown>;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<unknown> {
    const server = await this.requireResolvedServer(params.store, params.serverId);
    this.assertToolAllowed(server, params.toolName);
    const { client } = await this.connection(server, params.store);
    const result = await client.callTool(
      { name: params.toolName, arguments: params.args },
      undefined,
      { timeout: params.timeoutMs, maxTotalTimeout: params.timeoutMs },
    );
    await auditMcpRun(params.store, server.id, params.toolName, 'tool_completed', {
      scope: server.scope,
      chatId: params.chatId ?? null,
      args: summarizeJson(params.args),
    });
    return enforceMaxBytes(result, params.maxResponseBytes, 'MCP tool response');
  }

  async readResource(params: {
    store: FileStore;
    chatId?: string;
    serverId: string;
    uri: string;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<unknown> {
    const server = await this.requireResolvedServer(params.store, params.serverId);
    this.assertResourceAllowed(server, params.uri);
    const { client } = await this.connection(server, params.store);
    const result = await client.readResource(
      { uri: params.uri },
      { timeout: params.timeoutMs, maxTotalTimeout: params.timeoutMs },
    );
    await auditMcpRun(params.store, server.id, 'read_resource', 'resource_completed', {
      scope: server.scope,
      chatId: params.chatId ?? null,
      uri: params.uri,
    });
    return enforceMaxBytes(result, params.maxResponseBytes, 'MCP resource response');
  }

  private async listResolvedServers(store: FileStore): Promise<ResolvedMcpServer[]> {
    const [chatConfig, secrets] = await Promise.all([readChatMcpConfig(store), readSecrets(store)]);
    const chat = Object.entries(chatConfig.servers)
      .filter(([, server]) => server.enabled)
      .map(([id, server]) => resolveChatServer(id, server, secrets));
    return chat;
  }

  private async requireResolvedServer(store: FileStore, serverId: string): Promise<ResolvedMcpServer> {
    const servers = await this.listResolvedServers(store);
    const server = servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new Error(`Unknown or disabled MCP server: ${serverId}`);
    return server;
  }

  private async listToolsForServer(server: ResolvedMcpServer, store: FileStore): Promise<McpToolInfo[]> {
    const { client } = await this.connection(server, store);
    const result = await client.listTools(undefined, {
      timeout: this.config.mcpTimeoutMs,
      maxTotalTimeout: this.config.mcpTimeoutMs,
    });
    return result.tools
      .filter((tool) => this.isToolAllowed(server, tool.name))
      .map((tool) => ({
        serverId: server.id,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  private connection(server: ResolvedMcpServer, store: FileStore): Promise<McpConnection> {
    const cacheKey = `${store.rootDir}:${server.id}:${server.fingerprint}`;
    const existing = this.clients.get(cacheKey);
    if (existing) return existing;
    const connecting = this.createConnection(server).catch((error) => {
      this.clients.delete(cacheKey);
      throw error;
    });
    this.clients.set(cacheKey, connecting);
    return connecting;
  }

  private async createConnection(server: ResolvedMcpServer): Promise<McpConnection> {
    const client = new Client(
      { name: 'agentur-chat-agent', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
    await client.connect(transport, {
      timeout: this.config.mcpTimeoutMs,
      maxTotalTimeout: this.config.mcpTimeoutMs,
    });
    return { client };
  }

  private assertToolAllowed(server: ResolvedMcpServer, toolName: string): void {
    if (!this.isToolAllowed(server, toolName)) throw new Error(`MCP tool is not allowed: ${server.id}:${toolName}`);
  }

  private isToolAllowed(server: ResolvedMcpServer, toolName: string): boolean {
    const local = server.allowedTools;
    if (!local.length) return true;
    return local.includes(toolName) || local.includes(`${server.id}:${toolName}`);
  }

  private assertResourceAllowed(server: ResolvedMcpServer, uri: string): void {
    const local = server.allowedResources;
    if (!local.length) return;
    if (!local.some((pattern) => matchesResourcePattern(uri, pattern))) {
      throw new Error(`MCP resource is not allowed: ${server.id}:${uri}`);
    }
  }
}

function resolveChatServer(id: string, server: ChatMcpServerConfig, secrets: Record<string, string>): ResolvedMcpServer {
  const resolved = {
    id,
    scope: 'chat' as const,
    transport: server.transport,
    title: server.title,
    description: server.description,
    url: server.url,
    headers: buildChatHeaders(server, secrets),
    allowedTools: server.allowedTools,
    allowedResources: server.allowedResources,
  };
  return { ...resolved, fingerprint: fingerprintJson(resolved) };
}

function buildChatHeaders(server: ChatMcpServerConfig, secrets: Record<string, string>): Record<string, string> {
  if (!server.authSecretKey) return {};
  const token = secrets[server.authSecretKey];
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function enforceMaxBytes<T>(value: T, maxBytes: number, label: string): T {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) throw new Error(`${label} is too large: ${bytes} > ${maxBytes}`);
  return value;
}

function matchesResourcePattern(uri: string, pattern: string): boolean {
  if (pattern === uri) return true;
  if (pattern.endsWith('*')) return uri.startsWith(pattern.slice(0, -1));
  return false;
}

function isSafePublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost'
      || host.endsWith('.localhost')
      || host === '0.0.0.0'
      || host === '::1'
      || host.startsWith('127.')
      || host.startsWith('10.')
      || host.startsWith('192.168.')
      || host.startsWith('169.254.')
      || isPrivate172Host(host)
      || host.startsWith('fc')
      || host.startsWith('fd')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isPrivate172Host(host: string): boolean {
  const match = host.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function assertMcpServerId(value: string): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(value)) throw new Error(`Invalid MCP server id: ${value}`);
  return value;
}

function fingerprintJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function summarizeJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (!text || text.length <= 1000) return value;
  return { truncated: true, preview: text.slice(0, 1000) };
}

async function auditMcpRun(store: FileStore, serverId: string, toolName: string, status: string, details: unknown): Promise<void> {
  await store.appendJsonl({
    serverId,
    toolName,
    status,
    details,
    createdAt: new Date().toISOString(),
  }, 'integrations', 'mcp', 'audit.jsonl');
}
