// Reads Claude Code's on-disk data and produces one summary per chat.
// Everything under ~/.claude is opened read-only; the only file written is our own cache.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERSION = 5;
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
  '"type":"session-owner"',
  '"subtype":"away_summary"',
].map((m) => Buffer.from(m));
const ASSISTANT_MARKER = Buffer.from('"type":"assistant"');
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
    accountUuid: null,
    msgUsage: {}, // Message id -> [input, output, cache read, cache write, time in ms]
    subMsgUsage: {},
    subFiles: {}, // Subagent transcript name -> bytes read so far
    usage: null,
  };
}

// One API response is written as several transcript lines, each repeating its usage,
// so usage is keyed by message id rather than added up per line.
function recordUsage(map, o) {
  const { id, usage, model } = o.message ?? {};
  if (!id || !usage || model === '<synthetic>') return;
  map[id] = [
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
    usage.cache_creation_input_tokens ?? 0,
    isoToMs(o.timestamp),
  ];
}

// A calendar date in this computer's time zone, so days match the wall clock.
export function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
}

function addMessages(totals, days, messages, seen) {
  for (const [id, [input, output, cacheRead, cacheWrite, at]] of Object.entries(messages ?? {})) {
    if (seen.has(id)) continue;
    seen.add(id);
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.calls += 1;
    if (!at) continue;
    const day = (days[localDate(at)] ??= [0, 0, 0, 0, 0]); // Input, output, cache read, cache write, calls
    day[0] += input;
    day[1] += output;
    day[2] += cacheRead;
    day[3] += cacheWrite;
    day[4] += 1;
  }
}

// Forking a chat copies its history into the new transcript. Oldest chats go first, so each
// message counts once, toward the chat where it really happened. A fork starts at the same
// time as its parent, because of that copied history, but its file was created later.
export function computeUsage(summaries) {
  const seen = new Set();
  const oldestFirst = [...summaries].sort(
    (a, b) => (a.firstAt || Infinity) - (b.firstAt || Infinity) || (a.createdMs || Infinity) - (b.createdMs || Infinity),
  );
  for (const summary of oldestFirst) {
    const main = emptyTotals();
    const subagents = emptyTotals();
    const days = {};
    addMessages(main, days, summary.msgUsage, seen);
    addMessages(subagents, days, summary.subMsgUsage, seen);
    summary.usage = { main, subagents, days };
  }
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
    case 'session-owner':
      s.accountUuid = o.accountUuid || s.accountUuid;
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
        recordUsage(s.msgUsage, o);
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

// Calls onLine for each complete line after `from` and returns where it stopped. Transcripts
// are append-only, so only new bytes are parsed. A partial last line is left for the next pass.
async function readLines(file, from, size, onLine) {
  let offset = from;
  if (offset >= size) return offset;
  let pending = [];
  const stream = fs.createReadStream(file, { start: offset, end: size - 1, highWaterMark: 1 << 18 });
  for await (const chunk of stream) {
    let start = 0;
    let newline;
    while ((newline = chunk.indexOf(10, start)) !== -1) {
      const piece = chunk.subarray(start, newline);
      const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      offset += line.length + 1;
      start = newline + 1;
      try {
        onLine(line);
      } catch {
        // A malformed line shouldn't lose the rest of the transcript.
      }
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }
  return offset;
}

export async function readTranscript(summary, size) {
  summary.offset = await readLines(summary.file, summary.offset, size, (line) => {
    if (worthParsing(line)) applyLine(summary, JSON.parse(line.toString('utf8')));
  });
  return summary;
}

// Subagents have their own transcripts, so their usage isn't in the chat's file.
async function updateSubagents(summary, file, id) {
  const dir = path.join(path.dirname(file), id, 'subagents');
  const names = ((await exists(dir)) ?? [])
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'));
  let changed = summary.subagents !== names.length;
  summary.subagents = names.length;
  for (const name of names) {
    const subFile = path.join(dir, name);
    const stat = await fsp.stat(subFile).catch(() => null);
    if (!stat) continue;
    const before = stat.size < (summary.subFiles[name] ?? 0) ? 0 : (summary.subFiles[name] ?? 0);
    const after = await readLines(subFile, before, stat.size, (line) => {
      if (!line.includes(ASSISTANT_MARKER)) return;
      const o = JSON.parse(line.toString('utf8'));
      if (o.type === 'assistant') recordUsage(summary.subMsgUsage, o);
    });
    if (after !== summary.subFiles[name]) {
      summary.subFiles[name] = after;
      changed = true;
    }
  }
  return changed;
}

// Only the account fields are read from this file, and they stay on this machine.
async function readCurrentAccount(claudeHome) {
  const account = (await readJson(path.join(path.dirname(claudeHome), '.claude.json')))?.oauthAccount;
  return account?.accountUuid ? { uuid: account.accountUuid, email: account.emailAddress ?? null } : null;
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
          found.set(info.cliSessionId, {
            title: info.title ?? null,
            originCwd: info.originCwd ?? null,
            accountUuid: account.name,
          });
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

export class Scanner {
  constructor({ claudeHome, desktopDir, cacheFile }) {
    Object.assign(this, { claudeHome, desktopDir, cacheFile });
    this.sessions = new Map();
    this.live = new Map();
    this.desktop = new Map();
    this.currentAccount = null;
    this.progress = { done: 0, total: 0, active: false };
    this.complete = false;
    this.onProgress = null;
    this.loadCache();
  }

  loadCache() {
    try {
      const cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const summary of Object.values(cache.sessions)) {
        // An older cache format is rebuilt from the transcripts, except for chats whose
        // transcript is gone: their cached summary is the only copy left.
        if (cache.version === CACHE_VERSION || summary.missing) this.sessions.set(summary.id, summary);
      }
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
        if (stat) {
          files.push({ id: entry.name.slice(0, -'.jsonl'.length), file, size: stat.size, mtimeMs: stat.mtimeMs, createdMs: stat.birthtimeMs });
        }
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
      [this.live, this.desktop, this.currentAccount] = await Promise.all([
        readLiveSessions(this.claudeHome),
        readDesktopSessions(this.desktopDir),
        readCurrentAccount(this.claudeHome),
      ]);

      const seen = new Set(files.map((f) => f.id));
      for (const summary of this.sessions.values()) {
        // Claude Code prunes old transcripts. The summary is kept so the card survives.
        if (!seen.has(summary.id) && !summary.missing) {
          summary.missing = true;
          changed = true;
        }
      }

      for (const { id, file, size, mtimeMs, createdMs } of files) {
        const previous = this.sessions.get(id);
        const unchanged = previous && previous.size === size && previous.mtimeMs === mtimeMs && previous.file === file;
        let summary = previous;
        if (!unchanged || previous.missing) {
          // A file that shrank was rewritten, so its old offset no longer means anything.
          summary = previous && previous.file === file && size >= previous.offset ? previous : emptySummary(id, file);
          await readTranscript(summary, size);
          Object.assign(summary, { size, mtimeMs, missing: false });
          summary.lastAt ||= mtimeMs;
          this.sessions.set(id, summary);
          changed = true;
        }
        summary.createdMs = createdMs;
        if (await updateSubagents(summary, file, id)) changed = true;
        this.progress.done += 1;
        this.onProgress?.();
      }
      this.complete = true;
    } finally {
      this.progress.active = false;
    }
    if (changed) {
      computeUsage(this.sessions.values());
      this.saveCache();
    }
    this.onProgress?.();
  }

  // Empty transcripts (opened, nothing said) aren't useful as cards.
  visibleSessions() {
    return [...this.sessions.values()].filter((s) => s.messageCount > 0);
  }
}
