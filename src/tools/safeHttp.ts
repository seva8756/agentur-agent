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
  blockedHosts?: string[];
  allowedPrivateHosts?: string[];
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

const privateIpBlockList = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
] as const) privateIpBlockList.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) {
  privateIpBlockList.addSubnet(address, prefix, 'ipv6');
}

export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  return family > 0 && privateIpBlockList.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export async function isSafeHost(hostname: string, options: Pick<SafeHttpOptions, 'blockedHosts' | 'allowedPrivateHosts'> = {}): Promise<boolean> {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (includesHost(options.blockedHosts, normalized)) return false;
  if (includesHost(options.allowedPrivateHosts, normalized)) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return false;
  if (net.isIP(normalized)) return !isPrivateIp(normalized);
  try {
    const lookupResult = await dns.lookup(normalized, { all: true });
    return lookupResult.every((item) => !isPrivateIp(item.address));
  } catch {
    return true;
  }
}

function includesHost(hosts: string[] | undefined, hostname: string): boolean {
  return hosts?.some((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '') === hostname) ?? false;
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
      const safe = await isSafeHost(parsed.hostname, options);
      if (!safe) {
        logger.warn('Blocked HTTP request to blocked, local, or private host', { hostname: parsed.hostname, url: currentUrl });
        throw new SafeHttpError('unsafe_host', `Access to blocked, local, or private host '${parsed.hostname}' is forbidden`);
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
