import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBoard, resumeCommand, search } from '../lib/board.js';
import { Scanner } from '../lib/scanner.js';
import { Store } from '../lib/store.js';

const ID = '11111111-1111-1111-1111-111111111111';
const iso = (ms) => new Date(ms).toISOString();

function user(text, at, extra = {}) {
  return {
    type: 'user',
    isSidechain: false,
    cwd: '/work/my app',
    gitBranch: 'feature/x',
    entrypoint: 'cli',
    timestamp: iso(at),
    origin: { kind: 'human' },
    message: { role: 'user', content: text },
    ...extra,
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tracker-'));
  const projectDir = path.join(root, 'claude/projects/-work-my-app');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, `${ID}.jsonl`);
  const scanner = new Scanner({
    claudeHome: path.join(root, 'claude'),
    desktopDir: path.join(root, 'desktop'),
    cacheFile: path.join(root, 'data/scan-cache.json'),
  });
  const store = new Store(path.join(root, 'data/state.json'));
  const write = (lines) => fs.appendFileSync(transcript, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const scan = async () => {
    await scanner.scan();
    store.placeNewChats(scanner.visibleSessions(), { scanComplete: true });
  };
  return { root, projectDir, transcript, scanner, store, write, scan };
}

test('summarizes a transcript and ignores everything that is not a typed prompt', async () => {
  const t = setup();
  const now = Date.now();
  t.write([
    user('build the thing', now - 5000),
    user('<command-name>/compact</command-name>', now - 4900),
    user('note from another agent', now - 4800, { origin: { kind: 'peer' } }),
    user([{ type: 'tool_result', content: 'output' }], now - 4700),
    user('hidden', now - 4600, { isMeta: true }),
    user('subagent chatter', now - 4500, { isSidechain: true }),
    { type: 'assistant', timestamp: iso(now - 4000), cwd: '/work/my app/sub', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'custom-title', customTitle: 'My title' },
    { type: 'ai-title', aiTitle: 'AI title' },
    { type: 'pr-link', prUrl: 'https://github.com/a/b/pull/1', prNumber: 1, prRepository: 'a/b' },
    { type: 'pr-link', prUrl: 'https://github.com/a/b/pull/1', prNumber: 1, prRepository: 'a/b' },
  ]);
  await t.scan();

  const s = t.scanner.sessions.get(ID);
  assert.equal(s.firstPrompt, 'build the thing');
  assert.equal(s.lastPrompt, 'build the thing');
  assert.equal(s.promptCount, 1);
  assert.equal(s.lastReply, 'done');
  assert.equal(s.cwdFirst, '/work/my app');
  assert.equal(s.cwdLast, '/work/my app/sub');
  assert.equal(s.prs.length, 1);

  const [card] = buildBoard(t.store, t.scanner).cards;
  assert.equal(card.title, 'My title');
  assert.equal(card.folder, '/work/my app');
  assert.equal(card.column, 'active');
});

test('rescans only appended bytes and tolerates a partial or malformed line', async () => {
  const t = setup();
  const now = Date.now();
  t.write([user('first', now)]);
  fs.appendFileSync(t.transcript, 'not json at all "type":"user"\n');
  fs.appendFileSync(t.transcript, '{"type":"user","message":{"content":"half a li');
  await t.scan();
  const s = t.scanner.sessions.get(ID);
  const offsetBefore = s.offset;
  assert.ok(offsetBefore < fs.statSync(t.transcript).size, 'partial line must not be consumed');

  fs.appendFileSync(t.transcript, `ne"},"origin":{"kind":"human"},"timestamp":"${iso(now + 1)}"}\n`);
  await t.scan();
  assert.equal(s.lastPrompt, 'half a line');
  assert.equal(s.promptCount, 2);
  assert.equal(s.offset, fs.statSync(t.transcript).size);
});

test('keeps stage, note and summary when Claude Code prunes the transcript', async () => {
  const t = setup();
  t.write([user('old work', Date.now())]);
  await t.scan();
  t.store.moveCards([ID], 'done');
  t.store.updateChat(ID, { note: 'shipped' });
  fs.rmSync(t.transcript);
  await t.scan();

  const [card] = buildBoard(t.store, t.scanner).cards;
  assert.equal(card.missing, true);
  assert.equal(card.column, 'done');
  assert.equal(card.note, 'shipped');
  assert.equal(card.preview, 'old work');
});

test('first run parks idle chats; later chats land in the default stage however old', async () => {
  const t = setup();
  const old = Date.now() - 30 * 86_400_000;
  t.write([user('ancient', old)]);
  await t.scan();
  assert.equal(t.store.state.chats[ID].column, 'paused');

  const laterId = '22222222-2222-2222-2222-222222222222';
  fs.writeFileSync(path.join(t.projectDir, `${laterId}.jsonl`), `${JSON.stringify(user('resumed', old))}\n`);
  await t.scan();
  assert.equal(t.store.state.chats[laterId].column, 'active');
});

test('flags new activity on a parked chat without moving it', async () => {
  const t = setup();
  t.write([user('work', Date.now() - 60_000)]);
  await t.scan();
  t.store.moveCards([ID], 'done');
  assert.equal(buildBoard(t.store, t.scanner).cards[0].newActivity, false);

  t.write([user('back at it', Date.now() + 60_000)]);
  await t.scan();
  const [card] = buildBoard(t.store, t.scanner).cards;
  assert.equal(card.newActivity, true);
  assert.equal(card.column, 'done');

  t.store.moveCards([ID], 'active');
  assert.equal(buildBoard(t.store, t.scanner).cards[0].newActivity, false);
});

test('dismissing new activity leaves the card in place, and later activity brings it back', async () => {
  const t = setup();
  t.write([user('work', Date.now() - 60_000)]);
  await t.scan();
  t.store.moveCards([ID], 'done');
  t.write([user('back at it', Date.now() + 60_000)]);
  await t.scan();
  assert.equal(buildBoard(t.store, t.scanner).cards[0].newActivity, true);

  t.store.dismissActivity(ID, Date.now() + 90_000);
  let [card] = buildBoard(t.store, t.scanner).cards;
  assert.equal(card.newActivity, false);
  assert.equal(card.column, 'done');

  t.write([user('and again', Date.now() + 120_000)]);
  await t.scan();
  [card] = buildBoard(t.store, t.scanner).cards;
  assert.equal(card.newActivity, true);
});

test('moves several cards together, or none if any is unknown', async () => {
  const t = setup();
  const second = '33333333-3333-3333-3333-333333333333';
  t.write([user('one', Date.now())]);
  fs.writeFileSync(path.join(t.projectDir, `${second}.jsonl`), `${JSON.stringify(user('two', Date.now()))}\n`);
  await t.scan();
  const idea = t.store.createIdea({ title: 'Later', folder: '/work/my app', column: 'future' });

  t.store.moveCards([ID, second, idea.id], 'done');
  for (const card of buildBoard(t.store, t.scanner).cards) assert.equal(card.column, 'done');

  assert.throws(() => t.store.moveCards([ID, 'nope'], 'paused'), /No such card/);
  assert.throws(() => t.store.moveCards('not a list', 'paused'), /Expected a list/);
  assert.throws(() => t.store.moveCards([ID], 'no-such-stage'), /No such stage/);
  assert.equal(t.store.state.chats[ID].column, 'done');
});

test('deleting a stage moves its cards, and the default follows', async () => {
  const t = setup();
  t.write([user('work', Date.now())]);
  await t.scan();
  t.store.deleteColumn('active', 'future');
  assert.equal(t.store.state.chats[ID].column, 'future');
  assert.equal(t.store.state.defaultColumnId, 'future');
  assert.throws(() => t.store.deleteColumn('future', 'future'));
});

test('project folders can hold ideas and adopt chats started at their path', async () => {
  const t = setup();
  t.write([user('work', Date.now())]);
  await t.scan();
  const named = t.store.createFolder({ name: 'Renamed', path: '/work/my app/' });
  assert.equal(named, '/work/my app');
  const future = t.store.createFolder({ name: 'Someday' });
  t.store.createIdea({ title: 'Recipe app', folder: future, column: 'future' });

  const board = buildBoard(t.store, t.scanner);
  const someday = board.folders.find((f) => f.key === future);
  assert.equal(someday.name, 'Someday');
  assert.equal(someday.count, 1);
  assert.equal(board.folders.find((f) => f.key === named).count, 1);
  assert.throws(() => t.store.deleteFolder(future, 0), /Move or remove/);
});

test('search needs every term, and looks through typed messages and ideas', async () => {
  const t = setup();
  t.write([user('Fix the Geocoding bug', Date.now()), { type: 'custom-title', customTitle: 'Maps work' }]);
  await t.scan();
  const key = t.store.createFolder({ name: 'Someday' });
  const idea = t.store.createIdea({ title: 'Recipe app', folder: key });

  const hit = search('geocoding bug', t.store, t.scanner);
  assert.deepEqual(hit.map((r) => r.id), [ID]);
  assert.match(hit[0].snippet, /geocoding/);
  assert.deepEqual(search('geocoding recipe', t.store, t.scanner), []);
  assert.deepEqual(search('someday', t.store, t.scanner).map((r) => r.id), [idea.id]);
});

test('resume command quotes awkward folder names', () => {
  const command = resumeCommand({ id: ID, cwdFirst: "/work/it's here" });
  assert.equal(command, `cd '/work/it'\\''s here' && claude --resume ${ID}`);
});

test('an unreadable state file is set aside, not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tracker-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{broken');
  const store = new Store(file);
  assert.equal(store.state.columns.length, 4);
  const aside = fs.readdirSync(dir).find((name) => name.includes('corrupt'));
  assert.equal(fs.readFileSync(path.join(dir, aside), 'utf8'), '{broken');
});
