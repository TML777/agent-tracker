import { api, el, formatTokens, plural } from './shared.js';

const POLL_MS = 8000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CALENDAR_MODES = [
  ['weeks', 'Last 5 weeks'],
  ['month', 'By month'],
];
const STAT_RANGES = [
  ['3d', 'Last 3 days'],
  ['7d', 'Last week'],
  ['5w', 'Last 5 weeks'],
  ['all', 'All time'],
];

const $ = (id) => document.getElementById(id);
const view = { data: null, json: '', controlsKey: '', rangeKey: '', selected: null, mode: 'weeks', month: null, range: '5w' };

// Dates are plain YYYY-MM-DD strings. Parsing the parts keeps them in the local time zone.
function toDate(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function longDate(key) {
  return toDate(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function shortDate(key) {
  return toDate(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function allDays() {
  return view.data.weeks.flatMap((week) => week.days);
}

// The clicked day if it's on screen, else today, else the latest day of the month shown.
function selectedDay() {
  const days = allDays().filter((day) => !day.outside && !day.isFuture);
  return days.find((day) => day.date === view.selected) ?? days.find((day) => day.isToday) ?? days.at(-1);
}

function segmented(label, options, current, onPick) {
  return el(
    'div',
    { class: 'segmented', role: 'group', ariaLabel: label },
    options.map(([value, text]) =>
      el('button', { type: 'button', ariaPressed: value === current ? 'true' : 'false', onclick: () => onPick(value) }, text),
    ),
  );
}

function setMonth(key) {
  view.month = key;
  load();
}

function monthOption(month) {
  return `${month.label}${month.tokens ? ` (${formatTokens(month.tokens)})` : ''}`;
}

function monthPicker() {
  const { months, month } = view.data;
  const index = months.findIndex((m) => m.key === month);
  // Newest first, so the older month is the next one in the list.
  const step = (label, symbol, target) =>
    el('button', { class: 'month-step', type: 'button', ariaLabel: label, title: label, disabled: !target, onclick: () => setMonth(target.key) }, symbol);
  return el(
    'div',
    { class: 'month-picker' },
    step('Previous month', '‹', months[index + 1]),
    el(
      'select',
      { ariaLabel: 'Month', onchange: (e) => setMonth(e.target.value) },
      months.map((m) => el('option', { value: m.key, selected: m.key === month }, monthOption(m))),
    ),
    step('Next month', '›', months[index - 1]),
  );
}

function renderHeader() {
  const { mode, monthLabel, months } = view.data;
  const days = allDays().filter((day) => !day.outside);
  const total = days.reduce((sum, day) => sum + day.tokens, 0);
  const title = mode === 'month' ? monthLabel : 'Last 5 weeks';
  const range = mode === 'month' ? '' : `${shortDate(days[0].date)} to ${shortDate(days.at(-1).date)} · `;
  $('calendar-title').textContent = title;
  $('calendar-range').textContent = `${range}${formatTokens(total)} tokens`;

  // Rebuilt only when its content changes, so a refresh can't close an open dropdown.
  const key = JSON.stringify([mode, view.data.month, months.map((m) => m.key)]);
  if (key === view.controlsKey) {
    // Token counts change while chats run, and can update without touching the dropdown.
    $('calendar-controls').querySelectorAll('option').forEach((option, i) => (option.textContent = monthOption(months[i])));
    return;
  }
  view.controlsKey = key;
  $('calendar-controls').replaceChildren(
    ...[
      segmented('Calendar view', CALENDAR_MODES, mode, (value) => {
        view.mode = value;
        load();
      }),
      mode === 'month' ? monthPicker() : null,
    ].filter(Boolean),
  );
}

function renderDay(day, selected) {
  const usage = day.tokens ? `${formatTokens(day.tokens)} tokens` : 'no usage';
  const inactive = day.isFuture || day.outside;
  return el(
    'button',
    {
      class: `day heat-${day.level} ${day.isFuture ? 'future' : ''} ${day.outside ? 'outside' : ''} ${day.isToday ? 'today' : ''} ${selected ? 'selected' : ''}`,
      type: 'button',
      disabled: inactive,
      dataset: { date: day.date },
      ariaPressed: selected ? 'true' : 'false',
      ariaLabel: `${longDate(day.date)}${day.isToday ? ', today' : ''}, ${day.isFuture ? 'in the future' : day.outside ? 'in another month' : usage}`,
      onclick: () => {
        view.selected = day.date;
        renderGrid();
        renderDayPanel();
      },
    },
    el('span', { class: 'day-number' }, day.month ? `${day.month} ${day.dayOfMonth}` : String(day.dayOfMonth)),
    day.tokens ? el('span', { class: 'day-tokens' }, formatTokens(day.tokens)) : null,
  );
}

function renderGrid() {
  const selected = selectedDay();
  const scroll = $('calendar-grid').scrollLeft;
  const focused = document.activeElement?.dataset?.date;
  $('calendar-grid').replaceChildren(
    el(
      'div',
      { class: 'calendar-grid' },
      WEEKDAYS.map((name) => el('div', { class: 'weekday' }, name)),
      el('div', { class: 'weekday week-total' }, 'Week'),
      view.data.weeks.flatMap((week) => [
        ...week.days.map((day) => renderDay(day, day.date === selected?.date)),
        el('div', { class: 'week-total', title: `${week.tokens.toLocaleString()} tokens this week` }, week.tokens ? formatTokens(week.tokens) : ''),
      ]),
    ),
  );
  $('calendar-grid').scrollLeft = scroll;
  if (focused) $('calendar-grid').querySelector(`[data-date="${focused}"]`)?.focus({ preventScroll: true });
}

function stat(label, value, detail) {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value' }, value),
    detail ? el('div', { class: 'stat-detail' }, detail) : null,
  );
}

function barList(title, rows) {
  if (!rows.length) return null;
  const top = rows[0].tokens || 1;
  return el(
    'section',
    { class: 'stats-section' },
    el('h2', {}, title),
    rows.map((row) => {
      const fill = el('div', { class: 'bar-fill' });
      fill.style.width = `${Math.max(2, Math.round((row.tokens / top) * 100))}%`;
      return el(
        'div',
        { class: 'bar-row' },
        el('div', { class: 'bar-text' }, el('span', { class: 'bar-label', title: row.label }, row.label), el('span', { class: 'bar-value' }, formatTokens(row.tokens))),
        el('div', { class: 'bar-track' }, fill),
      );
    }),
  );
}

// Rebuilt only when the choice changes, so a refresh can't interrupt a click or drop focus.
function renderRangeSwitch() {
  const { range } = view.data.stats;
  if (range === view.rangeKey) return;
  view.rangeKey = range;
  $('stats-range').replaceChildren(
    segmented('Statistics range', STAT_RANGES, range, (value) => {
      view.range = value;
      load();
    }),
  );
}

function renderStats() {
  const { stats } = view.data;
  const { busiest } = stats;
  const summary = $('calendar-summary');
  const scroll = summary.scrollTop;
  summary.replaceChildren(
    ...[
      el('div', { class: 'stats-period' }, `${shortDate(stats.from)} to ${shortDate(stats.to)}`),
      el(
        'section',
        { class: 'stats-grid' },
        stat('Total tokens', formatTokens(stats.tokens), stats.tokens.toLocaleString()),
        stat('Active days', String(stats.activeDays), `of ${plural(stats.elapsedDays, 'day')}`),
        stat('Per active day', formatTokens(stats.perActiveDay)),
        stat('Busiest day', busiest ? formatTokens(busiest.tokens) : 'None', busiest ? shortDate(busiest.date) : null),
        stat('Chats', String(stats.chats)),
        stat('API calls', stats.calls.toLocaleString()),
      ),
      barList('Top folders', stats.folders),
      barList('By account', stats.accounts),
      el('p', { class: 'stats-note' }, `Tokens are input, output and cache writes, including subagents. Cache reads aren't in these totals: ${formatTokens(stats.cacheRead)} over this period.`),
    ].filter(Boolean),
  );
  summary.scrollTop = scroll;
}

function renderDayPanel() {
  const day = selectedDay();
  const panel = $('calendar-day');
  if (!day) {
    panel.replaceChildren();
    return;
  }
  const others = day.chatCount - day.chats.length;
  panel.replaceChildren(
    ...[
      el('h2', {}, `${longDate(day.date)}${day.isToday ? ' (today)' : ''}`),
      el('div', { class: 'day-panel-value' }, day.tokens ? `${formatTokens(day.tokens)} tokens` : 'No usage'),
      day.tokens ? el('div', { class: 'stat-detail' }, `${plural(day.chatCount, 'chat')}, ${plural(day.calls, 'API call')}`) : null,
      day.chats.length
        ? el(
            'ol',
            { class: 'day-chats' },
            day.chats.map((chat) =>
              el('li', {}, el('span', { class: 'bar-label', title: chat.title }, chat.title), el('span', { class: 'bar-value' }, formatTokens(chat.tokens))),
            ),
          )
        : null,
      others > 0 ? el('div', { class: 'stat-detail' }, `and ${plural(others, 'more chat')}`) : null,
    ].filter(Boolean),
  );
}

function render() {
  renderHeader();
  renderGrid();
  renderRangeSwitch();
  renderStats();
  renderDayPanel();
}

// A redraw between pressing and releasing the mouse would swallow the click.
let pressing = false;
document.addEventListener('pointerdown', () => (pressing = true));
document.addEventListener('pointerup', () => (pressing = false));
document.addEventListener('pointercancel', () => (pressing = false));

// Only the latest request may draw, so a slow reply can't undo a newer choice.
let latestRequest = 0;

async function load() {
  const request = ++latestRequest;
  const query = new URLSearchParams({ mode: view.mode, range: view.range });
  if (view.month) query.set('month', view.month);
  const data = await api('GET', `calendar?${query}`);
  if (request !== latestRequest || pressing) return; // The next refresh draws it instead.
  const json = JSON.stringify(data);
  if (json === view.json) return;
  view.json = json;
  view.data = data;
  render();
}

// The calendar only refreshes while its tab is showing.
let timer = null;

export function startCalendar() {
  if (timer) return;
  load().catch(() => {});
  timer = setInterval(() => load().catch(() => {}), POLL_MS);
}

export function stopCalendar() {
  clearInterval(timer);
  timer = null;
}
