// Joins the scanner's facts with the store's placement into what the UI shows.
import os from 'node:os';
import path from 'node:path';
import { localDate } from './scanner.js';

const UNKNOWN_FOLDER = 'unknown';
const CALENDAR_WEEKS = 5;
const TOP_CHATS_PER_DAY = 8;
const TOP_FOLDERS = 5;
const STAT_RANGES = ['3d', '7d', '5w', 'all'];

export function folderOf(summary, desktopInfo) {
  const raw = desktopInfo?.originCwd || summary.cwdFirst;
  if (!raw) return UNKNOWN_FOLDER;
  // A worktree belongs to the repo it was cut from.
  return raw.replace(/\/\.claude\/worktrees\/.*$/, '');
}

export function titleOf(summary, chat, live, desktop) {
  return (
    chat?.title ||
    live?.name ||
    summary.customTitle ||
    summary.agentName ||
    desktop?.title ||
    summary.aiTitle ||
    summary.firstPrompt ||
    summary.firstOtherPrompt ||
    'Untitled chat'
  );
}

function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function resumeCommand(summary) {
  const id = summary.id;
  return summary.cwdFirst ? `cd ${shellQuote(summary.cwdFirst)} && claude --resume ${id}` : `claude --resume ${id}`;
}

function displayPath(folder, home = os.homedir()) {
  if (folder === home) return '~';
  return folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

function folderDisplay(key, stored, home = os.homedir()) {
  if (stored?.name) return stored.name;
  if (key === UNKNOWN_FOLDER) return 'Unknown folder';
  if (key === home) return 'Home';
  return path.basename(key) || key;
}

const ACCOUNT_NOT_RECORDED = 'not-recorded';

// The transcript says which account ran a chat, but older ones don't. Desktop chats also
// show it through the folder they're stored in.
function accountOf(summary, desktop) {
  return summary.accountUuid ?? desktop?.accountUuid ?? ACCOUNT_NOT_RECORDED;
}

function accountLabel(key, store) {
  if (key === ACCOUNT_NOT_RECORDED) return 'Account not recorded';
  return store.state.accounts[key]?.email ?? `Other account (${key.slice(0, 8)})`;
}

// Headline tokens leave out cache reads: they're the same context being reused on every turn,
// and at hundreds of times the rest they would drown out everything else.
function headlineTokens(totals) {
  return totals.input + totals.output + totals.cacheWrite;
}

function chatTokens(summary) {
  const { main, subagents } = summary.usage ?? {};
  return main ? headlineTokens(main) + headlineTokens(subagents) : 0;
}

export function usageDetail(summary, store, scanner) {
  const { main, subagents } = summary.usage ?? {};
  const account = accountOf(summary, scanner.desktop.get(summary.id));
  if (!main) return { account: accountLabel(account, store), tokens: 0 };
  return {
    account: accountLabel(account, store),
    tokens: chatTokens(summary),
    input: main.input + subagents.input,
    output: main.output + subagents.output,
    cacheWrite: main.cacheWrite + subagents.cacheWrite,
    cacheRead: main.cacheRead + subagents.cacheRead,
    calls: main.calls + subagents.calls,
    subagentTokens: headlineTokens(subagents),
  };
}

function latestContext(summary) {
  if (summary.awaySummary && summary.awayAt >= summary.lastPromptAt) return summary.awaySummary;
  return summary.lastPrompt || summary.awaySummary || summary.firstOtherPrompt || '';
}

export function chatCard(summary, store, scanner) {
  const chat = store.state.chats[summary.id];
  const live = scanner.live.get(summary.id) ?? null;
  const desktop = scanner.desktop.get(summary.id);
  const defaultColumn = store.state.defaultColumnId;
  return {
    kind: 'chat',
    id: summary.id,
    title: titleOf(summary, chat, live, desktop),
    folder: folderOf(summary, desktop),
    column: chat?.column ?? defaultColumn,
    note: chat?.note ?? '',
    preview: latestContext(summary),
    lastAt: summary.lastAt,
    live: live?.status ?? null,
    branch: summary.branch,
    prCount: summary.prs.length,
    subagents: summary.subagents,
    tokens: chatTokens(summary),
    account: accountOf(summary, desktop),
    entrypoint: summary.entrypoint,
    missing: summary.missing,
    // Reopened while parked. It's flagged, not moved: stages are the user's call.
    newActivity: Boolean(
      chat && chat.column !== defaultColumn && summary.lastAt > Math.max(chat.movedAt, chat.activitySeenAt ?? 0),
    ),
    resume: resumeCommand(summary),
  };
}

function ideaCard(idea) {
  return {
    kind: 'idea',
    id: idea.id,
    title: idea.title,
    folder: idea.folder,
    column: idea.column,
    note: idea.note ?? '',
    preview: '',
    lastAt: idea.createdAt,
    live: null,
    subagents: 0,
    tokens: 0,
    prCount: 0,
    missing: false,
    newActivity: false,
  };
}

function isHidden(store, folderKey) {
  return Boolean(store.state.folders[folderKey]?.hidden);
}

function allCards(store, scanner) {
  return [
    ...scanner.visibleSessions().map((s) => chatCard(s, store, scanner)),
    ...Object.values(store.state.ideas).map(ideaCard),
  ];
}

export function chatCountIn(store, scanner, folderKey) {
  return allCards(store, scanner).filter((c) => c.kind === 'chat' && c.folder === folderKey).length;
}

// A closed folder takes its chats and ideas off the board, out of search, and out of the
// board's totals. The Calendar still counts their usage, because it really happened.
export function buildBoard(store, scanner) {
  const { state } = store;
  const everything = allCards(store, scanner);
  const cards = everything.filter((card) => !isHidden(store, card.folder));

  const hiddenFolders = new Map();
  for (const card of everything) {
    if (!isHidden(store, card.folder)) continue;
    const folder = hiddenFolders.get(card.folder) ?? {
      key: card.folder,
      name: folderDisplay(card.folder, state.folders[card.folder]),
      count: 0,
    };
    folder.count += 1;
    hiddenFolders.set(card.folder, folder);
  }
  for (const [key, stored] of Object.entries(state.folders)) {
    if (stored.hidden && stored.userCreated && !hiddenFolders.has(key)) {
      hiddenFolders.set(key, { key, name: folderDisplay(key, stored), count: 0 });
    }
  }

  const folders = new Map();
  const ensure = (key) => {
    if (!folders.has(key)) {
      const stored = state.folders[key];
      folders.set(key, {
        key,
        name: folderDisplay(key, stored),
        path: key.startsWith('project:') || key === UNKNOWN_FOLDER ? null : displayPath(key),
        userCreated: Boolean(stored?.userCreated),
        count: 0,
        lastAt: 0,
        live: 0,
      });
    }
    return folders.get(key);
  };
  for (const key of Object.keys(state.folders)) {
    if (state.folders[key].userCreated && !state.folders[key].hidden) ensure(key);
  }
  for (const card of cards) {
    const folder = ensure(card.folder);
    folder.count += 1;
    folder.lastAt = Math.max(folder.lastAt, card.lastAt);
    if (card.live) folder.live += 1;
  }

  const accounts = new Map();
  for (const card of cards) {
    if (card.kind !== 'chat') continue;
    const account = accounts.get(card.account) ?? { key: card.account, label: accountLabel(card.account, store), tokens: 0, chats: 0 };
    account.tokens += card.tokens;
    account.chats += 1;
    accounts.set(card.account, account);
  }

  return {
    accounts: [...accounts.values()].sort((a, b) => b.tokens - a.tokens),
    columns: state.columns,
    defaultColumnId: state.defaultColumnId,
    folders: [...folders.values()].sort((a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name)),
    hiddenFolders: [...hiddenFolders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    cards: cards.sort((a, b) => b.lastAt - a.lastAt),
    scan: { ...scanner.progress, complete: scanner.complete },
  };
}

// Days rise in color by rank among active days, not by share of the busiest day. One huge
// day would otherwise leave every other day looking empty.
function heatLevels(tokens) {
  const active = tokens.filter((n) => n > 0).sort((a, b) => a - b);
  const cut = (share) => active[Math.floor(active.length * share)];
  const [q1, q2, q3] = [cut(0.25), cut(0.5), cut(0.75)];
  return (n) => {
    if (n <= 0) return 0;
    if (n < q1) return 1;
    if (n < q2) return 2;
    if (n < q3) return 3;
    return 4;
  };
}

function bumpTotal(map, key, label, tokens) {
  const entry = map.get(key) ?? { label, tokens: 0 };
  entry.tokens += tokens;
  map.set(key, entry);
}

function dateKey(date) {
  return localDate(date.getTime());
}

function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function mondayOf(date) {
  return addDays(date, -((date.getDay() + 6) % 7));
}

function monthKey(date) {
  return dateKey(date).slice(0, 7);
}

// Every day with usage, across all time.
function collectDays(store, scanner) {
  const days = new Map();
  for (const summary of scanner.visibleSessions()) {
    let card = null;
    for (const [date, [input, output, cacheRead, cacheWrite, calls]] of Object.entries(summary.usage?.days ?? {})) {
      card ??= chatCard(summary, store, scanner);
      const tokens = input + output + cacheWrite;
      const day = days.get(date) ?? { tokens: 0, calls: 0, cacheRead: 0, chats: [] };
      day.tokens += tokens;
      day.calls += calls;
      day.cacheRead += cacheRead;
      day.chats.push({
        id: card.id,
        title: card.title,
        tokens,
        folder: card.folder,
        folderLabel: folderDisplay(card.folder, store.state.folders[card.folder]),
        account: card.account,
        accountLabel: accountLabel(card.account, store),
      });
      days.set(date, day);
    }
  }
  return days;
}

function buildStats(days, range, today) {
  const todayKey = dateKey(today);
  const firstUsed = [...days.keys()].sort()[0] ?? todayKey;
  const from = {
    '3d': dateKey(addDays(today, -2)),
    '7d': dateKey(addDays(today, -6)),
    '5w': dateKey(addDays(mondayOf(today), -(CALENDAR_WEEKS - 1) * 7)),
    all: firstUsed,
  }[range];

  const stats = { range, from, to: todayKey, tokens: 0, calls: 0, cacheRead: 0, activeDays: 0, busiest: null };
  const folders = new Map();
  const accounts = new Map();
  const chats = new Set();
  for (const [date, day] of days) {
    if (date < from || date > todayKey) continue;
    stats.tokens += day.tokens;
    stats.calls += day.calls;
    stats.cacheRead += day.cacheRead;
    if (day.tokens > 0) stats.activeDays += 1;
    if (!stats.busiest || day.tokens > stats.busiest.tokens) stats.busiest = { date, tokens: day.tokens };
    for (const chat of day.chats) {
      chats.add(chat.id);
      bumpTotal(folders, chat.folder, chat.folderLabel, chat.tokens);
      bumpTotal(accounts, chat.account, chat.accountLabel, chat.tokens);
    }
  }

  let elapsedDays = 0;
  for (let d = today; dateKey(d) >= from; d = addDays(d, -1)) elapsedDays += 1;

  const byTokens = (a, b) => b.tokens - a.tokens;
  return {
    ...stats,
    elapsedDays,
    perActiveDay: stats.activeDays ? Math.round(stats.tokens / stats.activeDays) : 0,
    chats: chats.size,
    folders: [...folders.values()].sort(byTokens).slice(0, TOP_FOLDERS),
    accounts: [...accounts.values()].sort(byTokens),
  };
}

// Every month from the first one with usage through this one, newest first.
function listMonths(days, today) {
  const totals = new Map();
  for (const [date, day] of days) totals.set(date.slice(0, 7), (totals.get(date.slice(0, 7)) ?? 0) + day.tokens);
  const first = [...totals.keys()].sort()[0] ?? monthKey(today);
  const months = [];
  for (let d = new Date(today.getFullYear(), today.getMonth(), 1); monthKey(d) >= first; d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) {
    months.push({
      key: monthKey(d),
      label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      tokens: totals.get(monthKey(d)) ?? 0,
    });
  }
  return months;
}

// Weeks run Monday to Sunday. The grid is either the last 5 weeks, ending with this one, or
// the weeks covering one month. The statistics range is chosen separately.
export function buildCalendar(store, scanner, now = new Date(), { mode, month, range } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = dateKey(today);
  const days = collectDays(store, scanner);
  const months = listMonths(days, today);
  const safeMode = mode === 'month' ? 'month' : 'weeks';
  const safeRange = STAT_RANGES.includes(range) ? range : '5w';
  const shownMonth = months.find((m) => m.key === month) ?? months[0];

  let start;
  let cellCount;
  if (safeMode === 'month') {
    const [year, monthNumber] = shownMonth.key.split('-').map(Number);
    start = mondayOf(new Date(year, monthNumber - 1, 1));
    const end = mondayOf(new Date(year, monthNumber, 0));
    cellCount = Math.round((end - start) / 86_400_000 / 7 + 1) * 7;
  } else {
    start = addDays(mondayOf(today), -(CALENDAR_WEEKS - 1) * 7);
    cellCount = CALENDAR_WEEKS * 7;
  }
  const dates = Array.from({ length: cellCount }, (_, i) => addDays(start, i));
  const inView = (key) => safeMode === 'weeks' || key.startsWith(shownMonth.key);
  const levelOf = heatLevels(dates.map((d) => (inView(dateKey(d)) ? (days.get(dateKey(d))?.tokens ?? 0) : 0)));

  const cells = dates.map((d, i) => {
    const date = dateKey(d);
    const outside = !inView(date);
    const day = outside ? undefined : days.get(date);
    const chats = [...(day?.chats ?? [])].sort((a, b) => b.tokens - a.tokens);
    return {
      date,
      dayOfMonth: d.getDate(),
      month: safeMode === 'weeks' && (d.getDate() === 1 || i === 0) ? d.toLocaleDateString(undefined, { month: 'short' }) : null,
      outside,
      isToday: date === todayKey,
      isFuture: d > today,
      tokens: day?.tokens ?? 0,
      calls: day?.calls ?? 0,
      cacheRead: day?.cacheRead ?? 0,
      level: levelOf(day?.tokens ?? 0),
      chatCount: chats.length,
      chats: chats.slice(0, TOP_CHATS_PER_DAY).map(({ id, title, tokens }) => ({ id, title, tokens })),
    };
  });

  return {
    today: todayKey,
    mode: safeMode,
    month: shownMonth.key,
    monthLabel: shownMonth.label,
    months,
    weeks: Array.from({ length: cellCount / 7 }, (_, w) => {
      const week = cells.slice(w * 7, (w + 1) * 7);
      return { days: week, tokens: week.reduce((sum, c) => sum + c.tokens, 0) };
    }),
    stats: buildStats(days, safeRange, today),
    scan: { ...scanner.progress, complete: scanner.complete },
  };
}

// Whitespace-separated terms must all appear somewhere in the card's text.
export function search(query, store, scanner) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const results = [];
  const matches = (text) => terms.every((term) => text.includes(term));

  for (const summary of scanner.visibleSessions()) {
    const card = chatCard(summary, store, scanner);
    if (isHidden(store, card.folder)) continue;
    const folderName = folderDisplay(card.folder, store.state.folders[card.folder]);
    const facts = [
      card.title,
      card.note,
      card.folder,
      folderName,
      card.branch,
      summary.id,
      summary.aiTitle,
      summary.customTitle,
      summary.lastReply,
      summary.awaySummary,
      ...summary.prs.flatMap((pr) => [pr.url, pr.number ? `#${pr.number}` : null]),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    if (matches(`${facts}\n${summary.searchText}`)) {
      results.push({ id: summary.id, snippet: matches(facts) ? null : snippetFor(summary.searchText, terms) });
    }
  }
  for (const idea of Object.values(store.state.ideas)) {
    if (isHidden(store, idea.folder)) continue;
    const folderName = folderDisplay(idea.folder, store.state.folders[idea.folder]);
    if (matches(`${idea.title}\n${idea.note}\n${idea.folder}\n${folderName}`.toLowerCase())) {
      results.push({ id: idea.id, snippet: null });
    }
  }
  return results;
}

function snippetFor(text, terms) {
  const at = Math.max(0, ...terms.map((term) => text.indexOf(term)));
  const start = Math.max(0, at - 50);
  const body = text.slice(start, at + 110).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}…`;
}
