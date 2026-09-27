// test/pages.test.mjs — E1.3: `/entries.json` filters server-side and
// returns cursor-based pages with a stable order. English mirror of
// lucky-mem's `test/eintraege-seiten.test.mjs` (its commit `01da1319`)
// for cheap-mem's own list route; see the header comment on
// `src/pages.mjs` for the full contract this file checks, including
// the one gap it deliberately leaves unprobed.
//
// Probes, in the order the assignment names them:
//   (a) all pages in sequence = the full, stably sorted list, no
//       dup/gap, including ties on an identical timestamp
//   (b) a `q` hit beyond page 1 is found through the cursor
//   (c) a corpus change between two pages -> warning
//   (d) a broken cursor -> error, never page 1
//   (e) file opens per page are bounded
//   (f) the auth guard applies like any other route
// Plus: unknown type/project -> unknown, a broken line -> warning,
// contract shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as pages from '../src/pages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-pages-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'pages', participants: ['someone'], language: 'en' }));
  return r;
}
function gone(r) { fs.rmSync(r, { recursive: true, force: true }); }

/** Append raw JSONL lines to one drawer, creating parent dirs as needed. */
function writeLines(root, rel, lines) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const text = `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`;
  fs.appendFileSync(p, text);
}

/** `n` events, `ts` descending as the index grows ('e00000000' is the newest). */
function events(n, { from = 0, prefix = 'e', sameTs = null } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(from + i).padStart(8, '0')}`,
    ts: sameTs ?? `2026-09-${String(20 - Math.floor(i / 20)).padStart(2, '0')}`
      + `T${String(23 - (i % 20)).padStart(2, '0')}:00:00Z`,
    title: `Event ${prefix}${from + i}`, text: 'ordinary content',
  }));
}

// --- (a) the full, stable list across all pages -------------------------

test('(a) all pages in sequence = the full list, no dup/gap, ties broken by id', () => {
  const r = world();
  try {
    // 23 distinct timestamps + 4 sharing EXACTLY the same one, to force
    // the tie-break through id.
    writeLines(r, 'global/events.jsonl', events(23));
    writeLines(r, 'global/events.jsonl', events(4, { from: 100, prefix: 'tie', sameTs: '2026-09-20T12:00:00Z' }));

    const seen = [];
    let cursor = null;
    let pageCount = 0;
    for (;;) {
      pageCount += 1;
      assert.ok(pageCount < 50, 'abort condition: too many pages, likely an infinite loop');
      const p = pages.page(r, { n: 7, after: cursor });
      assert.equal(p.state, 'ok', `unexpected state: ${p.state} (${p.reason})`);
      for (const e of p.entries) seen.push(e.id);
      if (!p.next) break;
      cursor = p.next;
    }
    assert.equal(seen.length, 27, 'total count is off — entries lost or duplicated');
    assert.equal(new Set(seen).size, 27, 'duplicate in the assembled list');

    // Within the four tied entries the id order must be ascending (the
    // one unique tie-break field).
    const tied = seen.filter((id) => id.startsWith('tie'));
    assert.deepEqual(tied, [...tied].sort());

    // And the whole list matches the expected order exactly (ts
    // descending, id ascending on a tie).
    const all = [...events(23), ...events(4, { from: 100, prefix: 'tie', sameTs: '2026-09-20T12:00:00Z' })];
    const expected = all
      .sort((x, y) => (x.ts !== y.ts ? (x.ts > y.ts ? -1 : 1) : (x.id < y.id ? -1 : 1)))
      .map((e) => e.id);
    assert.deepEqual(seen, expected);
  } finally { gone(r); }
});

// --- (b) a q hit beyond the first page --------------------------------

test('(b) a text-search hit beyond the first page is found through the cursor', () => {
  const r = world();
  try {
    // 'zunderholz' appears in exactly two entries: one very recent
    // (page 1) and one very old (well past n=1).
    const middle = events(10, { from: 10 });
    writeLines(r, 'global/events.jsonl', [
      { id: 'fresh00001', ts: '2026-09-25T09:00:00Z', title: 'zunderholz early', text: 'x' },
      ...middle,
      { id: 'stale00001', ts: '2026-09-01T09:00:00Z', title: 'zunderholz late', text: 'x' },
    ]);

    const page1 = pages.page(r, { q: 'zunderholz', n: 1 });
    assert.equal(page1.state, 'ok');
    assert.equal(page1.entries.length, 1);
    assert.equal(page1.entries[0].id, 'fresh00001');
    assert.ok(page1.next, 'no next cursor, though a second hit is still outstanding');

    const page2 = pages.page(r, { q: 'zunderholz', n: 1, after: page1.next });
    assert.equal(page2.state, 'ok');
    assert.equal(page2.entries.length, 1, 'the second hit was not found beyond the first page');
    assert.equal(page2.entries[0].id, 'stale00001');
    assert.equal(page2.next, null);
  } finally { gone(r); }
});

// --- (c) a corpus change between two pages -----------------------------

test('(c) a corpus change between two pages -> state warning, "Corpus changed"', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(10));
    const page1 = pages.page(r, { n: 3 });
    assert.equal(page1.state, 'ok');
    assert.ok(page1.next);

    // The corpus changes (a new entry arrives) BEFORE the second page.
    writeLines(r, 'global/events.jsonl', events(1, { from: 999, prefix: 'new' }));

    const page2 = pages.page(r, { n: 3, after: page1.next });
    assert.equal(page2.state, 'warning', 'the corpus change was not detected');
    assert.match(page2.reason, /Corpus changed/);
    // Still a page, never a silent nothing.
    assert.ok(page2.entries.length > 0);
  } finally { gone(r); }
});

test('(c2) without a corpus change the next page stays "ok"', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(10));
    const page1 = pages.page(r, { n: 3 });
    const page2 = pages.page(r, { n: 3, after: page1.next });
    assert.equal(page2.state, 'ok');
  } finally { gone(r); }
});

// --- (d) a broken cursor -------------------------------------------------

test('(d) a broken cursor answers state error, NEVER silently page 1', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(5));
    for (const broken of ['not-base64!!', Buffer.from('a plain string').toString('base64url')]) {
      const p = pages.page(r, { n: 2, after: broken });
      assert.equal(p.state, 'error', `cursor '${broken}' should have answered 'error'`);
      assert.equal(p.entries.length, 0, "an 'error' state must not pretend to carry entries");
      assert.equal(p.next, null);
      assert.equal(p.asOf, null);
      assert.ok(p.reason);
    }
  } finally { gone(r); }
});

test('(d2) server: a broken cursor -> HTTP 500 with state error', async () => {
  const r = world();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/entries.json?after=definitely-not-a-valid-cursor`, { headers: WITH_DOOR });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.state, 'error');
  } finally { await s.stop(); gone(r); }
});

// --- (e) file opens per page are bounded --------------------------------

function countOpens(fn) {
  const openBefore = fs.openSync;
  const readBefore = fs.readFileSync;
  let n = 0;
  fs.openSync = (...a) => { n += 1; return openBefore(...a); };
  fs.readFileSync = (...a) => { n += 1; return readBefore(...a); };
  try { fn(); } finally { fs.openSync = openBefore; fs.readFileSync = readBefore; }
  return n;
}

test('(e) with a fixed type/project, file opens per page do not grow with the filling', () => {
  const small = world();
  const big = world();
  try {
    writeLines(small, 'global/events.jsonl', events(20));
    writeLines(big, 'global/events.jsonl', events(4000));
    const nSmall = countOpens(() => pages.page(small, { type: 'event', project: 'global', n: 10 }));
    const nBig = countOpens(() => pages.page(big, { type: 'event', project: 'global', n: 10 }));
    assert.equal(nSmall, nBig,
      `file opens grow with the filling: small=${nSmall}, big=${nBig}`);
    assert.ok(nSmall <= 3, `too many file opens for ONE drawer: ${nSmall}`);
  } finally { gone(small); gone(big); }
});

test('(e2) with no type/project filter, opens depend on the drawer count, not the content', () => {
  const small = world();
  const big = world();
  try {
    // The same two drawers in both memories, only very differently filled.
    writeLines(small, 'global/events.jsonl', events(20));
    writeLines(small, 'global/errors.jsonl', events(5, { prefix: 'err' }));
    writeLines(big, 'global/events.jsonl', events(3000));
    writeLines(big, 'global/errors.jsonl', events(3000, { prefix: 'err' }));
    const nSmall = countOpens(() => pages.page(small, { n: 10 }));
    const nBig = countOpens(() => pages.page(big, { n: 10 }));
    assert.equal(nSmall, nBig,
      `file opens grow with the content instead of the drawer count: small=${nSmall}, big=${nBig}`);
  } finally { gone(small); gone(big); }
});

// --- (f) the auth guard applies -----------------------------------------

test('(f) a wrong token gets the same bare 404 every other guarded path gives', async () => {
  const r = world();
  const s = await start(r);
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    const wrong = await fetch(`${s.base}/entries.json`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 404);
    const body = await wrong.text();
    assert.ok(!/cheap-mem|entries|token/i.test(body), `too much said to a wrong token: ${body}`);
  } finally { await s.stop(); gone(r); }
});

test('(f2) server: a valid request answers 200 with the expected headers', async () => {
  const r = world();
  const s = await start(r);
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    const res = await fetch(`${s.base}/entries.json?n=2`, { headers: WITH_DOOR });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.state, 'ok');
    assert.equal(body.entries.length, 2);
  } finally { await s.stop(); gone(r); }
});

test('(f3) /entries.json is in the server’s own guarded path list', async () => {
  const mod = await import(`${pathToFileURL(SERVE).href}?paths=${Math.random()}`);
  assert.ok(mod.PATHS.includes('/entries.json'),
    "'/entries.json' is missing from PATHS — it would answer without the auth guard ever running");
});

// --- unknown filter, broken line, contract shape -------------------------

test('an unknown type -> state unknown (no corpus pass, never a not-found)', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    const p = pages.page(r, { type: 'does-not-exist' });
    assert.equal(p.state, 'unknown');
    assert.deepEqual(p.entries, []);
    assert.equal(p.next, null);
    assert.equal(p.asOf, null);
    assert.ok(p.reason);
  } finally { gone(r); }
});

test('an unknown project -> state unknown', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    const p = pages.page(r, { project: 'does-not-exist' });
    assert.equal(p.state, 'unknown');
  } finally { gone(r); }
});

test('server: an unknown type -> HTTP 400', async () => {
  const r = world();
  const s = await start(r);
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    const res = await fetch(`${s.base}/entries.json?type=does-not-exist`, { headers: WITH_DOOR });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).state, 'unknown');
  } finally { await s.stop(); gone(r); }
});

test('a valid filter with no hits is "ok" with an empty list, not "unknown"', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    const p = pages.page(r, { type: 'error' }); // a real type, but no errors.jsonl there
    assert.equal(p.state, 'ok');
    assert.deepEqual(p.entries, []);
    assert.equal(p.next, null);
  } finally { gone(r); }
});

test('a broken line in a touched drawer -> state warning, never a silent not-found', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    fs.appendFileSync(path.join(r, 'global', 'events.jsonl'), '{ this is not JSON\n');
    const p = pages.page(r, { type: 'event' });
    assert.equal(p.state, 'warning');
    assert.match(p.reason, /unreadable/);
    assert.equal(p.entries.length, 3, 'the readable entries must still be there');
  } finally { gone(r); }
});

test('type and project filters select only the matching drawers', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(2, { prefix: 'glob' }));
    writeLines(r, 'global/errors.jsonl', events(2, { prefix: 'globerr' }));
    writeLines(r, 'projects/demo/events.jsonl', events(2, { prefix: 'demo' }));

    const onlyGlobalEvents = pages.page(r, { type: 'event', project: 'global', n: 50 });
    assert.deepEqual(onlyGlobalEvents.entries.map((e) => e.id).sort(), ['glob00000000', 'glob00000001']);

    const onlyDemo = pages.page(r, { project: 'demo', n: 50 });
    assert.deepEqual(onlyDemo.entries.map((e) => e.id).sort(), ['demo00000000', 'demo00000001']);
  } finally { gone(r); }
});

test('contract shape: the four states carry exactly the documented fields', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    const ok = pages.page(r, {});
    assert.deepEqual(Object.keys(ok).sort(), ['asOf', 'entries', 'next', 'state'].sort());

    const unknown = pages.page(r, { type: 'does-not-exist' });
    assert.deepEqual(Object.keys(unknown).sort(), ['asOf', 'entries', 'next', 'reason', 'state'].sort());

    const error = pages.page(r, { after: 'broken!!' });
    assert.equal(error.state, 'error');
    assert.deepEqual(Object.keys(error).sort(), ['asOf', 'entries', 'next', 'reason', 'state'].sort());
  } finally { gone(r); }
});

test('page size is capped at PAGE_SIZE_MAX', () => {
  const r = world();
  try {
    writeLines(r, 'global/events.jsonl', events(3));
    const p = pages.page(r, { n: 100000 });
    assert.equal(p.state, 'ok');
    // Only 3 entries exist — the cap itself only shows in that a huge
    // number does not make the function fail.
    assert.equal(p.entries.length, 3);
  } finally { gone(r); }
});

test('encodeCursor/decodeCursor are inverse to each other', () => {
  const c = pages.encodeCursor({ ts: '2026-09-20T10:00:00Z', id: 'abc123', stamp: 'deadbeef' });
  const d = pages.decodeCursor(c);
  assert.deepEqual(d, { ts: '2026-09-20T10:00:00Z', id: 'abc123', stamp: 'deadbeef' });
});

test('decodeCursor answers null for any deviation from the format, never a crash', () => {
  for (const x of [undefined, null, '', 42, 'xx', Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ v: 999, ts: 'a', id: 'b', stamp: 'c' })).toString('base64url')]) {
    assert.equal(pages.decodeCursor(x), null, `expected null for ${JSON.stringify(x)}`);
  }
});

// --- the known gap: an entry with no weighted text is invisible to `q` --

test('known gap: an entry with no weighted field is found without q, missed with q', () => {
  const r = world();
  try {
    // No `title`/`topic`/`tags`/`text`/... (search.mjs's FIELD_WEIGHTS) —
    // `search.mjs`'s indexer drops it entirely (`doc.weights.size === 0`).
    writeLines(r, 'global/updates.jsonl', [{ id: 'noweight0001', ts: '2026-09-20T10:00:00Z', version: '1.2.3' }]);
    const noQ = pages.page(r, { type: 'update' });
    assert.equal(noQ.state, 'ok');
    assert.ok(noQ.entries.some((e) => e.id === 'noweight0001'),
      'the no-q path should see this entry directly from the drawer');

    const withQ = pages.page(r, { q: '1.2.3' });
    assert.equal(withQ.state, 'ok');
    assert.ok(!withQ.entries.some((e) => e.id === 'noweight0001'),
      'documenting the known gap: an unweighted entry is not a search candidate at all');
  } finally { gone(r); }
});

// --- shared server helper, same shape as test/dashboard-entry-fast.test.mjs

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
