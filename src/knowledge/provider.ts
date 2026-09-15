import fs from 'node:fs/promises';
import { artifactMetaSchema, isTextArtifact } from '../memory/artifactStore';
import { listStoredAttachmentFiles } from '../memory/attachmentStore';
import { readChatSettings } from '../memory/chatSettings';
import { listDecisions } from '../memory/decisions';
import { FileStore } from '../memory/fileStore';
import { listFacts } from '../memory/facts';
import { readIdentity } from '../memory/identity';
import { readMood } from '../memory/moodDiary';
import { readSummary } from '../memory/summary';

export const CHAT_ROOT = '/chat';
const MAX_VIRTUAL_FILE_CHARS = 300_000;

export type VirtualChatFile = {
  path: string;
  text: string;
};

export type GrepOptions = {
  pattern: string;
  path?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  beforeContext?: number;
  afterContext?: number;
  maxResults?: number;
};

export type GrepMatch = {
  path: string;
  line: number;
  context: Array<{ line: number; text: string; match: boolean }>;
};

/**
 * Read-only virtual filesystem for chat-local knowledge. The virtual paths are
 * intentionally stable and shell-like, while the backing stores remain private.
 */
export async function listVirtualChatFiles(store: FileStore): Promise<VirtualChatFile[]> {
  const [recentJsonl, summary, facts, decisions, identity, mood, settings, artifacts, attachments] = await Promise.all([
    store.readText('', 'chat', 'recent.jsonl'),
    readSummary(store),
    listFacts(store),
    listDecisions(store),
    readIdentity(store),
    readMood(store),
    readChatSettings(store),
    listArtifactFiles(store),
    listStoredAttachmentFiles(store),
  ]);

  const files: VirtualChatFile[] = [
    { path: `${CHAT_ROOT}/memory/summary.md`, text: summary },
    {
      path: `${CHAT_ROOT}/memory/facts.txt`,
      text: facts.map((fact) => `[${fact.id}] ${fact.text}${fact.source ? ` (source: ${fact.source})` : ''}`).join('\n'),
    },
    {
      path: `${CHAT_ROOT}/memory/decisions.txt`,
      text: decisions.map((decision) => `[${decision.id}] ${decision.text}${decision.source ? ` (source: ${decision.source})` : ''}`).join('\n'),
    },
    { path: `${CHAT_ROOT}/state/identity.md`, text: identity },
    {
      path: `${CHAT_ROOT}/state/mood.json`,
      text: JSON.stringify(mood, null, 2),
    },
    {
      path: `${CHAT_ROOT}/state/settings.json`,
      text: JSON.stringify({ replyMode: settings.replyMode, profanityMode: settings.profanityMode, updatedAt: settings.updatedAt }, null, 2),
    },
    {
      path: `${CHAT_ROOT}/messages/recent.jsonl`,
      text: recentJsonl,
    },
  ];

  return [...files, ...attachments, ...artifacts].map((file) => ({ ...file, text: limitText(file.text) }));
}

/** Lists only user-visible files that the agent can inspect or search. */
export async function listChatFileInventory(store: FileStore): Promise<string> {
  const [attachments, artifacts] = await Promise.all([
    listStoredAttachmentFiles(store),
    listArtifactFiles(store),
  ]);
  return [
    formatInventorySection('Attachments', 'Files received in chat.', attachments),
    formatInventorySection('Artifacts', 'Files created by the agent or skills.', artifacts),
  ].join('\n\n');
}

export async function grepVirtualChat(store: FileStore, options: GrepOptions): Promise<GrepMatch[]> {
  const pattern = options.pattern.trim();
  if (!pattern) throw new Error('pattern must not be empty');
  const root = normalizeVirtualPath(options.path ?? CHAT_ROOT);
  const matcher = createLineMatcher(pattern, options.regex ?? false, options.ignoreCase ?? true);
  const before = clamp(options.beforeContext ?? 0, 0, 5);
  const after = clamp(options.afterContext ?? 0, 0, 5);
  const maxResults = clamp(options.maxResults ?? 20, 1, 50);
  const files = await listVirtualChatFiles(store);
  const matches: GrepMatch[] = [];

  for (const file of files) {
    if (!isWithinPath(file.path, root)) continue;
    const lines = file.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher(lines[index] ?? '')) continue;
      const start = Math.max(0, index - before);
      const end = Math.min(lines.length, index + after + 1);
      matches.push({
        path: file.path,
        line: index + 1,
        context: lines.slice(start, end).map((text, lineIndex) => ({
          line: start + lineIndex + 1,
          text,
          match: start + lineIndex === index,
        })),
      });
      if (matches.length >= maxResults) return matches;
    }
  }
  return matches;
}

export async function readVirtualChatFile(
  store: FileStore,
  requestedPath: string,
  startLine = 1,
  endLine = 120,
): Promise<{ path: string; startLine: number; endLine: number; lines: string[] }> {
  const target = normalizeVirtualPath(requestedPath);
  const file = (await listVirtualChatFiles(store)).find((candidate) => candidate.path === target);
  if (!file) throw new Error(`chat path not found: ${target}`);
  const lines = file.text.split(/\r?\n/);
  const start = clamp(startLine, 1, Math.max(1, lines.length));
  const end = clamp(endLine, start, Math.min(lines.length, start + 299));
  return { path: file.path, startLine: start, endLine: end, lines: lines.slice(start - 1, end) };
}

export function formatGrepMatches(pattern: string, matches: GrepMatch[]): string {
  if (!matches.length) return `No matches for ${JSON.stringify(pattern)} under ${CHAT_ROOT}.`;
  return matches.map((match) => {
    const lines = match.context.map((item) => `${item.match ? '>' : ' '} ${String(item.line).padStart(4, ' ')}  ${item.text}`);
    return `${match.path}:${match.line}:\n${lines.join('\n')}`;
  }).join('\n\n');
}

export function formatReadResult(result: { path: string; startLine: number; endLine: number; lines: string[] }): string {
  return `${result.path}:${result.startLine}-${result.endLine}\n${result.lines
    .map((line, index) => `${String(result.startLine + index).padStart(4, ' ')}  ${line}`)
    .join('\n')}`;
}

function formatInventorySection(title: string, description: string, files: VirtualChatFile[]): string {
  if (!files.length) return `${title}: none.`;
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const separator = file.path.lastIndexOf('/');
    const basePath = file.path.slice(0, separator);
    const name = file.path.slice(separator + 1);
    groups.set(basePath, [...(groups.get(basePath) ?? []), name]);
  }
  return [
    `${title}: ${description}`,
    ...[...groups.entries()].map(([basePath, names]) => `- ${basePath}\n  ${names.join(', ')}`),
  ].join('\n');
}

function createLineMatcher(pattern: string, regex: boolean, ignoreCase: boolean): (line: string) => boolean {
  if (!regex) {
    const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
    return (line) => (ignoreCase ? line.toLocaleLowerCase() : line).includes(needle);
  }
  if (pattern.length > 256) throw new Error('regex pattern must be at most 256 characters');
  assertSafeRegex(pattern);
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, ignoreCase ? 'iu' : 'u');
  } catch {
    throw new Error('invalid regex pattern');
  }
  return (line) => expression.test(line);
}

/**
 * This is deliberately a small, grep-like regex subset. JavaScript regexes can
 * backtrack catastrophically, so grouping, backreferences and lookarounds are
 * excluded until a RE2 runtime is introduced.
 */
function assertSafeRegex(pattern: string): void {
  if (/[()]/.test(pattern)) throw new Error('regex groups are not supported; use character classes or alternation');
  if (/\\[1-9]/.test(pattern) || /\\k[<']/.test(pattern)) throw new Error('regex backreferences are not supported');
  if (/\*\*|\+\+|\?\?|\{[^}]+\}[+*?]/.test(pattern)) throw new Error('nested regex repetition is not supported');
}

function normalizeVirtualPath(value: string): string {
  if (!value.startsWith(CHAT_ROOT) || value.includes('..') || value.includes('\\') || value.includes('//')) {
    throw new Error(`path must stay inside ${CHAT_ROOT}`);
  }
  return value.length > CHAT_ROOT.length && value.endsWith('/') ? value.slice(0, -1) : value;
}

function isWithinPath(filePath: string, root: string): boolean {
  return filePath === root || filePath.startsWith(`${root}/`);
}

function safePathSegment(value: string): string {
  const compact = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return compact || 'unnamed';
}

function limitText(text: string): string {
  if (text.length <= MAX_VIRTUAL_FILE_CHARS) return text;
  return `${text.slice(0, MAX_VIRTUAL_FILE_CHARS)}\n... [virtual file truncated]`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function listArtifactFiles(store: FileStore): Promise<VirtualChatFile[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(store.resolve('artifacts'), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: VirtualChatFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('art_')) continue;
    try {
      const rawMeta = await fs.readFile(store.resolve('artifacts', entry.name, 'meta.json'), 'utf8');
      const meta = artifactMetaSchema.parse(JSON.parse(rawMeta));
      const name = safePathSegment(meta.filename);
      const basePath = `${CHAT_ROOT}/artifacts/${name}--${meta.id.slice(-8)}`;
      const metadata = [
        `[artifact id=${meta.id}]`,
        `filename: ${meta.filename}`,
        `mime: ${meta.mimeType}`,
        `size_bytes: ${meta.size}`,
        `created_at: ${meta.createdAt}`,
        `created_by: ${meta.createdBy.kind}${meta.createdBy.id ? `:${meta.createdBy.id}` : ''}`,
      ].join('\n');
      files.push({ path: `${basePath}/meta.txt`, text: metadata });
      if (isTextArtifact(meta.mimeType)) {
        const content = await readTextAtMost(store.resolve('artifacts', entry.name, 'content'), MAX_VIRTUAL_FILE_CHARS);
        files.push({ path: `${basePath}/content.txt`, text: content });
      }
    } catch {
      // An incomplete or malformed artifact must not make chat retrieval fail.
    }
  }
  return files;
}

async function readTextAtMost(file: string, maxChars: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    // UTF-8 characters can be up to four bytes; reading that many bytes is a
    // safe upper bound for the returned character budget.
    const buffer = Buffer.alloc(maxChars * 4 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return limitText(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}
