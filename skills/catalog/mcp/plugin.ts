import { z } from 'zod';
import type { TrustedSkillPlugin } from '../../../src/skills/trustedTypes';

const listServersSchema = z.object({});

const listToolsSchema = z.object({
  serverId: z.string().min(1).optional(),
});

const callToolSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.unknown()).optional().default({}),
});

const readResourceSchema = z.object({
  serverId: z.string().min(1),
  uri: z.string().min(1),
});

const plugin = {
  tools: {
    mcp_list_servers: {
      schema: listServersSchema,
      execute: async (_args, ctx) => ({
        ok: true,
        data: {
          servers: await ctx.mcp.listAllowedServers({
            store: ctx.store,
            chatId: ctx.currentMessage?.chatId,
          }),
        },
      }),
    },

    mcp_list_tools: {
      schema: listToolsSchema,
      execute: async (args, ctx) => ({
        ok: true,
        data: {
          tools: await ctx.mcp.listAllowedTools({
            store: ctx.store,
            chatId: ctx.currentMessage?.chatId,
            serverId: args.serverId,
          }),
        },
      }),
    },

    mcp_call_tool: {
      schema: callToolSchema,
      execute: async (args, ctx) => ({
        ok: true,
        data: {
          serverId: args.serverId,
          toolName: args.toolName,
          result: await ctx.mcp.callTool({
            store: ctx.store,
            chatId: ctx.currentMessage?.chatId,
            serverId: args.serverId,
            toolName: args.toolName,
            args: args.args,
            timeoutMs: ctx.config.mcpTimeoutMs,
            maxResponseBytes: ctx.config.mcpMaxResponseBytes,
          }),
        },
      }),
    },

    mcp_read_resource: {
      schema: readResourceSchema,
      execute: async (args, ctx) => ({
        ok: true,
        data: {
          serverId: args.serverId,
          uri: args.uri,
          resource: await ctx.mcp.readResource({
            store: ctx.store,
            chatId: ctx.currentMessage?.chatId,
            serverId: args.serverId,
            uri: args.uri,
            timeoutMs: ctx.config.mcpTimeoutMs,
            maxResponseBytes: ctx.config.mcpMaxResponseBytes,
          }),
        },
      }),
    },
  },
} satisfies TrustedSkillPlugin;

export default plugin;
