import { z } from 'zod';
import { AgentTool } from '../types';
import { isPrivateIp, isSafeHost, safeHttpRequest } from '../safeHttp';
import { logger } from '../../utils/logger';

const argsSchema = z.object({
  url: z.string().url().describe('The absolute URL to query (http or https only)'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET').describe('HTTP method'),
  headers: z.record(z.string()).optional().describe('Optional HTTP headers'),
  body: z.string().optional().describe('Optional HTTP request body'),
});

export { isPrivateIp, isSafeHost };

export const executeHttpQueryTool: AgentTool<z.output<typeof argsSchema>> = {
  name: 'execute_http_query',
  description: 'Execute an HTTP/HTTPS request to explore endpoints or fetch remote data. Strictly restricted from accessing local files or private network addresses.',
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
