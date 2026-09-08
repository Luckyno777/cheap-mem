// board.mjs — the operating state at a glance.
//
// **Why this is needed even though there is a viewer.** The viewer shows
// ENTRIES: what was thought, decided, broken. It answers none of the
// questions that cost 2026-09-08:
//
//   - Is the MCP bridge still serving the code that is in the repo?
//     (One ran a whole day on yesterday's checkout. An outside agent
//     noticed, not us.)
//   - Is the raw capture where it is supposed to be?
//     (672 captures still sat in the repo while the report said
//     "44.72 MB in the archive".)
//   - Is one defect type piling up right now?
//     (`looks-right-does-nothing` was written seven times and had in
//     truth happened twenty-eight times, under fourteen names.)
//   - Is anyone still writing, or has a lane failed silently?
//   - Is this installation actually finished?
//
// **The rule this module carries: every tile says HOW OLD its answer is
// and whether it could be measured at all.** Three states, never two. A
// board that shows "all green" because it did not look is worse than no
// board — it is precisely the construction this project spends its time
// hunting.
//
// Hence `STATE.UNKNOWN`, and hence it does not colour green. A tile
// without a measurement is grey, not calm.

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as raw from './raw.mjs';
import * as archive from './archive.mjs';
import * as question from './question.mjs';
import * as heartbeat from './heartbeat.mjs';
import * as errorclass from './errorclass.mjs';
import * as setup from './setup.mjs';

export const STATE = Object.freeze({
  CALM: 'calm',         // measured, in order
  WATCH: 'watch',       // measured, wants someone soon
  ALARM: 'alarm',       // measured, is broken
  UNKNOWN: 'unknown',   // NOT measured — explicitly not calm
});

const RANK = { alarm: 0, watch: 1, unknown: 2, calm: 3 };

/** Minutes since an ISO timestamp, or null when unreadable. */
function ageMin(ts, now) {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 60000));
}

/** "3 h ago", "2 days ago" — short enough for a tile. */
export function since(min) {
  if (min == null) return 'never';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 48) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

/**
 * The archive: is the raw capture where it belongs?
 *
 * Three places kept apart, because the first version of this report
 * threw them together and reported completion where nothing had moved.
 */
export function tileArchive(root, { env = process.env } = {}) {
  let store;
  try { store = archive.readConfig(env, root); }
  catch (e) {
    return { id: 'archive', title: 'Raw archive', state: STATE.UNKNOWN,
      line: `location undeterminable: ${e.message}` };
  }

  const rows = archive.records(root);
  let inArchive = 0; let inRepo = 0; let foreign = 0; let missing = 0; let bytes = 0;
  for (const r of rows) {
    const where = archive.filePath(store, root, r.path);
    if (where) {
      if (where.startsWith(store.location)) { inArchive += 1; bytes += r.bytes ?? 0; }
      else inRepo += 1;
      continue;
    }
    // A record travels with the repo; the location it names may belong
    // to another machine. Only a record naming THIS archive and not
    // finding the file is a loss.
    if (String(r.location ?? '').includes(store.location)) missing += 1; else foreign += 1;
  }

  const parts = [`${inArchive} in the archive (${(bytes / 1048576).toFixed(1)} MB)`];
  if (inRepo) parts.push(`${inRepo} still in the repo`);
  if (foreign) parts.push(`${foreign} from other machines`);
  if (missing) parts.push(`${missing} MISSING`);
  if (!rows.length) parts.length = 0;

  const state = missing ? STATE.ALARM : inRepo ? STATE.WATCH : STATE.CALM;
  return {
    id: 'archive', title: 'Raw archive', state,
    line: parts.length ? parts.join(', ') : 'no captures recorded yet',
    detail: store.location,
    numbers: { inArchive, inRepo, foreign, missing, bytes },
  };
}

/**
 * The digest: how much raw material is waiting, and since when?
 *
 * A digest that stops firing fails silently — the raw capture keeps
 * growing and nobody notices until somebody looks at the size.
 */
export function tileDigest(root, { now = new Date() } = {}) {
  let s; let d;
  try { s = raw.pending(root); d = raw.due(root, { now }); }
  catch (e) {
    return { id: 'digest', title: 'Digest', state: STATE.UNKNOWN,
      line: `not measurable: ${e.message}` };
  }
  const min = ageMin(s.last, now);
  const mb = s.bytes / 1048576;

  // Waiting material with a stale last run is what deserves a look —
  // not the moment something is broken.
  const state = s.open.length === 0 ? STATE.CALM
    : (min == null || min > 60 * 48) ? STATE.WATCH : STATE.CALM;

  return {
    id: 'digest', title: 'Digest', state,
    line: `${s.open.length} captures open (${mb.toFixed(1)} MB), last run ${since(min)}`
      + ` — ${d.due ? `due: ${d.reason}` : `not due: ${d.reason}`}`,
    numbers: { open: s.open.length, bytes: s.bytes, lastMin: min, due: d.due, reason: d.reason },
  };
}

/**
 * Which error class is piling up right now?
 *
 * `windowDays` is deliberately a window and not a total: the total
 * barely moves and therefore says nothing about NOW.
 */
export function tileErrors(root, { now = new Date(), windowDays = 14 } = {}) {
  const all = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    try { all.push(...memory.readLog(root, 'error', { project }).entries); }
    catch { /* log absent */ }
  }
  if (!all.length) {
    return { id: 'errors', title: 'Error classes', state: STATE.UNKNOWN,
      line: 'no error entries readable' };
  }

  const edge = now.getTime() - windowDays * 86400000;
  const inWindow = all.filter((e) => Date.parse(e?.ts ?? '') >= edge);
  const c = errorclass.coverage(inWindow);
  const top = c.byClass[0];

  const line = top
    ? `${top[1]}x ${top[0]} (${windowDays} days)`
    : `nothing in the last ${windowDays} days`;
  // The open share belongs IN the tile: without it the ranking reads as
  // complete, and it is not.
  const tail = c.open ? `${c.mapped}/${c.total} countable` : `${c.total} countable`;

  return {
    id: 'errors', title: 'Error classes',
    state: (top?.[1] ?? 0) >= 5 ? STATE.WATCH : STATE.CALM,
    line: `${line} — ${tail}`,
    numbers: { window: windowDays, top: top ?? null, ...c },
  };
}

/**
 * Who is still writing?
 *
 * An agent with an old heartbeat is not necessarily broken — it may
 * have had nothing to do. Hence WATCH and not ALARM.
 */
export function tileAgents(root, { now = new Date(), quietMin = 60 * 24 } = {}) {
  let latest;
  try { latest = heartbeat.latest(root); }
  catch (e) {
    return { id: 'agents', title: 'Agents', state: STATE.UNKNOWN,
      line: `not measurable: ${e.message}` };
  }
  // `latest()` returns a MAP, not an object. The sibling implementation
  // read it with `Object.keys`, got an empty list and reported "no
  // heartbeat recorded" while the file held 239 bytes. An empty result
  // that looks like "nothing there" instead of "read wrongly" is exactly
  // the class this board exists to show — and it sat in the board's own
  // code.
  const rows = [...(latest instanceof Map ? latest : new Map()).entries()]
    .map(([agent, e]) => ({ agent, min: ageMin(e?.ts, now) }))
    .sort((a, b) => (a.min ?? 1e9) - (b.min ?? 1e9));
  if (!rows.length) {
    return { id: 'agents', title: 'Agents', state: STATE.UNKNOWN,
      line: 'no heartbeat recorded' };
  }
  const quiet = rows.filter((r) => r.min == null || r.min > quietMin);

  return {
    id: 'agents', title: 'Agents',
    state: quiet.length ? STATE.WATCH : STATE.CALM,
    line: rows.slice(0, 4).map((r) => `${r.agent} ${since(r.min)}`).join(', ')
      + (rows.length > 4 ? `, +${rows.length - 4}` : ''),
    numbers: { rows, quiet: quiet.length },
  };
}

/** What is open and belongs to nobody. */
export function tileQuestions(root) {
  let open;
  try { open = question.open(root); }
  catch (e) {
    return { id: 'questions', title: 'Open questions', state: STATE.UNKNOWN,
      line: `not measurable: ${e.message}` };
  }
  return {
    id: 'questions', title: 'Open questions', state: STATE.CALM,
    line: open.length
      ? `${open.length} open — ${String(open[0]?.question ?? '').slice(0, 60)}`
      : 'none open',
    numbers: { count: open.length },
  };
}

/**
 * Is the installation actually finished?
 *
 * Reuses `setup.check` rather than repeating its five probes. A second
 * implementation of the same question is the two-truths class waiting
 * to happen, and this file is not allowed to build one.
 */
export function tileSetup(root, { env = process.env, home } = {}) {
  let r;
  try { r = home === undefined ? setup.check(root, { env }) : setup.check(root, { env, home }); }
  catch (e) {
    return { id: 'setup', title: 'Installation', state: STATE.UNKNOWN,
      line: `not measurable: ${e.message}` };
  }
  const broken = r.steps.filter((s) => s.state === setup.STATE.BROKEN);
  const open = r.steps.filter((s) => s.state === setup.STATE.OPEN);
  const state = broken.length ? STATE.ALARM : open.length ? STATE.WATCH : STATE.CALM;
  const parts = [`${r.ok}/${r.steps.length} steps done`];
  if (broken.length) parts.push(`broken: ${broken.map((s) => s.id).join(', ')}`);
  if (open.length) parts.push(`open: ${open.map((s) => s.id).join(', ')}`);
  return {
    id: 'setup', title: 'Installation', state,
    line: parts.join(' — '),
    detail: broken[0]?.detail ?? open[0]?.fix ?? null,
    numbers: { ok: r.ok, open: r.open, broken: r.broken },
  };
}

/**
 * Where the reports live. Under `.mem/`, so gitignored — they are a
 * finding about THIS machine.
 *
 * **Appended, never overwritten.** The first draft rewrote a single
 * JSON file, and that broke the sibling project's rule that no bridge
 * tool may change or delete anything. The rule was right and the draft
 * was wrong. History falls out of it for free: since when has this
 * server been serving the same checkout, and how often has it restarted.
 */
export const REPORT_FILE = path.join('.mem', 'bridge-reports.jsonl');

/**
 * Report the checkout being served.
 *
 * **Here, not in bin/mem.** The command started life in the CLI only —
 * and the agents this is about come in over the BRIDGE and have no CLI.
 * A capability missing where the work happens is not a capability, and
 * it would have left the tile on `unknown` forever for exactly the
 * cases it was built for. Two callers, one function: otherwise the two
 * spellings of the record drift apart.
 */
export function report(root, version, { by = null } = {}) {
  const v = String(version ?? '').trim();
  if (!v) throw new Error('Nothing to report without a short hash.');
  const row = {
    version: v,
    seen_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    by: by ?? process.env.CHEAP_MEM_AGENT ?? 'unknown',
  };
  const file = path.join(root, REPORT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return { row, file };
}

/**
 * The newest report, or null.
 *
 * Broken lines are SKIPPED, not swallowed: one half-written line must
 * not make the tile say "never reported" while twenty good lines sit
 * above it.
 */
export function readReport(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, REPORT_FILE), 'utf8'); }
  catch { return null; }
  for (const line of text.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.seen_at) return row;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Is the bridge running the code that is in the repo?
 *
 * **The tile that cost 2026-09-08.** An MCP server ran a whole day on
 * yesterday's checkout: six entries were missing from its tool list, and
 * a lookup missed an id that was found here instantly. An outside agent
 * noticed, not us.
 *
 * From INSIDE this cannot be answered fully — this repo does not know
 * which process is running out there. So it states what is measurable
 * (the state here) and what is not (the state there). A tile that
 * inferred one from the other would be guessing.
 */
export function tileBridge(root) {
  const state = readReport(root);

  if (!state?.seen_at) {
    return {
      id: 'bridge', title: 'MCP bridge', state: STATE.UNKNOWN,
      line: 'no state reported — not measurable from here',
      detail: 'An agent reports it with: mem bridge report <short-hash>',
    };
  }
  return {
    id: 'bridge', title: 'MCP bridge', state: STATE.CALM,
    line: `serving version ${state.version ?? '?'}, reported ${since(ageMin(state.seen_at, new Date()))}`,
  };
}

/**
 * Every tile, always all of them.
 *
 * Sorted by urgency, not by order in the code: whoever looks at a board
 * should see the worst first. No tile is left out for being calm — a
 * board that drops quiet tiles loses exactly the information that
 * something was checked.
 */
export function board(root, opt = {}) {
  const tiles = [
    tileArchive(root, opt),
    tileDigest(root, opt),
    tileErrors(root, opt),
    tileAgents(root, opt),
    tileQuestions(root, opt),
    tileSetup(root, opt),
    tileBridge(root, opt),
  ];
  tiles.sort((a, b) => RANK[a.state] - RANK[b.state]);
  return {
    tiles,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    alarm: tiles.filter((t) => t.state === STATE.ALARM).length,
    watch: tiles.filter((t) => t.state === STATE.WATCH).length,
    unknown: tiles.filter((t) => t.state === STATE.UNKNOWN).length,
  };
}

const MARK = { alarm: '!!', watch: ' !', unknown: ' ?', calm: ' .' };

/**
 * For the terminal.
 *
 * Read on a phone over browser SSH: no colours, no boxes, one line per
 * tile and the mark up front.
 */
export function asText(b) {
  const out = [];
  for (const t of b.tiles) {
    out.push(`${MARK[t.state]} ${t.title.padEnd(16)} ${t.line}`);
    if (t.detail) out.push(`     ${t.detail}`);
  }
  out.push('');
  const sum = [];
  if (b.alarm) sum.push(`${b.alarm} alarm`);
  if (b.watch) sum.push(`${b.watch} watch`);
  if (b.unknown) sum.push(`${b.unknown} unmeasured`);
  out.push(sum.length ? sum.join(', ') : 'all calm');
  out.push(`As of ${b.at}`);
  return out.join('\n');
}

/** HTML special characters. Without this every tile is a way in. */
function h(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * For the browser.
 *
 * **One file, no dependencies, no script.** The board gets read on a
 * phone through a tunnel; everything that has to be fetched is one more
 * thing that can fail there — and a board that stays empty because a
 * script did not load reports calm.
 *
 * Colour carries nothing on its own: every tile also has a mark and a
 * word. A board that states its condition only through red and green is
 * not a board at all for some of its readers.
 */
export function asHtml(b) {
  const colour = {
    alarm: '#b3261e', watch: '#8a6100', unknown: '#5f6368', calm: '#1e6b3a',
  };
  const word = {
    alarm: 'Alarm', watch: 'Watch', unknown: 'unmeasured', calm: 'calm',
  };
  const tiles = b.tiles.map((t) => `
    <article class="t" style="--c:${colour[t.state]}">
      <header><span class="m">${h(MARK[t.state].trim() || '.')}</span>
        <h2>${h(t.title)}</h2><span class="w">${h(word[t.state])}</span></header>
      <p class="l">${h(t.line)}</p>
      ${t.detail ? `<p class="d">${h(t.detail)}</p>` : ''}
    </article>`).join('');

  const sum = [
    b.alarm ? `${b.alarm} alarm` : '',
    b.watch ? `${b.watch} watch` : '',
    b.unknown ? `${b.unknown} unmeasured` : '',
  ].filter(Boolean).join(' &middot; ') || 'all calm';

  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cheap-mem — board</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1b1b1b; --li:#d7d7d7; --sw:#5f6368; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#131315; --fg:#eceff1; --li:#33363b; --sw:#a8adb4; }
  }
  body { margin:0; padding:1rem; background:var(--bg); color:var(--fg);
         font:16px/1.5 system-ui,-apple-system,sans-serif; }
  h1 { font-size:1.1rem; margin:0 0 .25rem; }
  .at { color:var(--sw); font-size:.85rem; margin:0 0 1rem; }
  .t { border:1px solid var(--li); border-left:4px solid var(--c);
       border-radius:6px; padding:.6rem .8rem; margin:0 0 .6rem; }
  .t header { display:flex; align-items:baseline; gap:.5rem; }
  .t h2 { font-size:.95rem; margin:0; flex:1; }
  .m { color:var(--c); font-weight:700; }
  .w { color:var(--c); font-size:.75rem; text-transform:uppercase;
       letter-spacing:.04em; }
  .l { margin:.35rem 0 0; }
  .d { margin:.2rem 0 0; color:var(--sw); font-size:.85rem;
       word-break:break-all; }
</style>
<h1>cheap-mem — operating state</h1>
<p class="at">${sum} &middot; as of ${h(b.at)}</p>
${tiles}
</html>
`;
}
