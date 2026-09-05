/**
 * browse — an interactive terminal browser over the memory.
 *
 * Search costs 0.027 ms. That is the number this whole file exists to
 * spend: it re-runs the real ranked search on **every keystroke**, so
 * results move while you type instead of after you press Enter. Nothing
 * else in cheap-mem can use that speed — the HTML viewer is a snapshot,
 * `mem find` is one shot — and a sub-millisecond search that a human
 * never feels is a number on a benchmark, not a feature.
 *
 * Zero dependencies, on purpose: this package now installs as one
 * package and 588 kB, and a TUI library would undo that for a screen
 * drawn with four escape codes.
 *
 * Everything that decides anything is a pure function — `render()` turns
 * state into lines, `reduce()` turns a keypress into new state. The only
 * impure part is the loop at the bottom that reads keys and writes
 * lines, which is the part that cannot be tested and is therefore kept
 * as small as it can be.
 */

import * as search from './search.mjs';

// --- Terminal escapes (all of them) -------------------------------------
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';
const DIM = '\x1b[2m';
const REV = '\x1b[7m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

export const KEYS = Object.freeze({
  UP: '\x1b[A', DOWN: '\x1b[B', RIGHT: '\x1b[C', LEFT: '\x1b[D',
  PGUP: '\x1b[5~', PGDN: '\x1b[6~',
  ENTER: '\r', ENTER2: '\n', BACKSPACE: '\x7f', BACKSPACE2: '\b',
  ESC: '\x1b', CTRL_C: '\x03', CTRL_D: '\x04', CTRL_U: '\x15', TAB: '\t',
});

/** The drawers you can cycle through with Tab. null = everything. */
export const TYPE_FILTERS = Object.freeze([
  null, 'decision', 'error', 'event', 'learning', 'duty', 'thought',
]);

/** Cut to width without ever emitting a half-truncated escape sequence. */
export function fit(s, width) {
  const flat = String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\x1b\[[0-9;]*m/g, '');
  if (width <= 0) return '';
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

/** One line per hit: type, date, and whatever the entry actually says. */
export function hitLine(hit) {
  const e = hit.entry ?? {};
  const when = (e.ts ?? '').slice(0, 10) || '----------';
  const parts = [];
  if (e.class) parts.push(`[${e.class}]`);
  if (e.title) parts.push(e.title);
  if (e.choice) parts.push(`→ ${e.choice}`);
  if (!e.title && e.text) parts.push(String(e.text));
  if (!e.title && !e.text && e.fact) parts.push(String(e.fact));
  const what = parts.join(' ') || '(no title)';
  return { type: (hit.type ?? '?').padEnd(9).slice(0, 9), when, what };
}

/** The full entry, as the lines the detail pane shows. */
export function detailLines(hit, width) {
  if (!hit) return ['(nothing selected)'];
  const e = hit.entry ?? {};
  const out = [`${hit.type}  ${e.id ?? '(no id)'}  ${e.ts ?? ''}`, ''];
  const skip = new Set(['id', 'ts', 'type']);
  for (const [k, v] of Object.entries(e)) {
    if (skip.has(k) || v === null || v === undefined || v === '') continue;
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const label = `${k}:`.padEnd(14);
    // Wrap on words so a long `why` stays readable instead of being cut.
    const room = Math.max(20, width - label.length);
    const words = text.split(/\s+/);
    let line = '';
    const wrapped = [];
    for (const w of words) {
      if (line && (line.length + 1 + w.length) > room) { wrapped.push(line); line = w; }
      else line = line ? `${line} ${w}` : w;
    }
    if (line) wrapped.push(line);
    out.push(`${label}${wrapped[0] ?? ''}`);
    for (const rest of wrapped.slice(1)) out.push(`${' '.repeat(label.length)}${rest}`);
  }
  out.push('', `${hit.source}:${hit.line}`);
  return out;
}

/**
 * State -> the exact lines to print. Pure: no terminal, no clock, no
 * search. That is what makes the layout testable at all.
 */
export function render(state, { rows, cols }) {
  const { query, hits, selected, mode, typeFilter, total, ms } = state;
  const lines = [];
  const filterTag = typeFilter ? ` ${DIM}[${typeFilter}]${OFF}` : '';
  lines.push(`${BOLD}search${OFF} ${query}${DIM}▏${OFF}${filterTag}`);
  const count = hits.length === 0 && query
    ? `nothing for "${fit(query, 30)}"`
    : `${hits.length} of ${total} entries · ${ms} ms`;
  lines.push(`${DIM}${fit(count, cols)}${OFF}`);
  lines.push('');

  if (mode === 'detail') {
    for (const l of detailLines(hits[selected], cols)) lines.push(fit(l, cols));
  } else {
    // Scroll so the selection stays on screen without jumping around.
    const body = Math.max(1, rows - 5);
    const first = Math.max(0, Math.min(selected - Math.floor(body / 2), hits.length - body));
    const window = hits.slice(Math.max(0, first), Math.max(0, first) + body);
    for (let i = 0; i < window.length; i += 1) {
      const idx = Math.max(0, first) + i;
      const h = hitLine(window[i]);
      const text = fit(`${h.when}  ${h.type}  ${h.what}`, cols - 2);
      lines.push(idx === selected ? `${REV}> ${text}${OFF}` : `  ${text}`);
    }
  }

  while (lines.length < rows - 1) lines.push('');
  const help = mode === 'detail'
    ? 'esc back · ↑↓ move · ctrl-c quit'
    : 'type to search · ↑↓ move · enter open · tab filter · ctrl-u clear · ctrl-c quit';
  lines.push(`${DIM}${fit(help, cols)}${OFF}`);
  return lines.slice(0, rows);
}

/**
 * A keypress -> the next state. Pure, and it never searches: it returns
 * `dirty: true` when the query or filter changed, and the caller decides
 * to run the search. Keeping IO out of here is what lets the key handling
 * be tested without a terminal.
 */
export function reduce(state, key) {
  const s = { ...state, dirty: false };
  const last = Math.max(0, s.hits.length - 1);

  if (key === KEYS.CTRL_C || key === KEYS.CTRL_D) return { ...s, quit: true };

  if (s.mode === 'detail') {
    if (key === KEYS.ESC || key === 'q') return { ...s, mode: 'list' };
    if (key === KEYS.UP) return { ...s, selected: Math.max(0, s.selected - 1) };
    if (key === KEYS.DOWN) return { ...s, selected: Math.min(last, s.selected + 1) };
    return s;
  }

  if (key === KEYS.ESC) return { ...s, quit: true };
  if (key === KEYS.UP) return { ...s, selected: Math.max(0, s.selected - 1) };
  if (key === KEYS.DOWN) return { ...s, selected: Math.min(last, s.selected + 1) };
  if (key === KEYS.PGUP) return { ...s, selected: Math.max(0, s.selected - 10) };
  if (key === KEYS.PGDN) return { ...s, selected: Math.min(last, s.selected + 10) };
  if (key === KEYS.ENTER || key === KEYS.ENTER2) {
    return s.hits.length ? { ...s, mode: 'detail' } : s;
  }
  if (key === KEYS.TAB) {
    const i = TYPE_FILTERS.indexOf(s.typeFilter);
    return { ...s, typeFilter: TYPE_FILTERS[(i + 1) % TYPE_FILTERS.length], selected: 0, dirty: true };
  }
  if (key === KEYS.CTRL_U) {
    return s.query === '' ? s : { ...s, query: '', selected: 0, dirty: true };
  }
  if (key === KEYS.BACKSPACE || key === KEYS.BACKSPACE2) {
    // Backspace on an empty query is not an error and not a quit — it is
    // the most common accidental key in an empty box.
    return s.query === '' ? s : { ...s, query: s.query.slice(0, -1), selected: 0, dirty: true };
  }
  // Printable single characters only. An unhandled escape sequence must
  // never end up typed into the query as literal `[A` garbage.
  if (key.length === 1 && key >= ' ' && key !== '\x7f') {
    return { ...s, query: s.query + key, selected: 0, dirty: true };
  }
  return s;
}

export function initialState() {
  return {
    query: '', hits: [], selected: 0, mode: 'list',
    typeFilter: null, total: 0, ms: 0, dirty: false, quit: false,
  };
}

/** Run the search for the current state. The one place that is not pure. */
export function refresh(state, index, { top = 200 } = {}) {
  if (!state.query.trim()) {
    return { ...state, hits: [], total: index.N, ms: 0, selected: 0 };
  }
  const t0 = Date.now();
  const hits = search.search(index, state.query, {
    top, type: state.typeFilter, minScore: 0.01,
  });
  return {
    ...state,
    hits,
    total: index.N,
    ms: Date.now() - t0,
    selected: Math.min(state.selected, Math.max(0, hits.length - 1)),
  };
}

/**
 * The loop. Restoring the terminal is the whole risk here: raw mode, a
 * hidden cursor and the alternate screen all outlive the process if it
 * exits any way but the tidy one. So restore runs from a single place,
 * is idempotent, and is wired to every exit there is — normal return, an
 * exception, a signal.
 */
export async function run(index, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) {
    throw new Error('mem browse needs a terminal (stdin is not a TTY).\n'
      + '  Piping? Use `mem find "..."` — it prints and exits.');
  }
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { input.setRawMode(false); } catch { /* already gone */ }
    output.write(`${CURSOR_SHOW}${ALT_OFF}`);
    input.pause();
  };
  const onSignal = () => { restore(); process.exit(130); };
  let onResize = null;
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', restore);

  let state = refresh(initialState(), index);
  const draw = () => {
    const rows = output.rows || 24;
    const cols = output.columns || 80;
    output.write(HOME + CLEAR + render(state, { rows, cols }).join('\n'));
  };

  try {
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    output.write(`${ALT_ON}${CURSOR_HIDE}`);
    draw();
    onResize = draw;
    output.on('resize', onResize);

    await new Promise((resolve) => {
      input.on('data', (chunk) => {
        // A paste or a fast key repeat arrives as several keys in one
        // chunk. Splitting keeps escape sequences whole; feeding the raw
        // chunk would type "[A" into the query on a held arrow key.
        for (const key of splitKeys(String(chunk))) {
          state = reduce(state, key);
          if (state.quit) { resolve(); return; }
          if (state.dirty) state = refresh(state, index);
        }
        draw();
      });
      input.on('end', resolve);
    });
  } finally {
    // Every listener registered above comes off again. The `exit` one
    // matters most: left attached, a second run() would restore a
    // terminal it does not own, and a long-lived process leaks a
    // listener per call until Node warns about it.
    restore();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', restore);
    if (onResize) output.off('resize', onResize);
  }
  return state;
}

/** Split a raw chunk into keys, keeping CSI escape sequences intact. */
export function splitKeys(chunk) {
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b' && chunk[i + 1] === '[') {
      let j = i + 2;
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j += 1;
      keys.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else {
      keys.push(chunk[i]);
      i += 1;
    }
  }
  return keys;
}
