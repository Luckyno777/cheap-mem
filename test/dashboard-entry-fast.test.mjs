// test/dashboard-entry-fast.test.mjs — `/entry.json` resolves one id
// directly, never through `dashboard.collect()`'s pass over every
// drawer of every project (Bauplan D1). Mirrors lucky-mem's
// `test/eintrag-schnell.test.mjs` (its commit 6f5280f0) for cheap-mem's
// own single-entry route; see the header comment on `dashboard.
// getEntryFast()` in `src/dashboard.mjs` for the full contract this
// file checks, including the one search it deliberately skips.
//
// Six probes, in the order the assignment names them:
//   (1) the route never calls `dashboard.collect()`
//   (2) file opens per lookup do not grow with the corpus (two sizes)
//   (3) content matches what `dashboard.collect()` shows for that id
//   (4) an unknown id answers 404/'unknown'
//   (5) a broken line answers 'error'/'warning', never a silent miss
//   (6) the same auth guard as every other route applies
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as dashboard from '../src/dashboard.mjs';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-entryfast-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'entryfast', participants: ['someone'], language: 'en' }));
  return r;
}

/**
 * A small memory: one leaf (no edges, for the exact positive control),
 * a linked pair through the `link` drawer (a declared edge plus a
 * `contradicts` edge, so the display and standing fields both get
 * exercised), and `fill` unrelated filler entries in OTHER drawers —
 * probe (2) needs those to NOT change how many files a single lookup
 * opens.
 */
function build({ fill = 0 } = {}) {
  const r = world();
  const leaf = memory.logEntry(r, 'event', { title: 'leaf', text: 'no edges at all' }).entry;
  const source = memory.logEntry(r, 'error', { title: 'crack', text: 'the cause' }).entry;
  const target = memory.logEntry(r, 'error', { title: 'break', text: 'the effect' }).entry;
  const disputer = memory.logEntry(r, 'event', { title: 'countercheck', text: 'disputes it' }).entry;
  memory.logEntry(r, 'link', { from: source.id, to: target.id, kind: 'causes', why: 'measured' });
  memory.logEntry(r, 'link', { from: disputer.id, to: target.id, kind: 'contradicts', why: 'disputed' });
  for (let i = 0; i < fill; i += 1) {
    memory.logEntry(r, 'thought', { text: `filler thought ${i}, touches nothing above` });
    memory.logEntry(r, 'decision', { choice: 'filler', why: `filler decision ${i}` });
  }
  return { r, leaf, source, target, disputer };
}

function gone(r) { fs.rmSync(r, { recursive: true, force: true }); }

// --- (1) the route never calls dashboard.collect() --------------------

test('(1) the /entry.json branch in bin/mem-serve does not call dashboard.collect()', () => {
  const src = fs.readFileSync(SERVE, 'utf8');
  const start = src.indexOf("url.pathname === '/entry.json'");
  assert.ok(start >= 0, "bin/mem-serve has no '/entry.json' branch");
  const nextBlock = src.indexOf("// --- The desk", start);
  assert.ok(nextBlock > start, 'could not find the end of the /entry.json branch');
  const branch = src.slice(start, nextBlock)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  assert.ok(!branch.includes('dashboard.collect('),
    'the /entry.json branch still calls dashboard.collect() — Bauplan D1 not met');
  assert.ok(branch.includes('getEntryFast('),
    'the /entry.json branch does not use dashboard.getEntryFast()');
});

test('(1b) getEntryFast() itself answers ok for a real id', () => {
  const { r, leaf } = build();
  try {
    const found = dashboard.getEntryFast(r, leaf.id);
    assert.equal(found.state, 'ok');
    assert.equal(found.entry.id, leaf.id);
  } finally { gone(r); }
});

// --- (2) file opens per lookup do not grow with the corpus -------------

function countOpens(fn) {
  const openBefore = fs.openSync;
  const readBefore = fs.readFileSync;
  let n = 0;
  fs.openSync = (...a) => { n += 1; return openBefore(...a); };
  fs.readFileSync = (...a) => { n += 1; return readBefore(...a); };
  try { fn(); } finally { fs.openSync = openBefore; fs.readFileSync = readBefore; }
  return n;
}

test('(2) file opens per lookup do not grow with the corpus (20 vs. 4000 filler lines)', () => {
  const small = build({ fill: 20 });
  const big = build({ fill: 4000 });
  try {
    const nSmall = countOpens(() => dashboard.getEntryFast(small.r, small.leaf.id));
    const nBig = countOpens(() => dashboard.getEntryFast(big.r, big.leaf.id));
    assert.equal(nSmall, nBig,
      `file opens grow with the filler: small=${nSmall}, big=${nBig} — this is exactly what `
      + 'dashboard.collect() would do and getEntryFast() exists to avoid');
    assert.ok(nSmall <= 10, `too many file opens for one lookup: ${nSmall}`);
  } finally { gone(small.r); gone(big.r); }
});

// --- (3) positive control: content matches dashboard.collect() ---------

test('(3) POSITIVE CONTROL: a leaf entry matches dashboard.collect() exactly', () => {
  const { r, leaf } = build();
  try {
    const full = dashboard.collect(r, {});
    const fromFull = full.entries.find((e) => e.id === leaf.id);
    assert.ok(fromFull, 'dashboard.collect() itself does not have the fixture — fixture is broken');
    const fast = dashboard.getEntryFast(r, leaf.id);
    assert.equal(fast.state, 'ok');
    assert.deepEqual(fast.entry, fromFull,
      'the fast path disagrees with dashboard.collect() for an entry with no edges at all');
  } finally { gone(r); }
});

test('(3b) POSITIVE CONTROL: a linked, contested and superseded entry matches too', () => {
  const { r, source, target, disputer } = build();
  const corrected = memory.correctionEntry(r, 'error', target.id, { title: 'break v2', text: 'effect, corrected' });
  const full = dashboard.collect(r, {});
  try {
    for (const id of [source.id, target.id, disputer.id, corrected.entry.id]) {
      const fromFull = full.entries.find((e) => e.id === id);
      assert.ok(fromFull, `dashboard.collect() does not carry '${id}' — fixture is broken`);
      const fast = dashboard.getEntryFast(r, id);
      assert.equal(fast.state, 'ok', `id '${id}': state is '${fast.state}'`);
      assert.deepEqual(fast.entry, fromFull, `id '${id}': the fast path disagrees with dashboard.collect()`);
    }
    // The disagreement this probe exists to catch would show up here:
    // the superseded target's citation count is a real, non-trivial
    // check (it comes out zeroed for a REASON — see getEntryFast()'s
    // header comment — not because nothing links to it).
    const targetFast = dashboard.getEntryFast(r, target.id);
    assert.equal(targetFast.entry.retired.state, 'superseded');
    assert.equal(targetFast.entry.cited, 0);
  } finally { gone(r); }
});

// --- (4) unknown id ------------------------------------------------------

test('(4) an unknown id: state unknown at the function level', () => {
  const { r } = build();
  try {
    const found = dashboard.getEntryFast(r, 'doesnotexist0');
    assert.equal(found.state, 'unknown');
    assert.equal(found.entry, undefined);
  } finally { gone(r); }
});

test('(4b) an unknown id over HTTP: 404 with state unknown', async () => {
  const { r } = build();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/entry.json?id=doesnotexist0`, { headers: WITH_DOOR });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.state, 'unknown');
  } finally { await s.stop(); gone(r); }
});

// --- (5) a broken line is visible, never a silent not-found ------------

test('(5) a broken line seen while searching: state error, never a silent unknown', () => {
  const { r } = build();
  try {
    // A line that fails to parse, in a drawer the search visits before
    // it would give up on an id that is not actually there.
    fs.mkdirSync(path.join(r, 'global'), { recursive: true });
    fs.writeFileSync(path.join(r, 'global', 'skills.jsonl'), '{ this is not JSON\n');
    const found = dashboard.getEntryFast(r, 'doesnotexist0');
    assert.equal(found.state, 'error',
      `expected 'error' next to seen corruption, got '${found.state}' — a not-found is not `
      + 'established when a line the search visited could not be read');
    assert.ok(found.reason && found.reason.length > 0, 'no reason given');
  } finally { gone(r); }
});

test('(5b) a broken NEIGHBOUR line in the same drawer still returns the entry, but warns', () => {
  const { r, leaf } = build();
  try {
    fs.appendFileSync(path.join(r, 'global', 'events.jsonl'), '{ broken neighbour line\n');
    const found = dashboard.getEntryFast(r, leaf.id);
    assert.equal(found.state, 'warning');
    assert.ok(found.entry, 'the entry itself should still be there');
    assert.equal(found.entry.headline, 'leaf — no edges at all');
    assert.match(found.reason, /could not be read/);
  } finally { gone(r); }
});

test('(5c) over HTTP: state error is delivered as HTTP 500 with a reason', async () => {
  const { r } = build();
  const s = await start(r);
  try {
    fs.writeFileSync(path.join(r, 'global', 'skills.jsonl'), '{ junk\n');
    const res = await fetch(`${s.base}/entry.json?id=doesnotexist0`, { headers: WITH_DOOR });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.state, 'error');
    assert.ok(body.reason);
  } finally { await s.stop(); gone(r); }
});

// --- (6) the auth guard applies, same as every other route -------------
//
// test/console.test.mjs's own "a wrong token gets a bare 404, on every
// path" probe already covers this for `/entry.json` too, because it
// reads `mod.PATHS` from the server rather than a hand-copied list —
// see this file's own header there. This probe is the same check, kept
// here as well because the assignment names it as one of the six to
// show for THIS route specifically.

test('(6) a wrong token gets the same bare 404 /entry.json gives every other guarded path', async () => {
  const { r, leaf } = build();
  const s = await start(r);
  try {
    const wrong = await fetch(`${s.base}/entry.json?id=${leaf.id}`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 404);
    const body = await wrong.text();
    assert.ok(!/cheap-mem|entry|token/i.test(body), `too much said to a wrong token: ${body}`);

    const right = await fetch(`${s.base}/entry.json?id=${leaf.id}`, { headers: WITH_DOOR });
    assert.equal(right.status, 200);
    assert.equal((await right.json()).entry.id, leaf.id);
  } finally { await s.stop(); gone(r); }
});

test('(6b) /entry.json is in the server’s own guarded path list', async () => {
  const mod = await import(`${pathToFileURL(SERVE).href}?paths=${Math.random()}`);
  assert.ok(mod.PATHS.includes('/entry.json'),
    "'/entry.json' is missing from PATHS — it would answer without the auth guard ever running");
});

// --- shared server helper, same shape as test/console.test.mjs ---------

const DOOR = ['probe', 'door', String(process.pid)].join('-');
const WITH_DOOR = { authorization: `Bearer ${DOOR}` };

async function start(root, env = {}) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR,
    CHEAP_MEM_SERVE_HOST: '127.0.0.1',
    CHEAP_MEM_SERVE_PORT: '0',
    ...env,
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}
