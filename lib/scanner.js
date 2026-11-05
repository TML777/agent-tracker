// Reads Claude Code's on-disk data and produces one summary per chat.
// Everything under ~/.claude is opened read-only; the only file written is our own cache.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERSION = 3;
const PREVIEW_CHARS = 700;
const SEARCH_CHARS = 30_000;

// Lines worth parsing. Most transcript bytes are API request blobs and tool output,
// so checking for these markers first keeps the scan of 100MB+ files fast.
const MARKERS = [
  '"type":"user"',
  '"type":"assistant"',
  '"type":"custom-title"',
  '"type":"agent-name"',
  '"type":"ai-title"',
  '"type":"pr-link"',
  '"subtype":"away_summary"',
].map((m) => Buffer.from(m));
const NOISE_PREFIXES = ['{"type":"api-request', '{"type":"file-history'].map((m) => Buffer.from(m));

const NOT_A_PROMPT = /^(<command-|<local-command|<bash-|<task-notification|<user-memory|Caveat: The messages below|\[Request interrupted)/;

export function emptySummary(id, file) {
  return {
    id,
    file,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    cwdFirst: null,
    cwdLast: null,
    branch: null,
    entrypoint: null,
    customTitle: null,
    agentName: null,
    aiTitle: null,
    firstPrompt: null,
    firstOtherPrompt: null,
    lastPrompt: null,
    lastPromptAt: 0,
    lastReply: null,
    awaySummary: null,
    awayAt: 0,
    firstAt: 0,
    lastAt: 0,
    promptCount: 0,
    messageCount: 0,
    prs: [],
    searchText: '',
    subagents: 0,
    missing: false,
  };
}

function clip(text, max = PREVIEW_CHARS) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function textFrom(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function cleanPrompt(content) {
  const text = textFrom(content)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content\b[^>]*>/g, '')
    .trim();
  if (!text || NOT_A_PROMPT.test(text)) return '';
  return text;
}

function isoToMs(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function applyUser(s, o) {
  if (o.isSidechain || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return;
  const text = cleanPrompt(o.message?.content);
  if (!text) return;
  const kind = o.origin?.kind;
  const human = kind ? kind === 'human' : o.promptSource !== 'system';
  if (!human) {
    s.firstOtherPrompt ??= clip(text);
    return;
  }
  s.firstPrompt ??= clip(text);
  s.lastPrompt = clip(text);
  s.lastPromptAt = isoToMs(o.timestamp) || s.lastPromptAt;
  s.promptCount += 1;
  if (s.searchText.length < SEARCH_CHARS) {
    s.searchText += `${text.slice(0, SEARCH_CHARS - s.searchText.length).toLowerCase()}\n`;
  }
}

export function applyLine(s, o) {
  switch (o.type) {
    case 'custom-title':
      s.customTitle = o.customTitle || s.customTitle;
      return;
    case 'agent-name':
      s.agentName = o.agentName || s.agentName;
      return;
    case 'ai-title':
      s.aiTitle = o.aiTitle || s.aiTitle;
      return;
    case 'pr-link':
      if (o.prUrl && !s.prs.some((pr) => pr.url === o.prUrl)) {
        s.prs.push({ url: o.prUrl, number: o.prNumber ?? null, repo: o.prRepository ?? null });
      }
      return;
    case 'system':
      if (o.subtype === 'away_summary' && typeof o.content === 'string') {
        s.awaySummary = clip(o.content.replace(/\s*\(disable recaps[^)]*\)\s*$/, ''));
        s.awayAt = isoToMs(o.timestamp);
      }
      return;
    case 'user':
    case 'assistant': {
      if (o.isSidechain) return;
      s.messageCount += 1;
      s.cwdFirst ??= o.cwd ?? null;
      s.cwdLast = o.cwd ?? s.cwdLast;
      s.entrypoint ??= o.entrypoint ?? null;
      if (o.gitBranch && o.gitBranch !== 'HEAD') s.branch = o.gitBranch;
      const at = isoToMs(o.timestamp);
      if (at) {
        s.firstAt ||= at;
        s.lastAt = Math.max(s.lastAt, at);
      }
      if (o.type === 'user') applyUser(s, o);
      else {
        const reply = textFrom(o.message?.content).trim();
        if (reply) s.lastReply = clip(reply);
      }
      return;
    }
    default:
  }
}

function worthParsing(line) {
  if (NOISE_PREFIXES.some((prefix) => line.subarray(0, prefix.length).equals(prefix))) return false;
  return MARKERS.some((marker) => line.includes(marker));
}

// Reads from `summary.offset` to the end of the file. Transcripts are append-only, so
// only new bytes are parsed. A partial last line is left for the next pass.
export async function readTranscript(summary, size) {
  let offset = summary.offset;
  if (offset >= size) return summary;
  let pending = [];
  const stream = fs.createReadStream(summary.file, { start: offset, end: size - 1, highWaterMark: 1 << 18 });
  for await (const chunk of stream) {
    let start = 0;
    let newline;
    while ((newline = chunk.indexOf(10, start)) !== -1) {
      const piece = chunk.subarray(start, newline);
      const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      offset += line.length + 1;
      start = newline + 1;
      if (!worthParsing(line)) continue;
      try {
        applyLine(summary, JSON.parse(line.toString('utf8')));
      } catch {
        // A malformed line shouldn't lose the rest of the transcript.
      }
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }
  summary.offset = offset;
  return summary;
}

async function exists(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export async function readLiveSessions(claudeHome) {
  const live = new Map();
  const dir = path.join(claudeHome, 'sessions');
  for (const entry of (await exists(dir)) ?? []) {
    if (!entry.name.endsWith('.json')) continue;
    const info = await readJson(path.join(dir, entry.name));
    if (!info?.sessionId || !isAlive(info.pid)) continue;
    live.set(info.sessionId, {
      status: info.status === 'busy' ? 'busy' : 'open',
      name: info.nameSource === 'user' ? info.name : null,
    });
  }
  return live;
}

export async function readDesktopSessions(desktopDir) {
  const found = new Map();
  for (const account of (await exists(desktopDir)) ?? []) {
    if (!account.isDirectory()) continue;
    const accountDir = path.join(desktopDir, account.name);
    for (const org of (await exists(accountDir)) ?? []) {
      if (!org.isDirectory()) continue;
      const orgDir = path.join(accountDir, org.name);
      for (const file of (await exists(orgDir)) ?? []) {
        if (!file.name.endsWith('.json')) continue;
        const info = await readJson(path.join(orgDir, file.name));
        if (info?.cliSessionId) {
          found.set(info.cliSessionId, { title: info.title ?? null, originCwd: info.originCwd ?? null });
        }
      }
    }
  }
  return found;
}

export async function readSubagents(file, id) {
  const dir = path.join(path.dirname(file), id, 'subagents');
  const list = [];
  for (const entry of (await exists(dir)) ?? []) {
    if (!entry.name.endsWith('.meta.json')) continue;
    const meta = await readJson(path.join(dir, entry.name));
    if (meta) {
      list.push({
        id: entry.name.replace(/^agent-|\.meta\.json$/g, ''),
        type: meta.agentType ?? 'agent',
        description: meta.description ?? '',
        finished: Boolean(meta.finished),
      });
    }
  }
  return list;
}

async function countSubagents(file, id) {
  const entries = await exists(path.join(path.dirname(file), id, 'subagents'));
  return entries ? entries.filter((e) => e.name.startsWith('agent-') && e.name.endsWith('.jsonl')).length : 0;
}

export class Scanner {
  constructor({ claudeHome, desktopDir, cacheFile }) {
    Object.assign(this, { claudeHome, desktopDir, cacheFile });
    this.sessions = new Map();
    this.live = new Map();
    this.desktop = new Map();
    this.progress = { done: 0, total: 0, active: false };
    this.complete = false;
    this.onProgress = null;
    this.loadCache();
  }

  loadCache() {
    try {
      const cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (cache.version !== CACHE_VERSION) return;
      for (const summary of Object.values(cache.sessions)) this.sessions.set(summary.id, summary);
    } catch {
      // No cache yet, or an unreadable one: it can always be rebuilt from the transcripts.
    }
  }

  saveCache() {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, sessions: Object.fromEntries(this.sessions) }));
    fs.renameSync(tmp, this.cacheFile);
  }

  async listTranscripts() {
    const root = path.join(this.claudeHome, 'projects');
    const files = [];
    for (const project of (await exists(root)) ?? []) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      for (const entry of (await exists(dir)) ?? []) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, entry.name);
        const stat = await fsp.stat(file).catch(() => null);
        if (stat) files.push({ id: entry.name.slice(0, -'.jsonl'.length), file, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async scan() {
    if (this.progress.active) return;
    const files = await this.listTranscripts();
    this.progress = { done: 0, total: files.length, active: true };
    let changed = false;
    try {
      [this.live, this.desktop] = await Promise.all([
        readLiveSessions(this.claudeHome),
        readDesktopSessions(this.desktopDir),
      ]);

      const seen = new Set(files.map((f) => f.id));
      for (const summary of this.sessions.values()) {
        // Claude Code prunes old transcripts. The summary is kept so the card survives.
        if (!seen.has(summary.id) && !summary.missing) {
          summary.missing = true;
          changed = true;
        }
      }

      for (const { id, file, size, mtimeMs } of files) {
        const previous = this.sessions.get(id);
        const unchanged = previous && previous.size === size && previous.mtimeMs === mtimeMs && previous.file === file;
        const subagents = await countSubagents(file, id);
        if (unchanged && !previous.missing) {
          if (previous.subagents !== subagents) {
            previous.subagents = subagents;
            changed = true;
          }
        } else {
          // A file that shrank was rewritten, so its old offset no longer means anything.
          const summary = previous && previous.file === file && size >= previous.offset ? previous : emptySummary(id, file);
          await readTranscript(summary, size);
          Object.assign(summary, { size, mtimeMs, subagents, missing: false });
          summary.lastAt ||= mtimeMs;
          this.sessions.set(id, summary);
          changed = true;
        }
        this.progress.done += 1;
        this.onProgress?.();
      }
      this.complete = true;
    } finally {
      this.progress.active = false;
    }
    if (changed) this.saveCache();
    this.onProgress?.();
  }

  // Empty transcripts (opened, nothing said) aren't useful as cards.
  visibleSessions() {
    return [...this.sessions.values()].filter((s) => s.messageCount > 0);
  }
}
