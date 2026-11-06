// Joins the scanner's facts with the store's placement into what the UI shows.
import os from 'node:os';
import path from 'node:path';
import { localDate } from './scanner.js';

const UNKNOWN_FOLDER = 'unknown';
const CALENDAR_WEEKS = 5;
const TOP_CHATS_PER_DAY = 8;
const TOP_FOLDERS = 5;

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

export function buildBoard(store, scanner) {
  const { state } = store;
  const cards = [
    ...scanner.visibleSessions().map((s) => chatCard(s, store, scanner)),
    ...Object.values(state.ideas).map(ideaCard),
  ];

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
    if (state.folders[key].userCreated) ensure(key);
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

// Weeks run Monday to Sunday, ending with the current week.
export function buildCalendar(store, scanner, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = today.getDate() - ((today.getDay() + 6) % 7);
  const dates = Array.from({ length: CALENDAR_WEEKS * 7 }, (_, i) =>
    new Date(today.getFullYear(), today.getMonth(), monday - (CALENDAR_WEEKS - 1) * 7 + i),
  );
  const inRange = new Set(dates.map((d) => localDate(d.getTime())));
  const todayKey = localDate(today.getTime());

  const days = new Map();
  const folders = new Map();
  const accounts = new Map();
  const allChats = new Set();
  const stats = { tokens: 0, calls: 0, cacheRead: 0 };
  for (const summary of scanner.visibleSessions()) {
    let card = null;
    for (const [date, [input, output, cacheRead, cacheWrite, calls]] of Object.entries(summary.usage?.days ?? {})) {
      if (!inRange.has(date)) continue;
      card ??= chatCard(summary, store, scanner);
      const tokens = input + output + cacheWrite;
      const day = days.get(date) ?? { tokens: 0, calls: 0, cacheRead: 0, chats: [] };
      day.tokens += tokens;
      day.calls += calls;
      day.cacheRead += cacheRead;
      day.chats.push({ id: card.id, title: card.title, tokens });
      days.set(date, day);
      stats.tokens += tokens;
      stats.calls += calls;
      stats.cacheRead += cacheRead;
      allChats.add(card.id);
      bumpTotal(folders, card.folder, folderDisplay(card.folder, store.state.folders[card.folder]), tokens);
      bumpTotal(accounts, card.account, accountLabel(card.account, store), tokens);
    }
  }

  const levelOf = heatLevels([...days.values()].map((d) => d.tokens));
  const cells = dates.map((d) => {
    const date = localDate(d.getTime());
    const day = days.get(date);
    const chats = (day?.chats ?? []).sort((a, b) => b.tokens - a.tokens);
    return {
      date,
      dayOfMonth: d.getDate(),
      month: d.getDate() === 1 || date === localDate(dates[0].getTime()) ? d.toLocaleDateString(undefined, { month: 'short' }) : null,
      isToday: date === todayKey,
      isFuture: d > today,
      tokens: day?.tokens ?? 0,
      calls: day?.calls ?? 0,
      cacheRead: day?.cacheRead ?? 0,
      level: levelOf(day?.tokens ?? 0),
      chatCount: chats.length,
      chats: chats.slice(0, TOP_CHATS_PER_DAY),
    };
  });

  const active = cells.filter((c) => c.tokens > 0);
  const busiest = active.reduce((best, c) => (!best || c.tokens > best.tokens ? c : best), null);
  const byTokens = (a, b) => b.tokens - a.tokens;
  return {
    today: todayKey,
    weeks: Array.from({ length: CALENDAR_WEEKS }, (_, w) => {
      const week = cells.slice(w * 7, (w + 1) * 7);
      return { days: week, tokens: week.reduce((sum, c) => sum + c.tokens, 0) };
    }),
    stats: {
      ...stats,
      activeDays: active.length,
      elapsedDays: cells.filter((c) => !c.isFuture).length,
      perActiveDay: active.length ? Math.round(stats.tokens / active.length) : 0,
      chats: allChats.size,
      busiest: busiest && { date: busiest.date, tokens: busiest.tokens },
      folders: [...folders.values()].sort(byTokens).slice(0, TOP_FOLDERS),
      accounts: [...accounts.values()].sort(byTokens),
    },
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
