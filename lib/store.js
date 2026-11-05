// The tracker's own data: stages, card placement, notes, ideas, user-made folders.
// This is the only state the app owns. Nothing here is ever written back to Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FIRST_RUN_IDLE_DAYS = 7;

function initialState() {
  return {
    version: 1,
    seeded: false,
    defaultColumnId: 'active',
    columns: [
      { id: 'future', name: 'Future' },
      { id: 'active', name: 'Active' },
      { id: 'paused', name: 'Paused' },
      { id: 'done', name: 'Done' },
    ],
    chats: {},
    ideas: {},
    folders: {},
  };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireText(value, label, max = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new HttpError(400, `${label} is required`);
  if (text.length > max) throw new HttpError(400, `${label} is too long`);
  return text;
}

function optionalText(value, max = 20_000) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.state = this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return initialState();
    }
    try {
      return { ...initialState(), ...JSON.parse(raw) };
    } catch {
      // Keep the unreadable file for recovery rather than overwriting someone's board.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, aside);
      console.error(`state file was unreadable, moved to ${aside}`);
      return initialState();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  hasColumn(id) {
    return this.state.columns.some((c) => c.id === id);
  }

  requireColumn(id) {
    if (!this.hasColumn(id)) throw new HttpError(404, 'No such stage');
    return id;
  }

  // Gives every chat seen for the first time a stage. Placement is only ever chosen once;
  // after that the card stays where the user put it, however active the chat becomes.
  placeNewChats(summaries, { now = Date.now(), scanComplete = false } = {}) {
    const { state } = this;
    let changed = false;
    for (const summary of summaries) {
      if (state.chats[summary.id]) continue;
      // On the very first run, old chats start parked so the board isn't one huge Active column.
      const idle = !state.seeded && now - summary.lastAt > FIRST_RUN_IDLE_DAYS * 86_400_000;
      const column = idle && this.hasColumn('paused') ? 'paused' : state.defaultColumnId;
      state.chats[summary.id] = { column, movedAt: now };
      changed = true;
    }
    if (scanComplete && !state.seeded) {
      state.seeded = true;
      changed = true;
    }
    if (changed) this.save();
  }

  moveCard(id, columnId) {
    this.requireColumn(columnId);
    const card = this.state.chats[id] ?? this.state.ideas[id];
    if (!card) throw new HttpError(404, 'No such card');
    if (card.column !== columnId) {
      card.column = columnId;
      card.movedAt = Date.now();
      this.save();
    }
  }

  updateChat(id, { title, note }) {
    const chat = this.state.chats[id];
    if (!chat) throw new HttpError(404, 'No such chat');
    if (title !== undefined) chat.title = optionalText(title, 200).trim() || undefined;
    if (note !== undefined) chat.note = optionalText(note) || undefined;
    this.save();
  }

  forgetChat(id) {
    delete this.state.chats[id];
    this.save();
  }

  createIdea({ title, note, folder, column }) {
    const id = `idea-${randomUUID()}`;
    const now = Date.now();
    this.state.ideas[id] = {
      id,
      title: requireText(title, 'Title'),
      note: optionalText(note),
      folder: requireText(folder, 'Folder', 2000),
      column: this.requireColumn(column ?? this.state.columns[0].id),
      createdAt: now,
      movedAt: now,
    };
    this.save();
    return this.state.ideas[id];
  }

  updateIdea(id, { title, note, folder }) {
    const idea = this.state.ideas[id];
    if (!idea) throw new HttpError(404, 'No such idea');
    if (title !== undefined) idea.title = requireText(title, 'Title');
    if (note !== undefined) idea.note = optionalText(note);
    if (folder !== undefined) idea.folder = requireText(folder, 'Folder', 2000);
    this.save();
  }

  deleteIdea(id) {
    if (!this.state.ideas[id]) throw new HttpError(404, 'No such idea');
    delete this.state.ideas[id];
    this.save();
  }

  addColumn(name) {
    const column = { id: `col-${randomUUID()}`, name: requireText(name, 'Stage name', 60) };
    this.state.columns.push(column);
    this.save();
    return column;
  }

  updateColumn(id, { name, isDefault }) {
    const column = this.state.columns.find((c) => c.id === id);
    if (!column) throw new HttpError(404, 'No such stage');
    if (name !== undefined) column.name = requireText(name, 'Stage name', 60);
    if (isDefault === true) this.state.defaultColumnId = id;
    this.save();
  }

  reorderColumns(ids) {
    const { columns } = this.state;
    const sameSet = Array.isArray(ids) && ids.length === columns.length && columns.every((c) => ids.includes(c.id));
    if (!sameSet) throw new HttpError(400, 'Stage list does not match');
    this.state.columns = ids.map((id) => columns.find((c) => c.id === id));
    this.save();
  }

  deleteColumn(id, moveTo) {
    const { state } = this;
    this.requireColumn(id);
    if (state.columns.length === 1) throw new HttpError(400, 'At least one stage is required');
    if (moveTo === id) throw new HttpError(400, 'Choose a different stage for its cards');
    this.requireColumn(moveTo);
    for (const card of [...Object.values(state.chats), ...Object.values(state.ideas)]) {
      if (card.column === id) card.column = moveTo;
    }
    state.columns = state.columns.filter((c) => c.id !== id);
    if (state.defaultColumnId === id) state.defaultColumnId = moveTo;
    this.save();
  }

  // A user-made folder is a project with no chats yet. Giving it a real path means chats
  // started there later land in it automatically.
  createFolder({ name, path: folderPath }) {
    const cleanName = requireText(name, 'Project name', 100);
    const cleanPath = optionalText(folderPath, 2000).trim().replace(/(?<=.)\/+$/, '');
    const key = cleanPath || `project:${randomUUID()}`;
    this.state.folders[key] = { ...this.state.folders[key], name: cleanName, userCreated: true };
    this.save();
    return key;
  }

  renameFolder(key, name) {
    const trimmed = optionalText(name, 100).trim();
    this.state.folders[key] = { ...this.state.folders[key], name: trimmed || undefined };
    this.save();
  }

  deleteFolder(key, chatCount) {
    const folder = this.state.folders[key];
    if (!folder?.userCreated) throw new HttpError(400, 'Only projects you created can be removed');
    const ideas = Object.values(this.state.ideas).filter((i) => i.folder === key).length;
    if (ideas + chatCount > 0) throw new HttpError(400, 'Move or remove its cards first');
    delete this.state.folders[key];
    this.save();
  }
}
