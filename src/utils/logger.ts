import { z } from 'zod';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const activeLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (order[level] < order[activeLevel]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (meta === undefined) {
    console[level === 'debug' ? 'log' : level](line);
    return;
  }
  console[level === 'debug' ? 'log' : level](line, redact(meta, level === 'error'));
}

function redact(value: unknown, includeStack = false): unknown {
  if (typeof value === 'string') return value.replace(/([A-Za-z0-9_-]{24,})/g, '[redacted]');
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, includeStack));
  if (value instanceof Error) {
    const extra = Object.fromEntries(
      Object.entries(value as unknown as Record<string, unknown>).map(([key, item]) => [
        key,
        /token|apiKey|key|secret/i.test(key) ? '[redacted]' : redact(item, includeStack),
      ]),
    );
    return {
      name: value.name,
      message: redact(value.message),
      ...(includeStack ? { stack: redact(value.stack) } : {}),
      cause: redact(value.cause, includeStack),
      ...extra,
    };
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /token|apiKey|key|secret/i.test(key) ? '[redacted]' : redact(item, includeStack),
    ]),
  );
}

export const logger = {
  debug: (message: string, meta?: unknown) => log('debug', message, meta),
  info: (message: string, meta?: unknown) => log('info', message, meta),
  warn: (message: string, meta?: unknown) => log('warn', message, meta),
  error: (message: string, meta?: unknown) => log('error', message, meta),
};

export function formatLogError(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return {
      name: error.name,
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.') || '<root>',
        code: issue.code,
        message: issue.message,
        expected: 'expected' in issue ? issue.expected : undefined,
        received: 'received' in issue ? issue.received : undefined,
      })),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return error;
}
