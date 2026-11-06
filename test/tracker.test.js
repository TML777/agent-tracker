import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBoard, buildCalendar, resumeCommand, search, usageDetail } from '../lib/board.js';
import { computeUsage, emptySummary, Scanner } from '../lib/scanner.js';
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

function reply(id, usage, at = Date.now(), extra = {}) {
  return {
    type: 'assistant',
    isSidechain: false,
    timestamp: iso(at),
    cwd: '/work/my app',
    message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage },
    ...extra,
  };
}

const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 30 };

test('counts each message once and keeps cache reads out of the headline', async () => {
  const t = setup();
  t.write([
    user('go', Date.now()),
    reply('msg_1', USAGE),
    reply('msg_1', USAGE), // The same response, written again for its next content block
    reply('msg_2', USAGE),
    reply('msg_3', { input_tokens: 99, output_tokens: 99 }, Date.now(), { message: { id: 'msg_3', model: '<synthetic>', usage: { input_tokens: 99 } } }),
  ]);
  await t.scan();

  const { main } = t.scanner.sessions.get(ID).usage;
  assert.deepEqual(main, { input: 20, output: 40, cacheRead: 2000, cacheWrite: 60, calls: 2 });
  assert.equal(buildBoard(t.store, t.scanner).cards[0].tokens, 120);
});

test('includes subagent usage, reading only new bytes on later scans', async () => {
  const t = setup();
  t.write([user('go', Date.now()), reply('msg_1', USAGE)]);
  const dir = path.join(t.projectDir, ID, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const sub = path.join(dir, 'agent-a1.jsonl');
  fs.writeFileSync(sub, `${JSON.stringify(reply('sub_1', USAGE, Date.now(), { isSidechain: true }))}\n`);
  await t.scan();
  assert.equal(buildBoard(t.store, t.scanner).cards[0].tokens, 120);
  assert.equal(usageDetail(t.scanner.sessions.get(ID), t.store, t.scanner).subagentTokens, 60);

  fs.appendFileSync(sub, `${JSON.stringify(reply('sub_2', USAGE, Date.now(), { isSidechain: true }))}\n`);
  await t.scan();
  assert.equal(buildBoard(t.store, t.scanner).cards[0].tokens, 180);
  assert.equal(usageDetail(t.scanner.sessions.get(ID), t.store, t.scanner).calls, 3);
});

test('a forked chat is only charged for its own messages', async () => {
  const t = setup();
  const now = Date.now();
  const forkId = '44444444-4444-4444-4444-444444444444';
  t.write([user('go', now - 5000), reply('msg_1', USAGE, now - 5000)]);
  fs.writeFileSync(
    path.join(t.projectDir, `${forkId}.jsonl`),
    [user('go', now - 1000), reply('msg_1', USAGE, now - 1000), reply('msg_fork', USAGE, now - 1000)].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  await t.scan();

  const tokens = Object.fromEntries(buildBoard(t.store, t.scanner).cards.map((c) => [c.id, c.tokens]));
  assert.equal(tokens[ID], 60);
  assert.equal(tokens[forkId], 60);
});

test('when a fork and its parent start at the same time, the older file keeps the shared history', () => {
  const shared = [1, 2, 3, 4];
  const parent = { ...emptySummary('parent', '/p'), firstAt: 100, createdMs: 100, msgUsage: { a: shared } };
  const fork = { ...emptySummary('fork', '/f'), firstAt: 100, createdMs: 900, msgUsage: { a: shared, b: shared } };

  computeUsage([fork, parent]); // The fork comes first here, as it would if used more recently
  assert.equal(parent.usage.main.calls, 1);
  assert.equal(fork.usage.main.calls, 1);
  assert.deepEqual(fork.usage.main, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, calls: 1 });
});

test('the calendar is five Monday-to-Sunday weeks ending with this one', () => {
  const t = setup();
  const friday = new Date(2026, 10, 6, 15, 0);
  const { weeks, today } = buildCalendar(t.store, t.scanner, friday);
  assert.equal(weeks.length, 5);
  assert.ok(weeks.every((week) => week.days.length === 7));
  assert.equal(today, '2026-11-06');
  assert.equal(weeks[0].days[0].date, '2026-10-05');
  assert.equal(weeks[4].days[6].date, '2026-11-08');

  const days = weeks.flat().flatMap((week) => week.days);
  assert.deepEqual(days.filter((d) => d.isToday).map((d) => d.date), ['2026-11-06']);
  assert.deepEqual(days.filter((d) => d.isFuture).map((d) => d.date), ['2026-11-07', '2026-11-08']);
  assert.equal(new Set(days.map((d) => d.date)).size, 35);
});

test('the calendar buckets tokens by day and ignores days outside the five weeks', async () => {
  const t = setup();
  const now = new Date(2026, 10, 6, 15, 0);
  const at = (month, day) => new Date(2026, month, day, 12).getTime();
  t.write([
    user('go', at(10, 5)),
    reply('msg_1', USAGE, at(10, 5)),
    reply('msg_2', USAGE, at(10, 5)),
    reply('msg_3', USAGE, at(10, 6)),
    reply('msg_old', USAGE, at(8, 1)), // Before the calendar starts
  ]);
  await t.scan();

  const { weeks, stats } = buildCalendar(t.store, t.scanner, now);
  const days = weeks.flatMap((week) => week.days);
  const on = (date) => days.find((d) => d.date === date);
  assert.equal(on('2026-11-05').tokens, 120);
  assert.equal(on('2026-11-05').calls, 2);
  assert.equal(on('2026-11-06').tokens, 60);
  assert.equal(on('2026-11-06').chats[0].tokens, 60);
  assert.equal(on('2026-11-04').level, 0);
  assert.ok(on('2026-11-05').level > on('2026-11-06').level);

  assert.equal(stats.tokens, 180);
  assert.equal(stats.activeDays, 2);
  assert.equal(stats.perActiveDay, 90);
  assert.equal(stats.chats, 1);
  assert.deepEqual(stats.busiest, { date: '2026-11-05', tokens: 120 });
  assert.equal(weeks[4].tokens, 180);
  assert.equal(stats.folders[0].tokens, 180);
});

test('groups usage by account, labels the signed-in one, and remembers it after a switch', async () => {
  const t = setup();
  const other = '55555555-5555-5555-5555-555555555555';
  const unrecorded = '66666666-6666-6666-6666-666666666666';
  const signIn = (uuid, emailAddress) =>
    fs.writeFileSync(path.join(t.root, '.claude.json'), JSON.stringify({ secretField: 'never read', oauthAccount: { accountUuid: uuid, emailAddress } }));
  const remember = () => t.store.rememberAccount(t.scanner.currentAccount);

  t.write([{ type: 'session-owner', accountUuid: 'aaaaaaaa-0000', sessionId: ID }, user('go', Date.now()), reply('msg_1', USAGE)]);
  fs.writeFileSync(path.join(t.projectDir, `${other}.jsonl`), [{ type: 'session-owner', accountUuid: 'bbbbbbbb-0000' }, user('go', Date.now()), reply('msg_2', USAGE)].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(t.projectDir, `${unrecorded}.jsonl`), [user('go', Date.now()), reply('msg_3', USAGE)].map((l) => JSON.stringify(l)).join('\n') + '\n');

  signIn('aaaaaaaa-0000', 'first@example.com');
  await t.scan();
  remember();
  const labels = () => Object.fromEntries(buildBoard(t.store, t.scanner).accounts.map((a) => [a.label, a.tokens]));
  assert.deepEqual(labels(), { 'first@example.com': 60, 'Other account (bbbbbbbb)': 60, 'Account not recorded': 60 });

  signIn('bbbbbbbb-0000', 'second@example.com');
  await t.scan();
  remember();
  assert.deepEqual(labels(), { 'first@example.com': 60, 'second@example.com': 60, 'Account not recorded': 60 });
  assert.equal(JSON.stringify(t.store.state).includes('never read'), false);
});

test('an old cache format is rebuilt, but keeps chats whose transcript is gone', async () => {
  const t = setup();
  const cacheFile = path.join(t.root, 'data/scan-cache.json');
  const old = { ...emptySummary('gone', '/gone.jsonl'), messageCount: 1, firstPrompt: 'only copy', missing: true };
  const stale = { ...emptySummary(ID, t.transcript), messageCount: 1, firstPrompt: 'stale' };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, sessions: { gone: old, [ID]: stale } }));
  t.write([user('fresh', Date.now())]);

  const scanner = new Scanner({ claudeHome: path.join(t.root, 'claude'), desktopDir: path.join(t.root, 'desktop'), cacheFile });
  assert.equal(scanner.sessions.has(ID), false);
  await scanner.scan();
  assert.equal(scanner.sessions.get(ID).firstPrompt, 'fresh');
  assert.equal(scanner.sessions.get('gone').firstPrompt, 'only copy');
  assert.equal(buildBoard(t.store, scanner).cards.find((c) => c.id === 'gone').tokens, 0);
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
