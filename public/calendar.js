import { api, el, formatTokens, plural } from './shared.js';

const POLL_MS = 8000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const $ = (id) => document.getElementById(id);
const view = { data: null, json: '', selected: null };

// Dates are plain YYYY-MM-DD strings. Parsing the parts keeps them in the local time zone.
function toDate(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function longDate(key) {
  return toDate(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function shortDate(key) {
  return toDate(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function allDays() {
  return view.data.weeks.flatMap((week) => week.days);
}

function selectedDay() {
  return allDays().find((day) => day.date === view.selected) ?? allDays().find((day) => day.isToday);
}

function renderHeader() {
  const days = allDays();
  $('calendar-header').replaceChildren(
    el('h1', {}, 'Last 5 weeks'),
    el('span', { class: 'calendar-range' }, `${shortDate(days[0].date)} to ${shortDate(days.at(-1).date)}`),
  );
}

function renderDay(day, selected) {
  const usage = day.tokens ? `${formatTokens(day.tokens)} tokens` : 'no usage';
  return el(
    'button',
    {
      class: `day heat-${day.level} ${day.isFuture ? 'future' : ''} ${day.isToday ? 'today' : ''} ${selected ? 'selected' : ''}`,
      type: 'button',
      disabled: day.isFuture,
      ariaPressed: selected ? 'true' : 'false',
      ariaLabel: `${longDate(day.date)}${day.isToday ? ', today' : ''}, ${day.isFuture ? 'in the future' : usage}`,
      onclick: () => {
        view.selected = day.date;
        render();
      },
    },
    el('span', { class: 'day-number' }, day.month ? `${day.month} ${day.dayOfMonth}` : String(day.dayOfMonth)),
    day.tokens ? el('span', { class: 'day-tokens' }, formatTokens(day.tokens)) : null,
  );
}

function renderGrid() {
  const selected = selectedDay();
  const scroll = $('calendar-grid').scrollLeft;
  $('calendar-grid').replaceChildren(
    el(
      'div',
      { class: 'calendar-grid' },
      WEEKDAYS.map((name) => el('div', { class: 'weekday' }, name)),
      el('div', { class: 'weekday week-total' }, 'Week'),
      view.data.weeks.flatMap((week) => [
        ...week.days.map((day) => renderDay(day, day.date === selected.date)),
        el('div', { class: 'week-total', title: `${week.tokens.toLocaleString()} tokens this week` }, formatTokens(week.tokens)),
      ]),
    ),
  );
  $('calendar-grid').scrollLeft = scroll;
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

function renderSelectedDay(day) {
  const others = day.chatCount - day.chats.length;
  return el(
    'section',
    { class: 'stats-section day-panel' },
    el('h2', {}, `${longDate(day.date)}${day.isToday ? ' (today)' : ''}`),
    el('div', { class: 'day-panel-value' }, day.tokens ? `${formatTokens(day.tokens)} tokens` : 'No usage'),
    day.tokens
      ? el('div', { class: 'stat-detail' }, `${plural(day.chatCount, 'chat')}, ${plural(day.calls, 'API call')}`)
      : null,
    day.chats.length
      ? el(
          'ol',
          { class: 'day-chats' },
          day.chats.map((chat) =>
            el(
              'li',
              {},
              el('span', { class: 'bar-label', title: chat.title }, chat.title),
              el('span', { class: 'bar-value' }, formatTokens(chat.tokens)),
            ),
          ),
        )
      : null,
    others > 0 ? el('div', { class: 'stat-detail' }, `and ${plural(others, 'more chat')}`) : null,
  );
}

function renderStats() {
  const { stats } = view.data;
  const busiest = stats.busiest;
  $('calendar-stats').replaceChildren(
    ...[
      el(
        'section',
        { class: 'stats-grid' },
        stat('Total tokens', formatTokens(stats.tokens), `${stats.tokens.toLocaleString()}`),
        stat('Active days', String(stats.activeDays), `of ${stats.elapsedDays} so far`),
        stat('Per active day', formatTokens(stats.perActiveDay)),
        stat('Busiest day', busiest ? formatTokens(busiest.tokens) : 'None', busiest ? shortDate(busiest.date) : null),
        stat('Chats', String(stats.chats)),
        stat('API calls', stats.calls.toLocaleString()),
      ),
      renderSelectedDay(selectedDay()),
      barList('Top folders', stats.folders),
      barList('By account', stats.accounts),
      el('p', { class: 'stats-note' }, `Tokens are input, output and cache writes, including subagents. Cache reads aren't in these totals: ${formatTokens(stats.cacheRead)} over this period.`),
    ].filter(Boolean),
  );
}

function render() {
  renderHeader();
  renderGrid();
  renderStats();
}

async function refresh() {
  const data = await api('GET', 'calendar');
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
  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), POLL_MS);
}

export function stopCalendar() {
  clearInterval(timer);
  timer = null;
}
