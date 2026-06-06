import dns from 'node:dns/promises';
import net from 'node:net';
import { logger } from '../utils/logger';

export type SafeHttpRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type SafeHttpOptions = {
  allowedOrigins: string[];
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxRedirects?: number;
};

export type SafeHttpResponse = {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  text: string;
  json: unknown;
  url: string;
};

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (ip === '0.0.0.0') return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
    return false;
  }
  return false;
}

export async function isSafeHost(hostname: string): Promise<boolean> {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return false;
  if (net.isIP(normalized)) return !isPrivateIp(normalized);
  try {
    const lookupResult = await dns.lookup(normalized, { all: true });
    return lookupResult.every((item) => !isPrivateIp(item.address));
  } catch {
    return true;
  }
}

export async function safeHttpRequest(request: SafeHttpRequest, options: SafeHttpOptions): Promise<SafeHttpResponse> {
  let currentUrl = request.url;
  let currentMethod = normalizeMethod(request.method ?? 'GET');
  let currentBody = request.body;
  const headers = request.headers ?? {};
  let redirectsCount = 0;
  const maxRedirects = options.maxRedirects ?? 5;

  if (currentBody && Buffer.byteLength(currentBody, 'utf8') > options.maxRequestBytes) {
    throw new SafeHttpError('request_body_too_large', `HTTP-действие заблокировано: тело запроса больше ${options.maxRequestBytes} байт`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    while (true) {
      const parsed = parseAllowedUrl(currentUrl);
      const safe = await isSafeHost(parsed.hostname);
      if (!safe) {
        logger.warn('Blocked HTTP request to local or private host', { hostname: parsed.hostname, url: currentUrl });
        throw new SafeHttpError('unsafe_host', `Access to local or private host '${parsed.hostname}' is forbidden`);
      }
      if (!isOriginAllowed(parsed.origin, options.allowedOrigins)) {
        logger.warn('Blocked HTTP request to non-allowed origin', { origin: parsed.origin, url: currentUrl });
        throw new SafeHttpError('origin_not_allowed', `HTTP request to origin '${parsed.origin}' is blocked by security settings (заблокирован настройками безопасности)`);
      }

      response = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: currentBody,
        signal: controller.signal,
        redirect: 'manual',
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        redirectsCount += 1;
        if (redirectsCount > maxRedirects) {
          throw new SafeHttpError('too_many_redirects', `Too many redirects (${maxRedirects})`);
        }
        const location = response.headers.get('location');
        if (!location) break;
        currentUrl = new URL(location, currentUrl).toString();
        if ([301, 302, 303].includes(response.status)) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        continue;
      }
      break;
    }

    const body = await readResponseTextLimited(response, options.maxResponseBytes);
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      text: body,
      json: parseJson(body),
      url: currentUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export class SafeHttpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function parseAllowedUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SafeHttpError('invalid_url', 'Invalid URL format');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SafeHttpError('invalid_protocol', 'Only http and https protocols are allowed');
  }
  return parsed;
}

function normalizeMethod(method: string): string {
  const normalized = method.trim().toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(normalized)) {
    throw new SafeHttpError('unsupported_method', `Unsupported HTTP method: ${method}`);
  }
  return normalized;
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SafeHttpError('response_body_too_large', `HTTP response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
