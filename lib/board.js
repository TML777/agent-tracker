// Joins the scanner's facts with the store's placement into what the UI shows.
import os from 'node:os';
import path from 'node:path';

const UNKNOWN_FOLDER = 'unknown';

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

  return {
    columns: state.columns,
    defaultColumnId: state.defaultColumnId,
    folders: [...folders.values()].sort((a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name)),
    cards: cards.sort((a, b) => b.lastAt - a.lastAt),
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
