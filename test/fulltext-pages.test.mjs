// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/fulltext-pages.test.mjs — audit F23: full text no longer blocks and delivers pages (2026-10-07;
// mirrors the sibling's test/volltext-seiten.test.mjs).
//
// **The finding.** The full-text index was rebuilt synchronously after every generation change and a
// frequent substring returned ALL ids in one answer: measured at 100k entries ~140 ms of timer delay,
// 0.9 MB of answer.
//
// **What the probes hold.**
//   (1) Equality: all pages together == the old full scan (frozen reference = src/fulltext.mjs of the
//       FIXED commit c74adca), order included — umlauts, substrings, fields after character 220, short
//       queries, merged (superseded) entries, generation change.
//   (2) Pagination is finite and complete; a foreign/old cursor means `expired`, never an empty list.
//   (3) Event-loop gate: with 100k entries the timer delay stays under the limit (new GREEN, the old
//       state RED; positive control: the same setup sees the delay of the old state at all).
//   (4) Route: ?limit=/&cursor=, answer size bounded.
//   (5) Browser: "load more" (new client GREEN, the client of c74adca has no button = RED).
/* global document, getComputedStyle, location -- these run inside the page (browser), not in Node */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { startBrowser, waitReady } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import * as memory from '../src/memory.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as fulltext from '../src/fulltext.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD_STATE = 'c74adca'; // FIXED: never merge-base (it moves after the merge)
const old = (file) => execFileSync('git', ['-C', REPO, 'show', `${OLD_STATE}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const TMP = [];
after(() => { for (const d of TMP) removeTree(d); });
function tmpDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP.push(d); return d; }

/** The old fulltext.mjs, with absolute imports into the current tree, as a module of its own. */
async function loadOld() {
  const source = old('src/fulltext.mjs')
    .replaceAll("from './dashboard.mjs'", `from '${pathToFileURL(path.join(REPO, 'src/dashboard.mjs')).href}'`)
    .replaceAll("from './dashboard-cache.mjs'", `from '${pathToFileURL(path.join(REPO, 'src/dashboard-cache.mjs')).href}'`);
  const file = path.join(tmpDir('fulltext-old-'), 'fulltext-old.mjs');
  fs.writeFileSync(file, source);
  OLD_URL = pathToFileURL(file).href;
  return import(OLD_URL);
}
let OLD_URL = null;
const OLD = await loadOld();

/** All pages of a query in a row; checks finiteness and page size on the way. */
async function allPages(r, q, opt, limit) {
  const ids = [];
  let cursor = null, pages = 0;
  for (;;) {
    const s = await fulltext.page(r, q, { ...opt, cursor, limit });
    assert.ok(s && !s.expired, 'the cursor holds within one state');
    assert.ok(s.ids.length <= Math.min(limit, fulltext.LIMIT_MAX), 'never more than limit ids per page');
    ids.push(...s.ids);
    pages += 1;
    assert.ok(pages <= 100000, 'finite');
    if (!s.more) { assert.equal(s.cursor, null); return { ids, pages }; }
    assert.equal(typeof s.cursor, 'string');
    cursor = s.cursor;
  }
}

// ---------------------------------------------------------------- (1) equality

/** A corpus with the cases from the order; deterministic. */
function corpus() {
  const z = [];
  const one = (entry) => z.push({ project: 'global', drawer: 'learning', entry });
  one({ id: 'u1', title: 'B\u00e4ckerei Gr\u00f6\u00dfe', text: '\u00dcBERGANG zur Stra\u00dfe' });
  one({ id: 'u2', title: '\u00c4rger im B\u00fcro', tags: ['\u00d6l', '\u00c4\u00d6\u00dc'] });
  one({ id: 'u3', title: 'Ma\u00dfe und Gewichte', text: 'Fu\u00dfball' });
  one({ id: 'l1', title: 'Long', first: 'Fillerword '.repeat(40), late: 'sits-at-the-back Quokkasignal' });
  one({ id: 'n1', title: 'Deep', a: { b: [{ c: 'Nested-\u00dcBER' }, 'secondly'] }, number: 424242, empty: '', nothing: null });
  // superseded: the same id in two rows (old + new) -- both texts count, as in the old full scan
  one({ id: 'x1', title: 'Superseded', text: 'oldwordzebra' });
  one({ id: 'x1', title: 'Superseded', text: 'newwordgiraffe', status: 'superseded' });
  one({ entry_without_id: true });
  z.push({ project: 'p', drawer: 'x', entry: null });
  z.push({ project: 'p', drawer: 'x' });
  const words = ['alpha', 'beta', 'gamma', 'delta', 'Zebra', '\u00e4rmel', '\u00dcbung', 'stra\u00dfe', 'kleinod', 'e'];
  for (let i = 0; i < 1500; i++) {
    one({ id: `g${i}`, title: `Entry ${i} ${words[i % words.length]}`, text: words[(i * 7) % words.length] + ' ' + 'x'.repeat(i % 50), why: i % 97 === 0 ? 'rare-' + i : undefined });
  }
  return z;
}

test('fulltext-pages: all pages together == the old full scan (umlauts, substrings, long fields, short queries, superseded)', async () => {
  const Z = corpus();
  const opt = { key: () => 'k', readAll: () => Z };
  const r = '/r-equal';
  OLD.forget(); fulltext.forget();
  const queries = ['\u00e4', '\u00c4RGER', 'gr\u00f6\u00dfe', '\u00dc', '\u00fcber', 'stra\u00dfe', 'ma\u00dfe', '\u00df', 'quokkasignal', 'sits-at-the', 'nested', 'secondly', '424242', 'oldwordzebra', 'newwordgiraffe',
    'zebra', 'e', 'a', 'x', '1', 'entry 1', 'rare-', 'rare-97', 'nowhereatall', 'fillerword', '\u00f6l', '\u00e4\u00f6\u00fc', 'deep'];
  let withHits = 0, multiPage = 0;
  for (const q of queries) {
    const reference = OLD.fulltextIds(r, q, opt);
    for (const limit of [1, 7, 200, 5000]) {
      const { ids, pages } = await allPages(r, q, opt, limit);
      assert.deepEqual(ids, reference, `'${q}' with limit ${limit}: same hits in the same order`);
      if (limit === 7 && reference.length > 7) multiPage += 1;
      assert.equal(pages, Math.max(1, Math.ceil(reference.length / Math.min(limit, fulltext.LIMIT_MAX))), `'${q}' with limit ${limit}: page count = hits / limit`);
    }
    if (reference.length) withHits += 1;
  }
  assert.ok(withHits >= 20, `positive control: the queries do hit (${withHits})`);
  assert.ok(multiPage >= 8, `positive control: many queries run over several pages (${multiPage})`);
  // superseded: both states of the same id stay findable, the id appears once
  assert.deepEqual((await allPages(r, 'oldwordzebra', opt, 7)).ids, ['x1']);
  assert.deepEqual((await allPages(r, 'newwordgiraffe', opt, 7)).ids, ['x1']);
});

test('fulltext-pages: real store — pages == old full scan, readRowsLazy == readPass rows', async () => {
  const r = tmpDir('fulltext-pages-real-');
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'notes', participants: { alex: { human: true }, builder: {} }, language: 'en' }));
  const t0 = Date.parse('2026-09-01T09:00:00Z');
  for (let i = 0; i < 40; i++) {
    if (i % 2) memory.logEntry(r, 'learning', { agent: 'builder', title: `Check ${i} Gr\u00f6\u00dfe`, text: 'short' }, { now: new Date(t0 + i * 60e3) });
    else memory.logEntry(r, 'decision', { agent: 'builder', title: `Check ${i} Gr\u00f6\u00dfe`, choice: 'x'.repeat(230) + ' Quokkasignal' + i, why: 'B\u00e4ckerei ' + i }, { now: new Date(t0 + i * 60e3) });
  }
  const pass = dashboard.readPass(r).rows.map(({ project, drawer, entry }) => ({ project, drawer, entry }));
  assert.deepEqual([...dashboard.readRowsLazy(r)], pass);
  assert.ok(pass.length >= 40);
  const opt = { key: () => 'k' };
  OLD.forget(); fulltext.forget();
  for (const q of ['quokkasignal', 'gr\u00f6\u00dfe', 'B\u00c4CKEREI', 'check 3', 'short', 'e']) {
    const reference = OLD.fulltextIds(r, q, opt);
    assert.ok(reference.length > 0, `positive control '${q}'`);
    assert.deepEqual((await allPages(r, q, opt, 5)).ids, reference, q);
  }
});

test('fulltext-pages: generation change — the old index is never served (a removed entry must vanish), the old cursor expires, afterwards == full scan of the new state', async () => {
  let Z = corpus();
  let key = 'a';
  const opt = { key: () => key, readAll: () => Z };
  const r = '/r-change';
  OLD.forget(); fulltext.forget();
  const s1 = await fulltext.page(r, 'e', { ...opt, limit: 5 });
  assert.equal(s1.more, true);
  assert.equal(s1.fresh, true);
  const Z0 = Z[0];
  // The store changes: a new entry with the word, an old one gone
  Z = [{ project: 'global', drawer: 'learning', entry: { id: 'new1', title: 'Fresh', text: 'onlyinthenew' } }, ...Z.slice(1)];
  key = 'b';
  // The request waits for the rebuild: the answer knows the new entry, and the entry that is gone (Z[0]) is not shown.
  const gone = Z0.entry.id;
  const waited = await fulltext.page(r, 'onlyinthenew', opt);
  assert.deepEqual(waited.ids, ['new1'], 'a generation change is answered from the NEW index, never the old one');
  assert.equal(waited.fresh, true);
  assert.ok(!(await fulltext.page(r, 'e', { ...opt, limit: 1000 })).ids.includes(gone), 'a removed entry does not outlive its generation');
  const expired = await fulltext.answer(r, 'e', { ...opt, cursor: s1.cursor, limit: 5 });
  assert.deepEqual([expired.expired, expired.ids, expired.more, expired.measurable], [true, [], false, true], 'cursor of the old generation: expired');
  const fresh = await fulltext.page(r, 'onlyinthenew', opt);
  assert.deepEqual(fresh.ids, ['new1']);
  assert.equal(fresh.fresh, true);
  assert.notEqual(fresh.generation, s1.generation);
  OLD.forget();
  for (const q of ['e', 'onlyinthenew', '\u00e4', 'rare-']) {
    assert.deepEqual((await allPages(r, q, opt, 11)).ids, OLD.fulltextIds('/r-ref', q, opt), `${q}: new state == full scan`);
  }
});

test('fulltext-pages: build fails — the first build says measurable:false, a later rebuild fails loudly (never the old index)', async () => {
  fulltext.forget();
  const r = '/r-fail';
  const b = await fulltext.answer(r, 'x', { key: () => 'k', readAll: () => { throw new Error('broken'); } });
  assert.equal(b.measurable, false);
  assert.match(b.reason, /broken/);
  assert.ok(!('ids' in b));
  let key = 'a', broken = false;
  const opt = { key: () => key, readAll: () => { if (broken) throw new Error('broken later'); return [{ entry: { id: 'a1', text: 'hello' } }]; } };
  assert.deepEqual((await fulltext.page(r, 'hello', opt)).ids, ['a1']);
  key = 'b'; broken = true;
  const x = await fulltext.answer(r, 'hello', opt);
  assert.equal(x.measurable, false, 'no old index as a fallback: it could show what was removed');
  assert.match(x.reason, /broken later/);
  assert.ok(!('ids' in x));
  broken = false;
  const x2 = await fulltext.page(r, 'hello', opt); // tries again, now succeeds
  assert.deepEqual([x2.ids, x2.fresh], [['a1'], true]);
});

// ---------------------------------------------------------------- (2) pagination

test('fulltext-pages: pagination finite and complete; limit is clamped; foreign cursors expire', async () => {
  const Z = Array.from({ length: 2500 }, (_, i) => ({ entry: { id: `p${i}`, text: 'hit ' + i } }));
  Z.push({ entry: { id: 'only', text: 'rare-word' } });
  const opt = { key: () => 'k', readAll: () => Z };
  const r = '/r-pages';
  fulltext.forget();
  const ones = await allPages(r, 'hit', opt, 1);
  assert.equal(ones.pages, 2500, 'limit 1: one page per hit');
  assert.equal(new Set(ones.ids).size, 2500, 'no duplicate');
  assert.deepEqual(ones.ids, Z.slice(0, 2500).map((z) => z.entry.id));
  const big = await fulltext.page(r, 'hit', { ...opt, limit: 999999 });
  assert.equal(big.ids.length, fulltext.LIMIT_MAX, 'limit is clamped to LIMIT_MAX');
  assert.equal(big.more, true);
  for (const nonsense of [undefined, null, 'abc', 0, -5, NaN, '']) {
    assert.equal((await fulltext.page(r, 'hit', { ...opt, limit: nonsense })).ids.length, fulltext.LIMIT_DEFAULT, `limit ${String(nonsense)}: default`);
  }
  const only = await fulltext.page(r, 'rare-', opt);
  assert.deepEqual([only.ids, only.more, only.cursor], [['only'], false, null]);
  const exact = await fulltext.page(r, 'hit 1', { ...opt, limit: 1111 }); // 1, 10-19, 100-199, 1000-1999 -> 1111 hits
  assert.equal(exact.ids.length, 1000, 'cap');
  const rest = await fulltext.page(r, 'hit 1', { ...opt, cursor: exact.cursor, limit: 1000 });
  assert.equal(rest.ids.length, 111);
  assert.equal(rest.more, false, 'exact: right at the end there is no "more"');
  for (const c of ['x', '12', 'g999.0', `${big.generation}.99999999`, `${big.generation}.-1`, '..', { toString: () => 'g1.1' }]) {
    const x = await fulltext.page(r, 'hit', { ...opt, cursor: c });
    assert.equal(x.expired, true, `cursor ${JSON.stringify(String(c))} is expired, not found-empty`);
  }
});

// ---------------------------------------------------------------- (3) event loop

/**
 * **The measurement runs in a fresh child process and counts the CPU time of the main thread
 * (mirror of the sibling's CI round 3, 2026-10-07).** The old probe measured the wall-clock gap
 * between two 1 ms timers. Under machine load that gap (hundreds of ms to seconds) is the
 * scheduler not letting the process run, not the code holding the loop; and in the test process
 * itself the heap is dirtied by the old state, the equality probes and the browser set-up, so GC
 * pauses push the CPU time over the limit too. In a fresh child with only the 100k entries the
 * maximum stays far under the limit even under load; the old state sits well above it. The limit
 * of 60 ms stays. What is counted is how long JS REALLY held the loop: the main thread's run time
 * from /proc/thread-self/schedstat (ns; NOT process.cpuUsage(), which includes the GC helper
 * threads). Without schedstat it falls back to the wall clock (then the probe measures the
 * machine again, and the message says so). The wall gap is reported in every message.
 */
const MEASURE_CHILD = `
import fs from 'node:fs';
const [, , moduleUrl, kind] = process.argv;
const m = await import(moduleUrl);
const N = 100000;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
let schedstat = true;
const cpuMs = () => {
  if (schedstat) { try { return Number(fs.readFileSync('/proc/thread-self/schedstat', 'utf8').split(' ')[0]) / 1e6; } catch { schedstat = false; } }
  return performance.now();
};
const Z = Array.from({ length: N }, (_, i) => ({ entry: { id: 'i' + i, title: 'Entry ' + i + ' lucky probe', text: 'x'.repeat(60) } }));
let key = 1;
const opt = { key: () => key, readAll: () => Z };
async function measure(run) {
  globalThis.gc(); globalThis.gc(); // test data and old load stay out of the measurement
  let last = performance.now(), lastCpu = cpuMs(), cpu = 0, wall = 0;
  const watch = setInterval(() => {
    const t = performance.now(), c = cpuMs();
    cpu = Math.max(cpu, c - lastCpu); wall = Math.max(wall, t - last);
    last = t; lastCpu = c;
  }, 1);
  await wait(20);
  cpu = 0; wall = 0; last = performance.now(); lastCpu = cpuMs();
  await run();
  await wait(3); // a blocked tick only reports after the run
  clearInterval(watch);
  return { cpu, wall, schedstat };
}
const out = {};
m.forget();
if (kind === 'old') {
  let r;
  out.m = await measure(async () => { r = await m.answer('/r', 'e', opt); });
  out.ids = r.ids.length;
} else {
  let s;
  out.cold = await measure(async () => { s = await m.answer('/r', 'e', opt); });
  out.coldIds = s.ids.length; out.coldMore = s.more; out.coldBytes = JSON.stringify(s).length;
  key = 2;
  let w2;
  out.change = await measure(async () => { w2 = await m.answer('/r', 'e', opt); await m.waitForBuild('/r'); });
  out.changeFresh = w2.fresh; out.changeIds = w2.ids.length;
  out.rare = await measure(async () => { await m.answer('/r', 'nowhere-to-be-found', opt); });
  out.rareIds = (await m.page('/r', 'nowhere-to-be-found', opt)).ids.length;
}
process.stdout.write(JSON.stringify(out));
`;

function measureInChild(moduleUrl, kind) {
  const dir = tmpDir('fulltext-measure-');
  const script = path.join(dir, 'measure.mjs');
  fs.writeFileSync(script, MEASURE_CHILD);
  const r = spawnSync(process.execPath, ['--expose-gc', script, moduleUrl, kind], { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 300000 });
  assert.equal(r.status, 0, `measuring child (${kind}) ended with ${r.status}/${r.signal}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const DELAY_LIMIT_MS = 60;
const N_GATE = 100000;
const show = (g) => `${g.cpu.toFixed(0)} ms ${g.schedstat ? 'main-thread CPU' : 'WALL CLOCK (no schedstat)'}, wall gap ${g.wall.toFixed(0)} ms`;

test('fulltext-pages: event-loop gate at 100k — cold build and generation change keep the timer under the limit; the old state does not', () => {
  // old state (RED): cold build + search with a hit in every entry
  const a = measureInChild(OLD_URL, 'old');
  assert.equal(a.ids, N_GATE, 'positive control: the old state really returns ALL ids in one answer');
  assert.ok(a.m.cpu > DELAY_LIMIT_MS, `RED: the old state holds the timer back (${show(a.m)} > ${DELAY_LIMIT_MS})`);
  // new state (GREEN)
  const n = measureInChild(pathToFileURL(path.join(REPO, 'src/fulltext.mjs')).href, 'new');
  assert.equal(n.coldIds, fulltext.LIMIT_DEFAULT);
  assert.equal(n.coldMore, true);
  assert.ok(n.cold.cpu < DELAY_LIMIT_MS, `cold build: ${show(n.cold)} < ${DELAY_LIMIT_MS} (old state: ${show(a.m)})`);
  assert.ok(n.coldBytes < 5000, 'the answer stays small (' + n.coldBytes + ' bytes instead of ~0.9 MB)');
  assert.equal(n.changeFresh, true, 'generation change: the answer waits for the new index');
  assert.equal(n.changeIds, fulltext.LIMIT_DEFAULT);
  assert.ok(n.change.cpu < DELAY_LIMIT_MS, `generation change with rebuild: ${show(n.change)} < ${DELAY_LIMIT_MS}`);
  assert.ok(n.rare.cpu < DELAY_LIMIT_MS, `full pass without a hit: ${show(n.rare)} < ${DELAY_LIMIT_MS}`);
  assert.equal(n.rareIds, 0);
});

// ---------------------------------------------------------------- (4) route, (5) browser

const { browser, reason: REASON } = await startBrowser();

const COUNT = 230; // more than LIMIT_DEFAULT: the first page is not enough
function makeWorld() {
  const r = tmpDir('fulltext-pages-world-');
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'notes', participants: { alex: { human: true }, builder: {} }, language: 'en' }));
  const t0 = Date.parse('2026-09-01T09:00:00Z');
  for (let i = 0; i < COUNT; i++) {
    // The word sits ONLY in `why`: the local excerpt filter finds nothing, only the full text does
    memory.logEntry(r, 'decision', { agent: 'builder', title: `Choice ${i}`, choice: 'Variant A', why: `because the zebrafinchcouncil ${i} wanted it` }, { now: new Date(t0 + i * 60e3) });
  }
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Decoy', text: 'None of it.' }, { now: new Date(t0 + COUNT * 60e3) });
  return r;
}
const WORLD = makeWorld();
const shared = await (async () => {
  const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?t=${Math.random()}`);
  const { server } = await mod.serve(WORLD, {
    ...process.env, CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '',
  });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
})();
after(() => shared.close());

test('fulltext-pages: route — ?limit= and ?cursor= deliver finitely many pages, together all hits; answer small', async () => {
  const ids = [], trace = [];
  let cursor = null, pages = 0;
  for (;;) {
    const u = `${shared.base}/api/fulltext?q=Zebrafinchcouncil&limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const res = await fetch(u);
    const text = await res.text();
    const b = JSON.parse(text);
    assert.equal(res.status, 200);
    assert.equal(b.measurable, true);
    assert.ok(b.ids.length <= 100);
    assert.ok(text.length < 4000, 'a page stays small');
    ids.push(...b.ids);
    pages += 1;
    trace.push({ page: pages, ids: b.ids.length, more: b.more, cursor: b.cursor, generation: b.generation, fresh: b.fresh, expired: b.expired });
    assert.ok(pages < 10);
    if (!b.more) { assert.equal(b.cursor, null); break; }
    cursor = b.cursor;
  }
  // The trace is only for the failure message: CI once showed `1 !== 3` with nothing to say why.
  assert.equal(pages, 3, `pages seen: ${JSON.stringify(trace)}`);
  assert.equal(ids.length, COUNT);
  assert.equal(new Set(ids).size, COUNT);
  const standard = await (await fetch(`${shared.base}/api/fulltext?q=Zebrafinchcouncil`)).json();
  assert.equal(standard.ids.length, fulltext.LIMIT_DEFAULT, 'without limit: the default page');
  assert.equal(standard.more, true);
  const bad = await (await fetch(`${shared.base}/api/fulltext?q=Zebrafinchcouncil&cursor=nonsense`)).json();
  assert.deepEqual([bad.expired, bad.ids], [true, []]);
});

const BROWSER_DEADLINE_MS = 5 * 60 * 1000;

async function searchPage(base, client = null) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60000);
  try {
    if (client) await page.route('**/dashboard/app.js*', (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
    await page.goto(base + '/dashboard', { waitUntil: 'load' }); // never networkidle
    await waitReady(page);
    await page.evaluate(() => { location.hash = 'knowledge/entries'; });
    await page.waitForSelector('#entrySearch');
    await page.click('#entrySearch');
    await page.keyboard.type('zebrafinchcouncil');
    const state = () => page.evaluate(() => {
      const visible = (el) => { if (!el) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0; };
      const button = document.querySelector('#screen [data-action="fulltext-more"]');
      const foot = [...document.querySelectorAll('#screen .tablefoot span')].map((s) => s.textContent).join(' ');
      return { hits: Number((/([\d.,]+)\s+hits/.exec(foot) || [])[1]?.replace(/[.,]/g, '')), button: visible(button) ? button.textContent.trim() : null };
    });
    return { state, page };
  } catch (e) {
    await page.close();
    throw e;
  }
}

test('fulltext-pages: browser — "load more" fetches the next page (GREEN); the client of c74adca has no button (RED)', { skip: REASON, timeout: BROWSER_DEADLINE_MS }, async () => {
  const fresh = await searchPage(shared.base);
  try {
    await fresh.page.waitForFunction(() => /\b200\s+hits/.test(document.querySelector('#screen .tablefoot')?.textContent || ''), null, { timeout: 30000 });
    const before = await fresh.state();
    assert.equal(before.hits, fulltext.LIMIT_DEFAULT, 'first page: exactly the default page');
    assert.match(before.button || '', /Load more full-text hits/, 'the button is VISIBLE (getComputedStyle)');
    await fresh.page.click('#screen [data-action="fulltext-more"]');
    await fresh.page.waitForFunction((n) => new RegExp('\\b' + n + '\\s+hits').test(document.querySelector('#screen .tablefoot')?.textContent || ''), COUNT, { timeout: 30000 });
    const after = await fresh.state();
    assert.equal(after.hits, COUNT, 'all hits after "load more"');
    assert.equal(after.button, null, 'nothing left to load: no button');
  } finally {
    await fresh.page.close();
  }
  // RED: the old client knows neither button nor cursor (against the new server it would show only the first page)
  const oldClient = old('assets/dashboard/dashboard.js');
  assert.ok(!oldClient.includes('fulltext-more'), 'the old client has no button');
  const o = await searchPage(shared.base, oldClient);
  try {
    await o.page.waitForFunction(() => /\bhits/.test(document.querySelector('#screen .tablefoot')?.textContent || ''), null, { timeout: 30000 });
    await o.page.waitForTimeout(1500);
    const z = await o.state();
    assert.equal(z.button, null, 'RED: no "load more" in the old client');
    assert.notEqual(z.hits, COUNT, 'RED: with the page answer the old client does not show all hits');
  } finally {
    await o.page.close();
  }
});
