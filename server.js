import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildBoard, chatCard, search } from './lib/board.js';
import { readSubagents, Scanner } from './lib/scanner.js';
import { HttpError, Store } from './lib/store.js';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.AGENT_TRACKER_PORT ?? 47823);
const HOST = '127.0.0.1';
const DATA_DIR = process.env.AGENT_TRACKER_DATA ?? path.join(ROOT, 'data');
const CLAUDE_HOME = process.env.AGENT_TRACKER_CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
const DESKTOP_DIR =
  process.env.AGENT_TRACKER_DESKTOP_DIR ??
  path.join(os.homedir(), 'Library/Application Support/Claude/claude-code-sessions');
const RESCAN_MS = 8000;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const store = new Store(path.join(DATA_DIR, 'state.json'));
const scanner = new Scanner({
  claudeHome: CLAUDE_HOME,
  desktopDir: DESKTOP_DIR,
  cacheFile: path.join(DATA_DIR, 'scan-cache.json'),
});

function placeChats() {
  store.placeNewChats(scanner.visibleSessions(), { scanComplete: scanner.complete });
}

let lastPlaced = 0;
scanner.onProgress = () => {
  // Cards are placed as the first scan reveals them, so the board fills in progressively.
  if (scanner.progress.done - lastPlaced >= 5 || !scanner.progress.active) {
    lastPlaced = scanner.progress.done;
    placeChats();
  }
};

function runScan() {
  lastPlaced = 0;
  scanner.scan().catch((err) => console.error('scan failed:', err));
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1 << 20) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

// Transcripts are private. Only pages served from this exact origin may read or change anything;
// the Host check also stops DNS rebinding from another site.
function isAllowed(req) {
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || allowedHosts.some((host) => origin === `http://${host}`);
}

async function cardDetail(id) {
  const idea = store.state.ideas[id];
  if (idea) return { kind: 'idea', ...idea };
  const summary = scanner.sessions.get(id);
  if (!summary) throw new HttpError(404, 'No such card');
  return {
    ...chatCard(summary, store, scanner),
    firstPrompt: summary.firstPrompt ?? summary.firstOtherPrompt,
    lastPrompt: summary.lastPrompt,
    lastReply: summary.lastReply,
    awaySummary: summary.awaySummary,
    awayAt: summary.awayAt,
    firstAt: summary.firstAt,
    promptCount: summary.promptCount,
    cwdFirst: summary.cwdFirst,
    cwdLast: summary.cwdLast,
    prs: summary.prs,
    subagentList: await readSubagents(summary.file, id),
  };
}

async function route(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [, resource, id] = parts;
  const method = req.method;

  if (method === 'GET' && resource === 'board') return send(res, 200, buildBoard(store, scanner));
  if (method === 'GET' && resource === 'search') {
    return send(res, 200, { results: search(url.searchParams.get('q') ?? '', store, scanner) });
  }
  if (method === 'GET' && resource === 'cards' && id) return send(res, 200, await cardDetail(id));

  const body = method === 'DELETE' && !req.headers['content-type'] ? {} : await readBody(req);

  if (resource === 'cards' && id) {
    const isIdea = Boolean(store.state.ideas[id]);
    if (method === 'POST' && parts[3] === 'move') store.moveCard(id, body.column);
    else if (method === 'PATCH' && isIdea) store.updateIdea(id, body);
    else if (method === 'PATCH') store.updateChat(id, body);
    else if (method === 'DELETE' && isIdea) store.deleteIdea(id);
    else if (method === 'DELETE') {
      if (!scanner.sessions.get(id)?.missing) throw new HttpError(400, 'Only chats whose transcript is gone can be removed');
      scanner.sessions.delete(id);
      scanner.saveCache();
      store.forgetChat(id);
    } else throw new HttpError(405, 'Method not allowed');
    return send(res, 200, { ok: true });
  }
  if (resource === 'ideas' && method === 'POST') return send(res, 201, store.createIdea(body));
  if (resource === 'columns') {
    if (method === 'POST' && id === 'reorder') store.reorderColumns(body.ids);
    else if (method === 'POST' && !id) return send(res, 201, store.addColumn(body.name));
    else if (method === 'PATCH' && id) store.updateColumn(id, body);
    else if (method === 'DELETE' && id) store.deleteColumn(id, body.moveTo);
    else throw new HttpError(405, 'Method not allowed');
    return send(res, 200, { ok: true });
  }
  if (resource === 'folders') {
    if (method === 'POST') return send(res, 201, { key: store.createFolder(body) });
    if (method === 'PATCH') store.renameFolder(body.key, body.name);
    else if (method === 'DELETE') {
      const chats = buildBoard(store, scanner).cards.filter((c) => c.kind === 'chat' && c.folder === body.key).length;
      store.deleteFolder(body.key, chats);
    } else throw new HttpError(405, 'Method not allowed');
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  if (!isAllowed(req)) return send(res, 403, { error: 'Forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await route(req, res, url);
    const asset = req.method === 'GET' ? STATIC[url.pathname] : null;
    if (!asset) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': asset[1],
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:",
    });
    fs.createReadStream(path.join(ROOT, 'public', asset[0])).pipe(res);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'Something went wrong' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is Agent Tracker already running? Open http://localhost:${PORT}`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Tracker: http://localhost:${PORT}`);
  runScan();
  setInterval(runScan, RESCAN_MS).unref();
});
