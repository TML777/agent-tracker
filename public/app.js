const POLL_MS = 4000;
const SEARCH_DEBOUNCE_MS = 120;

const $ = (id) => document.getElementById(id);

const view = {
  board: null,
  boardJson: '',
  folder: readHashFolder(), // null means all folders
  folderBeforeSearch: null,
  query: '',
  matches: null, // Map of id to snippet while searching
  openCardId: null,
  selected: new Set(),
  selectAnchor: null, // Where a shift-click range starts
  draggingCards: null,
  draggingColumn: null,
  addingStage: false,
  renamingColumn: null,
};

// All text goes through textContent, so nothing from a transcript can inject markup.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

async function api(method, url, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/${url}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function act(promise) {
  return promise.then(refresh).catch((err) => {
    toast(err.message);
    // The screen may already show a change the server refused, so force a redraw from its data.
    view.boardJson = '';
    return refresh().catch(() => {});
  });
}

let toastTimer;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 2600);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Could not reach the clipboard');
  }
}

function ago(ms) {
  if (!ms) return '';
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function fullDate(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function readHashFolder() {
  try {
    return decodeURIComponent(location.hash.slice(1)) || null;
  } catch {
    return null;
  }
}

function selectFolder(key) {
  view.folder = key;
  if (!view.query) history.replaceState(null, '', key ? `#${encodeURIComponent(key)}` : location.pathname);
  render();
}

const liveLabel = { busy: 'Working right now', open: 'Open, waiting for you' };

function liveDot(status) {
  if (!status) return null;
  return el('span', { class: `live-dot ${status === 'busy' ? 'busy' : ''}`, title: liveLabel[status], role: 'img', ariaLabel: liveLabel[status] });
}

// Data views

function visibleCards() {
  const { board, folder, matches } = view;
  return board.cards.filter((card) => {
    if (matches && !matches.has(card.id)) return false;
    return !folder || card.folder === folder;
  });
}

function folderByKey(key) {
  return view.board.folders.find((f) => f.key === key);
}

// Rendering

function render() {
  if (!view.board) return;
  const visible = new Set(visibleCards().map((card) => card.id));
  for (const id of view.selected) {
    if (!visible.has(id)) view.selected.delete(id); // Never move a card you can't see.
  }
  renderSidebar();
  renderHeader();
  renderBoard();
}

// Re-rendering replaces nodes, so don't do it under an open menu, a drag or a rename.
function isInteracting() {
  return Boolean(
    view.draggingCards ||
      view.draggingColumn ||
      view.addingStage ||
      view.renamingColumn ||
      document.querySelector('details.menu[open]') ||
      document.activeElement?.closest?.('.selection-bar select'),
  );
}

function folderButton(key, name, pathText, count, live) {
  return el(
    'button',
    {
      class: `folder ${view.folder === key ? 'selected' : ''}`,
      type: 'button',
      ariaCurrent: view.folder === key ? 'true' : undefined,
      title: pathText || name,
      onclick: () => selectFolder(key),
    },
    el('span', { class: 'folder-name' }, name),
    el('span', { class: 'folder-count' }, live ? liveDot('open') : null, String(count)),
    pathText ? el('span', { class: 'folder-path' }, pathText) : null,
  );
}

// Most recent first, as of page load. With several agents running, a live re-sort would
// swap rows just as you click them. Folders that appear later go on top.
const folderRank = new Map();
function stableFolderOrder(folders) {
  const unseen = folders.filter((f) => !folderRank.has(f.key));
  const firstRank = Math.min(0, ...folderRank.values()) - unseen.length;
  unseen.forEach((f, i) => folderRank.set(f.key, firstRank + i));
  return [...folders].sort((a, b) => folderRank.get(a.key) - folderRank.get(b.key));
}

function renderSidebar() {
  const { board, matches, query } = view;
  const counts = new Map();
  for (const card of board.cards) {
    if (!matches || matches.has(card.id)) counts.set(card.folder, (counts.get(card.folder) ?? 0) + 1);
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const folders = stableFolderOrder(board.folders).filter((f) => {
    if (!matches) return true;
    const label = `${f.name} ${f.path ?? ''}`.toLowerCase();
    return counts.get(f.key) || terms.every((t) => label.includes(t));
  });
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const allLive = board.folders.reduce((sum, f) => sum + f.live, 0);
  const scroll = $('folders').scrollTop;
  $('folders').replaceChildren(
    folderButton(null, 'All folders', null, total, allLive),
    ...folders.map((f) => folderButton(f.key, f.name, f.path, counts.get(f.key) ?? 0, f.live)),
  );
  $('folders').scrollTop = scroll;

  const { scan } = board;
  $('scan-status').textContent = scan.complete || !scan.total ? (scan.complete ? plural(board.cards.filter((c) => c.kind === 'chat').length, 'chat') : '') : `Reading transcripts: ${scan.done} of ${scan.total}`;
}

function renderHeader() {
  const { matches, folder, query } = view;
  const current = folder ? folderByKey(folder) : null;
  const shown = visibleCards().length;
  const heading = matches ? `${plural(shown, 'match').replace('matchs', 'matches')} for “${query}”` : (current?.name ?? 'All folders');
  const subtitle = matches ? (current ? `in ${current.name}` : 'across all folders') : (current?.path ?? plural(shown, 'card'));

  const actions = [];
  if (current && !matches) {
    actions.push(el('button', { class: 'link-button', type: 'button', onclick: () => renameFolderForm(current) }, 'Rename'));
    if (current.userCreated && current.count === 0) {
      actions.push(
        el(
          'button',
          {
            class: 'link-button danger',
            type: 'button',
            onclick: () => {
              if (view.folder === current.key) selectFolder(null);
              act(api('DELETE', 'folders', { key: current.key }));
            },
          },
          'Remove project',
        ),
      );
    }
  }
  $('main-header').replaceChildren(
    el('h1', {}, heading),
    el('span', { class: 'subtle' }, subtitle),
    view.selected.size ? renderSelectionBar() : el('div', { class: 'header-actions' }, actions),
  );
}

function renderSelectionBar() {
  return el(
    'div',
    { class: 'selection-bar' },
    el('span', { class: 'selection-count' }, `${view.selected.size} selected`),
    el(
      'select',
      {
        ariaLabel: 'Move selected cards to stage',
        onchange: (e) => moveCards([...view.selected], e.target.value),
      },
      el('option', { value: '', disabled: true, selected: true, hidden: true }, 'Move to…'),
      view.board.columns.map((c) => el('option', { value: c.id }, c.name)),
    ),
    el('button', { class: 'link-button', type: 'button', onclick: clearSelection }, 'Clear'),
  );
}

function clearSelection() {
  view.selected.clear();
  view.selectAnchor = null;
  render();
}

// Shift selects from the last card you picked to this one, within a single stage.
function toggleSelect(card, event) {
  const anchor = view.board.cards.find((c) => c.id === view.selectAnchor);
  if (event.shiftKey && anchor && anchor.column === card.column) {
    const inColumn = visibleCards().filter((c) => c.column === card.column);
    const from = inColumn.findIndex((c) => c.id === anchor.id);
    const to = inColumn.findIndex((c) => c.id === card.id);
    for (const c of inColumn.slice(Math.min(from, to), Math.max(from, to) + 1)) view.selected.add(c.id);
  } else if (view.selected.has(card.id)) {
    view.selected.delete(card.id);
  } else {
    view.selected.add(card.id);
  }
  view.selectAnchor = card.id;
  render();
}

function renderBoard() {
  const board = $('board');
  const scrollLeft = board.scrollLeft;
  const columnScroll = new Map([...board.querySelectorAll('.column')].map((c) => [c.dataset.id, c.querySelector('.cards').scrollTop]));
  const focusedCard = document.activeElement?.closest?.('.card')?.dataset.id;

  const cards = visibleCards();
  const nodes = view.board.columns.map((column) =>
    renderColumn(column, cards.filter((card) => card.column === column.id)),
  );
  nodes.push(renderAddStage());
  if (view.matches && !cards.length) {
    nodes.unshift(el('div', { class: 'empty-board' }, 'Nothing matches that search. It checks titles, your notes, folders, branches, PRs, and the messages you typed.'));
  }
  board.replaceChildren(...nodes);
  board.classList.toggle('selecting', view.selected.size > 0);

  board.scrollLeft = scrollLeft;
  for (const node of board.querySelectorAll('.column')) {
    node.querySelector('.cards').scrollTop = columnScroll.get(node.dataset.id) ?? 0;
  }
  if (focusedCard) board.querySelector(`.card[data-id="${CSS.escape(focusedCard)}"]`)?.focus();
}

function renderColumn(column, cards) {
  const node = el(
    'section',
    { class: 'column', dataset: { id: column.id }, ariaLabel: column.name },
    renderColumnHead(column, cards.length),
    el('div', { class: 'cards' }, cards.map(renderCard)),
    el(
      'button',
      { class: 'add-idea', type: 'button', onclick: () => ideaForm(column.id) },
      '+ Add idea',
    ),
  );

  node.addEventListener('dragover', (event) => {
    if (view.draggingCards) {
      event.preventDefault();
      node.classList.add('drop-target');
    } else if (view.draggingColumn && view.draggingColumn !== column.id) {
      event.preventDefault();
    }
  });
  node.addEventListener('dragleave', (event) => {
    if (!node.contains(event.relatedTarget)) node.classList.remove('drop-target');
  });
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    node.classList.remove('drop-target');
    if (view.draggingCards) moveCards(view.draggingCards, column.id);
    else if (view.draggingColumn) dropColumn(view.draggingColumn, column.id);
  });
  return node;
}

function renderColumnHead(column, count) {
  if (view.renamingColumn === column.id) {
    const finish = (save, value) => {
      if (view.renamingColumn !== column.id) return;
      view.renamingColumn = null;
      const name = save ? value.trim() : '';
      if (name && name !== column.name) {
        column.name = name; // Show it instantly; refresh confirms it.
        act(api('PATCH', `columns/${column.id}`, { name }));
      }
      render();
    };
    const input = el('input', {
      class: 'column-input',
      value: column.name,
      ariaLabel: 'Stage name',
      maxLength: 60,
      onkeydown: (e) => {
        if (e.key === 'Enter') finish(true, e.target.value);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(false);
        }
      },
      onblur: (e) => finish(true, e.target.value),
    });
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return el('div', { class: 'column-head' }, input);
  }

  const isDefault = view.board.defaultColumnId === column.id;
  const head = el(
    'div',
    { class: 'column-head', draggable: true },
    el('span', { class: 'column-name' }, column.name),
    el('span', { class: 'column-count' }, String(count)),
    isDefault ? el('span', { class: 'default-tag', title: 'New chats land in this stage' }, 'new chats') : null,
    renderColumnMenu(column, isDefault),
  );
  head.addEventListener('dragstart', (event) => {
    view.draggingColumn = column.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', column.name);
  });
  head.addEventListener('dragend', () => {
    view.draggingColumn = null;
    render();
  });
  return head;
}

function renderColumnMenu(column, isDefault) {
  const { columns } = view.board;
  const index = columns.findIndex((c) => c.id === column.id);
  const close = (handler) => (event) => {
    event.target.closest('details').open = false;
    handler();
  };
  return el(
    'details',
    { class: 'menu' },
    el('summary', { ariaLabel: `${column.name} stage options`, title: 'Stage options' }, '⋯'),
    el(
      'div',
      { class: 'menu-panel' },
      el('button', { type: 'button', onclick: close(() => { view.renamingColumn = column.id; render(); }) }, 'Rename'),
      el('button', { type: 'button', disabled: isDefault, onclick: close(() => act(api('PATCH', `columns/${column.id}`, { isDefault: true }))) }, isDefault ? 'New chats land here' : 'Send new chats here'),
      el('button', { type: 'button', disabled: index === 0, onclick: close(() => shiftColumn(index, -1)) }, 'Move left'),
      el('button', { type: 'button', disabled: index === columns.length - 1, onclick: close(() => shiftColumn(index, 1)) }, 'Move right'),
      el('button', { type: 'button', class: 'danger', disabled: columns.length === 1, onclick: close(() => deleteColumnForm(column)) }, 'Delete stage'),
    ),
  );
}

function reorder(ids) {
  act(api('POST', 'columns/reorder', { ids }));
}

function shiftColumn(index, delta) {
  const ids = view.board.columns.map((c) => c.id);
  [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
  reorder(ids);
}

function dropColumn(dragged, target) {
  const ids = view.board.columns.map((c) => c.id);
  const from = ids.indexOf(dragged);
  const to = ids.indexOf(target);
  ids.splice(from, 1);
  ids.splice(to, 0, dragged);
  reorder(ids);
}

function renderAddStage() {
  if (view.addingStage) {
    const finish = (value) => {
      if (!view.addingStage) return;
      view.addingStage = false;
      if (value?.trim()) act(api('POST', 'columns', { name: value }));
      render();
    };
    const input = el('input', {
      placeholder: 'Stage name',
      ariaLabel: 'New stage name',
      maxLength: 60,
      onkeydown: (e) => {
        if (e.key === 'Enter') finish(e.target.value);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish();
        }
      },
      onblur: (e) => finish(e.target.value),
    });
    queueMicrotask(() => input.focus());
    return el('div', { class: 'add-stage' }, input);
  }
  return el(
    'div',
    { class: 'add-stage' },
    el('button', { type: 'button', onclick: () => { view.addingStage = true; render(); } }, '+ Add stage'),
  );
}

function renderCard(card) {
  const showFolder = !view.folder;
  const folderName = showFolder ? folderByKey(card.folder)?.name : null;
  const snippet = view.matches?.get(card.id);
  const preview = snippet || card.preview;
  const isSelected = view.selected.has(card.id);
  const node = el(
    'article',
    {
      class: `card ${card.missing ? 'missing' : ''} ${view.openCardId === card.id ? 'open' : ''} ${isSelected ? 'selected' : ''}`,
      draggable: true,
      tabIndex: 0,
      dataset: { id: card.id },
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) toggleSelect(card, e);
        else openDrawer(card.id);
      },
      onkeydown: (e) => {
        if (e.target !== node) return;
        if (e.key === 'Enter') openDrawer(card.id);
        if (e.key === ' ') {
          e.preventDefault();
          toggleSelect(card, e);
        }
      },
    },
    el('input', {
      class: 'card-select',
      type: 'checkbox',
      checked: isSelected,
      ariaLabel: `Select ${card.title}`,
      title: 'Select to move several cards together',
      onclick: (e) => {
        e.stopPropagation();
        toggleSelect(card, e);
      },
    }),
    el('div', { class: 'card-title' }, liveDot(card.live), card.title),
    preview && preview !== card.title ? el('div', { class: 'card-preview' }, preview) : null,
    card.note ? el('div', { class: 'card-note' }, card.note) : null,
    el(
      'div',
      { class: 'card-meta' },
      card.kind === 'idea' ? el('span', { class: 'tag' }, 'Idea') : el('span', { title: fullDate(card.lastAt) }, ago(card.lastAt)),
      card.newActivity
        ? el(
            'span',
            { class: 'tag attention pill', title: 'This chat has been used since you moved it here' },
            'New activity',
            el(
              'button',
              {
                class: 'pill-x',
                type: 'button',
                ariaLabel: `Clear New activity on ${card.title}`,
                title: 'Clear',
                onclick: (e) => {
                  e.stopPropagation();
                  dismissActivity(card);
                },
              },
              '×',
            ),
          )
        : null,
      card.missing ? el('span', { class: 'tag attention', title: 'Claude Code removed this transcript. Only the summary remains.' }, 'Transcript gone') : null,
      folderName ? el('span', { class: 'tag' }, folderName) : null,
      card.entrypoint === 'claude-desktop' ? el('span', {}, 'Desktop') : null,
      card.branch ? el('span', { class: 'card-branch', title: card.branch }, card.branch) : null,
      card.prCount ? el('span', {}, plural(card.prCount, 'PR')) : null,
      card.subagents ? el('span', {}, plural(card.subagents, 'subagent')) : null,
    ),
    card.resume && !card.missing
      ? el(
          'button',
          {
            class: 'card-copy',
            type: 'button',
            title: card.resume,
            onclick: (e) => {
              e.stopPropagation();
              copyText(card.resume, 'Resume command copied');
            },
          },
          'Copy resume',
        )
      : null,
  );
  node.addEventListener('dragstart', (event) => {
    event.stopPropagation();
    // Dragging a selected card takes the whole selection; any other card goes alone.
    const ids = view.selected.has(card.id) ? [...view.selected] : [card.id];
    view.draggingCards = ids;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', ids.length > 1 ? `${ids.length} cards` : card.title);
    for (const dragged of document.querySelectorAll('.card')) {
      if (ids.includes(dragged.dataset.id)) dragged.classList.add('dragging');
    }
    if (ids.length > 1) {
      const ghost = el('div', { class: 'drag-ghost' }, `${ids.length} cards`);
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, 14, 14);
      setTimeout(() => ghost.remove());
    }
  });
  node.addEventListener('dragend', () => {
    view.draggingCards = null;
    render();
  });
  return node;
}

function moveCards(ids, columnId) {
  const moving = view.board.cards.filter((c) => ids.includes(c.id) && c.column !== columnId);
  for (const id of ids) view.selected.delete(id);
  view.draggingCards = null;
  for (const card of moving) {
    card.column = columnId; // Move instantly; refresh confirms it.
    card.newActivity = false;
  }
  render();
  if (!moving.length) return;
  if (moving.length > 1) {
    const stage = view.board.columns.find((c) => c.id === columnId)?.name;
    toast(`Moved ${moving.length} cards to ${stage}`);
  }
  act(api('POST', 'cards/move', { ids: moving.map((c) => c.id), column: columnId }));
}

function dismissActivity(card) {
  card.newActivity = false;
  render();
  if (view.openCardId === card.id) $('drawer').querySelector('.activity-notice')?.remove();
  act(api('POST', `cards/${encodeURIComponent(card.id)}/dismiss-activity`, {}));
}

// Drawer

async function openDrawer(id) {
  view.openCardId = id;
  markOpenCard();
  try {
    const detail = await api('GET', `cards/${encodeURIComponent(id)}`);
    if (view.openCardId === id) renderDrawer(detail);
  } catch (err) {
    toast(err.message);
  }
}

function closeDrawer() {
  if (document.activeElement?.closest?.('#drawer')) document.activeElement.blur();
  view.openCardId = null;
  $('drawer').hidden = true;
  markOpenCard();
}

function markOpenCard() {
  for (const card of document.querySelectorAll('.card')) {
    card.classList.toggle('open', card.dataset.id === view.openCardId);
  }
}

function section(title, ...content) {
  return el('div', { class: 'section' }, el('h2', {}, title), ...content);
}

function textSection(title, text) {
  return text ? section(title, el('p', {}, text)) : null;
}

function saver(id, field) {
  let timer;
  let last;
  const save = (value) => {
    clearTimeout(timer);
    if (value === last) return;
    last = value;
    act(api('PATCH', `cards/${encodeURIComponent(id)}`, { [field]: value }));
  };
  return {
    start: (value) => (last = value),
    oninput: (e) => {
      clearTimeout(timer);
      const { value } = e.target;
      timer = setTimeout(() => save(value), 500);
    },
    onblur: (e) => save(e.target.value),
  };
}

function renderDrawer(card) {
  const isIdea = card.kind === 'idea';
  const titleSave = saver(card.id, 'title');
  titleSave.start(card.title);
  const noteSave = saver(card.id, 'note');
  noteSave.start(card.note ?? '');
  const folder = folderByKey(card.folder);

  const stage = el(
    'select',
    {
      ariaLabel: 'Stage',
      onchange: (e) => {
        moveCards([card.id], e.target.value);
      },
    },
    view.board.columns.map((c) => el('option', { value: c.id, selected: c.id === card.column }, c.name)),
  );

  const parts = [
    el(
      'div',
      { class: 'drawer-top' },
      el('span', {}, isIdea ? 'Idea' : `${folder?.name ?? 'Chat'}${card.live ? ` · ${liveLabel[card.live]}` : ''}`),
      el('button', { class: 'drawer-close', type: 'button', ariaLabel: 'Close details', onclick: closeDrawer }, '×'),
    ),
    el('textarea', { class: 'drawer-title', rows: 1, ariaLabel: 'Title', value: card.title, maxLength: 200, oninput: titleSave.oninput, onblur: titleSave.onblur }),
    el(
      'div',
      { class: 'drawer-row' },
      stage,
      card.resume && !card.missing
        ? el('button', { class: 'primary-button', type: 'button', title: card.resume, onclick: () => copyText(card.resume, 'Resume command copied') }, 'Copy resume command')
        : null,
      isIdea
        ? el('button', { class: 'secondary-button danger', type: 'button', onclick: () => removeCard(card.id) }, 'Delete idea')
        : null,
      card.missing
        ? el('button', { class: 'secondary-button danger', type: 'button', onclick: () => removeCard(card.id) }, 'Remove from tracker')
        : null,
    ),
    card.missing ? el('div', { class: 'notice' }, 'Claude Code has removed this transcript, so it can no longer be resumed. This summary is all that remains.') : null,
    card.newActivity ? el('div', { class: 'notice activity-notice' }, 'This chat has been used since you moved it to this stage.') : null,
    section('Your note', el('textarea', { class: 'note', ariaLabel: 'Your note', value: card.note ?? '', placeholder: 'What to do next, why this is parked…', oninput: noteSave.oninput, onblur: noteSave.onblur })),
    isIdea ? ideaFolderSection(card) : null,
    isIdea ? null : textSection(`Where you left off${card.awayAt ? ` (${ago(card.awayAt)} ago)` : ''}`, card.awaySummary),
    isIdea ? null : textSection('Your last message', card.lastPrompt),
    isIdea ? null : textSection('Claude’s last reply', card.lastReply),
    isIdea || card.firstPrompt === card.lastPrompt ? null : textSection('How it started', card.firstPrompt),
    card.prs?.length ? section(plural(card.prs.length, 'pull request'), ...card.prs.map(prLine)) : null,
    card.subagentList?.length ? subagentSection(card.subagentList) : null,
    isIdea ? null : factsSection(card),
  ];
  $('drawer').replaceChildren(...parts.filter(Boolean));
  $('drawer').hidden = false;
  $('drawer').scrollTop = 0;
}

function ideaFolderSection(card) {
  return section(
    'Project',
    el(
      'select',
      {
        ariaLabel: 'Project',
        onchange: (e) => act(api('PATCH', `cards/${encodeURIComponent(card.id)}`, { folder: e.target.value })),
      },
      view.board.folders.map((f) => el('option', { value: f.key, selected: f.key === card.folder }, f.name)),
    ),
  );
}

function prLine(pr) {
  const safe = /^https:\/\//.test(pr.url);
  const label = pr.repo && pr.number ? `${pr.repo}#${pr.number}` : pr.url;
  return el('p', {}, safe ? el('a', { href: pr.url, target: '_blank', rel: 'noreferrer' }, label) : label);
}

function subagentSection(list) {
  const unfinished = list.filter((a) => !a.finished).length;
  return section(
    'Subagents',
    el(
      'details',
      { class: 'subagents' },
      el('summary', {}, `${plural(list.length, 'subagent')}${unfinished ? `, ${unfinished} not marked finished` : ''}`),
      list.map((agent) =>
        el(
          'div',
          { class: 'subagent' },
          el('div', { class: 'subagent-type' }, agent.type),
          agent.description ? el('div', {}, agent.description) : null,
        ),
      ),
    ),
  );
}

function factsSection(card) {
  const rows = [
    ['Started', fullDate(card.firstAt)],
    ['Last active', fullDate(card.lastAt)],
    ['Your messages', card.promptCount ? String(card.promptCount) : null],
    ['Branch', card.branch],
    ['Folder', card.cwdFirst],
    ['Last worked in', card.cwdLast !== card.cwdFirst ? card.cwdLast : null],
    ['Session', card.id],
  ].filter(([, value]) => value);
  return section(
    'Details',
    el(
      'dl',
      { class: 'facts' },
      rows.flatMap(([label, value]) => [
        el('dt', {}, label),
        el('dd', { class: ['Session', 'Folder', 'Last worked in', 'Branch'].includes(label) ? 'mono' : '' }, value),
      ]),
    ),
  );
}

function removeCard(id) {
  closeDrawer();
  act(api('DELETE', `cards/${encodeURIComponent(id)}`));
}

// Forms

function openForm({ title, fields, submitLabel, onSubmit }) {
  const dialog = $('form-dialog');
  const controls = fields.map((field) => {
    const props = { name: field.name, required: field.required, value: field.value ?? '', placeholder: field.placeholder, maxLength: field.maxLength };
    let control;
    if (field.type === 'textarea') control = el('textarea', { ...props, rows: 3 });
    else if (field.type === 'select') {
      control = el(
        'select',
        { name: field.name },
        field.options.map((o) => el('option', { value: o.value, selected: o.value === field.value }, o.label)),
      );
    } else control = el('input', props);
    return el('label', { class: 'field' }, el('span', {}, field.label), control, field.hint ? el('small', {}, field.hint) : null);
  });
  const form = el(
    'form',
    {
      method: 'dialog',
      onsubmit: (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        dialog.close();
        onSubmit(data);
      },
    },
    el('h2', {}, title),
    controls,
    el(
      'div',
      { class: 'form-actions' },
      el('button', { class: 'secondary-button', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'primary-button', type: 'submit' }, submitLabel),
    ),
  );
  dialog.replaceChildren(form);
  dialog.showModal();
}

function ideaForm(columnId) {
  const { folders, columns } = view.board;
  if (!folders.length) {
    newProjectForm();
    return;
  }
  const fields = [
    { name: 'title', label: 'Idea', required: true, maxLength: 200, placeholder: 'What do you want to build?' },
    { name: 'note', label: 'Note', type: 'textarea' },
  ];
  if (!view.folder) {
    fields.push({ name: 'folder', label: 'Project', type: 'select', value: folders[0].key, options: folders.map((f) => ({ value: f.key, label: f.name })) });
  }
  openForm({
    title: `Add idea to ${columns.find((c) => c.id === columnId)?.name ?? 'stage'}`,
    fields,
    submitLabel: 'Add idea',
    onSubmit: (data) => act(api('POST', 'ideas', { folder: view.folder, ...data, column: columnId })),
  });
}

function newProjectForm() {
  openForm({
    title: 'New project',
    fields: [
      { name: 'name', label: 'Name', required: true, maxLength: 100 },
      {
        name: 'path',
        label: 'Folder (optional)',
        placeholder: '/Users/you/Side Projects/idea',
        hint: 'Chats you later start in this folder appear in this project automatically.',
      },
    ],
    submitLabel: 'Create project',
    onSubmit: async (data) => {
      try {
        const { key } = await api('POST', 'folders', data);
        await refresh();
        selectFolder(key);
      } catch (err) {
        toast(err.message);
      }
    },
  });
}

function renameFolderForm(folder) {
  openForm({
    title: 'Rename folder',
    fields: [{ name: 'name', label: 'Name', value: folder.name, maxLength: 100, hint: 'This only changes the name in the tracker. Leave blank to use the folder’s own name.' }],
    submitLabel: 'Rename',
    onSubmit: (data) => act(api('PATCH', 'folders', { key: folder.key, name: data.name })),
  });
}

function deleteColumnForm(column) {
  const others = view.board.columns.filter((c) => c.id !== column.id);
  const count = view.board.cards.filter((c) => c.column === column.id).length;
  openForm({
    title: `Delete “${column.name}”`,
    fields: [
      {
        name: 'moveTo',
        label: count ? `Move its ${plural(count, 'card')} to` : 'It has no cards. New stage for any that arrive:',
        type: 'select',
        value: others[0].id,
        options: others.map((c) => ({ value: c.id, label: c.name })),
      },
    ],
    submitLabel: 'Delete stage',
    onSubmit: (data) => act(api('DELETE', `columns/${column.id}`, { moveTo: data.moveTo })),
  });
}

// Data flow

async function refresh() {
  const data = await api('GET', 'board');
  const json = JSON.stringify(data);
  if (json === view.boardJson && !view.query) return;
  if (isInteracting()) return; // Picked up by the next poll.
  view.boardJson = json;
  view.board = data;
  if (view.folder && !folderByKey(view.folder)) view.folder = null;
  if (view.query) await runSearch();
  render();
}

async function runSearch() {
  const query = view.query;
  const { results } = await api('GET', `search?q=${encodeURIComponent(query)}`);
  if (query !== view.query) return; // A newer search has started.
  view.matches = new Map(results.map((r) => [r.id, r.snippet]));
}

let searchTimer;
function onSearchInput(value) {
  const wasSearching = Boolean(view.query);
  view.query = value.trim();
  clearTimeout(searchTimer);
  if (!view.query) {
    view.matches = null;
    selectFolder(wasSearching ? view.folderBeforeSearch : view.folder);
    return;
  }
  if (!wasSearching) {
    view.folderBeforeSearch = view.folder;
    view.folder = null; // Search looks everywhere; clicking a folder then narrows it.
  }
  searchTimer = setTimeout(async () => {
    try {
      await runSearch();
      render();
    } catch (err) {
      toast(err.message);
    }
  }, SEARCH_DEBOUNCE_MS);
}

// Global events

$('search').addEventListener('input', (e) => onSearchInput(e.target.value));
$('new-project').addEventListener('click', newProjectForm);

document.addEventListener('keydown', (event) => {
  const typing = event.target.closest?.('input, textarea, select');
  if ((event.key === '/' && !typing) || (event.key === 'k' && event.metaKey)) {
    event.preventDefault();
    $('search').focus();
    $('search').select();
    return;
  }
  if (event.key !== 'Escape' || $('form-dialog').open) return;
  if (view.openCardId) closeDrawer();
  else if (view.selected.size) clearSelection();
  else if (event.target === $('search') || view.query) {
    $('search').value = '';
    onSearchInput('');
    $('search').blur();
  }
});

document.addEventListener('click', (event) => {
  for (const menu of document.querySelectorAll('details.menu[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

window.addEventListener('hashchange', () => selectFolder(readHashFolder()));

refresh().catch((err) => toast(err.message));
setInterval(() => refresh().catch(() => toast('Lost connection to the tracker server')), POLL_MS);
