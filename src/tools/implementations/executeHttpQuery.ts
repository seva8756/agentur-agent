import { z } from 'zod';
import { AgentTool } from '../types';
import { isPrivateIp, isSafeHost, safeHttpRequest } from '../safeHttp';
import { logger } from '../../utils/logger';
import { TOOL_PROMPTS } from '../../prompts/catalog';

const argsSchema = z.object({
  url: z.string().url().describe(TOOL_PROMPTS.executeHttpQuery.url),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET').describe(TOOL_PROMPTS.executeHttpQuery.method),
  headers: z.record(z.string()).optional().describe(TOOL_PROMPTS.executeHttpQuery.headers),
  body: z.string().optional().describe(TOOL_PROMPTS.executeHttpQuery.body),
});

export { isPrivateIp, isSafeHost };

export const executeHttpQueryTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'execute_http_query',
  description: TOOL_PROMPTS.executeHttpQuery.description,
  schema: argsSchema,
  execute: async (args, context) => {
    try {
      const response = await safeHttpRequest(
        {
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
        },
        {
          allowedOrigins: context.httpAllowedOrigins ?? [],
          timeoutMs: context.httpTimeoutMs ?? 10000,
          maxRequestBytes: context.httpMaxRequestBytes ?? 131072,
          maxResponseBytes: context.httpMaxResponseBytes ?? 1048576,
        },
      );
      return JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: response.headers,
        body: response.body,
      });
    } catch (error) {
      logger.warn('execute_http_query request failed', error);
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  },
};
