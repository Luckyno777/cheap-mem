// test/fulltext.test.mjs — the full-text search of the knowledge view
// (2026-09-29; mirrors the sibling's test/volltext.test.mjs).
//
// **The finding.** `#entrySearch` filtered only title + `text` (the first
// non-empty content field, cut to 220 characters). A word only in `why`
// or after character 220 found nothing (measured on the sibling's real
// store: ~19 % of the hits were missing against the old view).
//
// **Red proof** against the FIXED commit 4e9a7a4 (agent frame 12):
//   (1) structural — there is neither src/fulltext.mjs nor a call of
//       /api/fulltext in the client;
//   (2) unit — the old local filter (title + `text` from the dashboard
//       build) does NOT find the `why` word or the word after character
//       220, `fulltext.page` does;
//   (3) browser — the same flow with the client of 4e9a7a4 (played in by
//       page.route) does not find the `why` entry (RED), the current
//       client does (GREEN).
// **Positive control:** a word in the title is found in both states.
// Visibility is always checked through getComputedStyle, never through
// the hidden attribute.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startBrowser, waitReady } from './fixture/browser.mjs';
import * as memory from '../src/memory.mjs';
import * as fulltext from '../src/fulltext.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD_STATE = '4e9a7a4';
const old = (file) => execFileSync('git', ['-C', REPO, 'show', `${OLD_STATE}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const LONG = 'Fillerword '.repeat(30); // 330 characters, before the search word

function world(prefix) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'notes', participants: { alex: { human: true }, builder: {} }, language: 'en' }));
  const t0 = Date.parse('2026-09-01T09:00:00Z');
  let i = 0;
  const now = () => new Date(t0 + (i++) * 3600e3);
  // Only in `why`:
  memory.logEntry(r, 'decision', { agent: 'builder', title: 'First choice', choice: 'Variant A', why: 'because the zebrafinchcouncil wanted it' }, { now: now() });
  // After character 220 of the first content field (`text`); the headline
  // (class + title) does not carry it, otherwise the title would find it:
  memory.logEntry(r, 'learning', { agent: 'builder', class: 'note', title: 'Long text', text: `${LONG}Quokkasignal sits at the very back.` }, { now: now() });
  // Word in the title (positive control):
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Penguinpath in the title', text: 'Short.' }, { now: now() });
  // Decoy without any of the words:
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Decoy', text: 'None of it is here.' }, { now: now() });
  return r;
}
/** All pages together (small pages, so several arise); `null` for an empty query. */
async function allIds(r, q, opt = {}) {
  const ids = [];
  let cursor = null;
  for (;;) {
    const s = await fulltext.page(r, q, { ...opt, cursor, limit: opt.limit ?? 2 });
    if (s === null) return null;
    assert.ok(!s.expired, 'the cursor holds within one state');
    ids.push(...s.ids);
    if (!s.more) return ids;
    cursor = s.cursor;
  }
}
function idOf(r, title) {
  const d = dashboardData.collectDashboard(r, {});
  const e = d.entries.find((x) => x.title === title || x.title.startsWith(`${title} — `) || x.title.endsWith(` — ${title}`));
  assert.ok(e, `entry '${title}' in the dashboard build`);
  return e.id;
}

// --- (1) structural ----------------------------------------------------------

test('fulltext: the fixed old state has neither the search nor the call', () => {
  assert.throws(() => old('src/fulltext.mjs'), 'src/fulltext.mjs did not exist at 4e9a7a4');
  assert.ok(!old('assets/dashboard/dashboard.js').includes('/api/fulltext'), 'the old client does not ask the server');
  assert.ok(fs.readFileSync(path.join(REPO, 'assets/dashboard/dashboard.js'), 'utf8').includes('/api/fulltext'), 'the new client does');
});

// --- (2) unit ----------------------------------------------------------------

test('fulltext: the why entry and the word after character 220 are found, the decoy is not', async () => {
  const r = world('fulltext-unit-');
  fulltext.forget();
  const why = idOf(r, 'First choice'), long = idOf(r, 'Long text'), title = idOf(r, 'Penguinpath in the title'), decoy = idOf(r, 'Decoy');
  assert.deepEqual(await allIds(r, 'zebrafinchcouncil'), [why]);
  assert.deepEqual(await allIds(r, 'QUOKKASIGNAL'), [long], 'case-insensitive');
  assert.deepEqual(await allIds(r, 'penguinpath'), [title], 'positive control: title word');
  assert.ok(!(await allIds(r, 'fillerword')).includes(decoy), 'the decoy does not carry the word');
  assert.deepEqual(await allIds(r, 'nowhereatall'), [], 'no hit is [] (measurable), not null');
  assert.equal(await allIds(r, ''), null, 'empty query: ids null');
  assert.equal(await allIds(r, '   '), null);
});

test('fulltext: RED in the old state — the local filter (title + excerpt) sees neither word', async () => {
  const r = world('fulltext-red-');
  const d = dashboardData.collectDashboard(r, {});
  const local = (q) => d.entries.filter((e) => `${e.title} ${e.text ?? ''}`.toLowerCase().includes(q)).map((e) => e.title.split(' — ')[0]);
  assert.deepEqual(local('zebrafinchcouncil'), [], 'searched in the excerpt only: the why word is missing (the finding)');
  assert.deepEqual(local('quokkasignal'), [], 'searched in the excerpt only: the word after character 220 is missing');
  assert.deepEqual(local('penguinpath'), ['Penguinpath in the title'], 'positive control: the local filter sees the title word too');
  fulltext.forget();
  assert.equal((await allIds(r, 'zebrafinchcouncil')).length, 1, 'the full text finds it');
});

test('fulltext: nested objects and arrays are searched, numbers are not', () => {
  const idx = fulltext.buildIndex([{ entry: { id: 'x1', tags: ['Alpha'], deep: { a: [{ b: 'Nested' }] }, n: 424242 } }]);
  assert.ok(idx.get('x1').includes('nested'));
  assert.ok(idx.get('x1').includes('alpha'));
  assert.ok(!idx.get('x1').includes('424242'));
});

test('fulltext: the index is kept per store state; on a change the old one keeps serving, the new one arises in the background', async () => {
  const r = world('fulltext-cache-');
  fulltext.forget();
  let reads = 0;
  let key = 'a';
  const opt = { key: () => key, readAll: () => { reads += 1; return [{ entry: { id: 'e1', text: reads === 1 ? 'first' : 'second' } }]; } };
  assert.deepEqual(await allIds(r, 'first', opt), ['e1']);
  assert.deepEqual(await allIds(r, 'fir', opt), ['e1']);
  assert.equal(reads, 1, 'same key: not read again');
  key = 'b';
  const old1 = await fulltext.page(r, 'first', opt);
  assert.deepEqual(old1.ids, ['e1'], 'answered at once from the old index');
  assert.equal(old1.fresh, false, 'and marked "is being refreshed"');
  await fulltext.waitForBuild(r);
  assert.equal(reads, 2, 'new key: exactly ONE rebuild');
  const fresh = await fulltext.page(r, 'second', opt);
  assert.deepEqual(fresh.ids, ['e1']);
  assert.equal(fresh.fresh, true);
  assert.equal(reads, 2);
});

test('fulltext: a read failure is measurable:false with a reason, never an empty list', async () => {
  const b = await fulltext.answer('/does/not/exist', 'x', { key: () => 'k', readAll: () => { throw new Error('broken'); } });
  assert.equal(b.measurable, false);
  assert.match(b.reason, /broken/);
  assert.ok(!('ids' in b));
  assert.deepEqual(await fulltext.answer('/x', '', { key: () => 'k' }), { ids: null, measurable: true });
});

test('fulltext: the query is capped at 200 characters', () => {
  assert.equal(fulltext.normalize('a'.repeat(500)).length, fulltext.QUERY_MAX);
});

// --- Route + browser ---------------------------------------------------------

const { browser, reason: REASON } = await startBrowser();

async function withServer(r, env, run) {
  const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?t=${Math.random()}`);
  const { server } = await mod.serve(r, {
    ...process.env, CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0',
    CHEAP_MEM_SERVE_TOKEN: '', ...env,
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((res) => { server.closeAllConnections?.(); server.close(res); });
  }
}

test('fulltext: the route answers { ids, measurable:true }, ids:null for an empty query', async () => {
  const r = world('fulltext-route-');
  await withServer(r, {}, async (base) => {
    const why = idOf(r, 'First choice');
    const b = await (await fetch(`${base}/api/fulltext?q=Zebrafinchcouncil`)).json();
    assert.deepEqual({ ...b, generation: undefined }, { ids: [why], measurable: true, more: false, cursor: null, fresh: true, generation: undefined });
    assert.match(b.generation, /^g\d+$/);
    assert.deepEqual(await (await fetch(`${base}/api/fulltext?q=`)).json(), { ids: null, measurable: true });
    const long = await (await fetch(`${base}/api/fulltext?q=${'x'.repeat(5000)}`)).json();
    assert.deepEqual([long.ids, long.measurable, long.more], [[], true, false], 'a long query is cut, not refused');
    const foreign = await new Promise((res, rej) => {
      const rq = http.request(`${base}/api/fulltext?q=zebra`, { headers: { host: 'evil.example' } }, (rs) => { rs.resume(); res(rs.statusCode); });
      rq.on('error', rej); rq.end();
    });
    assert.equal(foreign, 403, 'the Host check applies like on every data route');
  });
});

async function searchInBrowser(base, typed, { client = null, route = null, delay = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    if (client) await page.route('**/dashboard/app.js*', (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
    if (route) await page.route('**/api/fulltext*', route);
    await page.goto(base + '/dashboard', { waitUntil: 'load' }); // never networkidle
    await waitReady(page);
    await page.evaluate(() => { location.hash = 'knowledge/entries'; });
    await page.waitForSelector('#entrySearch');
    await page.click('#entrySearch');
    await page.keyboard.type(typed, { delay });
    await page.waitForTimeout(900); // debounce 150 ms + answer + redraw
    return await page.evaluate(() => ({
      rows: [...document.querySelectorAll('#screen table tbody tr')].map((tr) => tr.textContent),
      focus: document.activeElement?.id,
      value: document.getElementById('entrySearch')?.value,
      pos: document.getElementById('entrySearch')?.selectionStart,
      notice: (() => {
        const h = document.getElementById('fulltextNotice');
        if (!h) return null;
        const cs = getComputedStyle(h);
        return { visible: cs.display !== 'none' && cs.visibility !== 'hidden' && h.getClientRects().length > 0, text: h.textContent };
      })(),
    }));
  } finally {
    await page.close();
  }
}

test('fulltext: browser — typing finds the why entry (GREEN); with the client of 4e9a7a4 it does not (RED); title word in both (positive control)', { skip: REASON }, async () => {
  const r = world('fulltext-browser-');
  await withServer(r, {}, async (base) => {
    const fresh = await searchInBrowser(base, 'zebrafinchcouncil');
    assert.equal(fresh.rows.length, 1, 'new client: exactly the why entry');
    assert.match(fresh.rows[0], /First choice/);
    assert.equal(fresh.focus, 'entrySearch', 'the focus stays in the field');
    assert.equal(fresh.value, 'zebrafinchcouncil');
    assert.equal(fresh.pos, 'zebrafinchcouncil'.length, 'the cursor stays at the end');
    assert.equal(fresh.notice, null, 'no notice when the server answers');

    const longFresh = await searchInBrowser(base, 'quokkasignal');
    assert.equal(longFresh.rows.length, 1);
    assert.match(longFresh.rows[0], /Long text/);

    const oldClient = old('assets/dashboard/dashboard.js');
    const red = await searchInBrowser(base, 'zebrafinchcouncil', { client: oldClient });
    assert.equal(red.rows.filter((z) => /First choice/.test(z)).length, 0, 'RED: the old client does not find the why entry');

    const titleNew = await searchInBrowser(base, 'penguinpath');
    const titleOld = await searchInBrowser(base, 'penguinpath', { client: oldClient });
    for (const [name, x] of [['new', titleNew], ['old', titleOld]]) {
      assert.equal(x.rows.length, 1, `positive control (${name}): the title word is found`);
      assert.match(x.rows[0], /Penguinpath/);
    }
  });
});

test('fulltext: browser — route not measurable: local fallback plus a visible notice (getComputedStyle)', { skip: REASON }, async () => {
  const r = world('fulltext-fallback-');
  await withServer(r, {}, async (base) => {
    const failing = (rt) => rt.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ measurable: false, reason: 'probe' }) });
    const title = await searchInBrowser(base, 'penguinpath', { route: failing });
    assert.equal(title.rows.length, 1, 'fallback: the local filter still finds the title word');
    assert.equal(title.notice?.visible, true, 'the notice is actually visible');
    assert.match(title.notice.text, /Full text unavailable/);
    const why = await searchInBrowser(base, 'zebrafinchcouncil', { route: failing });
    assert.equal(why.rows.filter((z) => /First choice/.test(z)).length, 0, 'in the fallback only the excerpt counts');
  });
});

test('fulltext: browser — a stale answer is dropped', { skip: REASON }, async () => {
  const r = world('fulltext-stale-');
  await withServer(r, {}, async (base) => {
    // The answer to the FIRST question arrives only after later input and
    // claims "z" hits only the decoy. It must not count.
    let n = 0;
    const decoy = idOf(r, 'Decoy');
    const x = await searchInBrowser(base, 'zebrafinchcouncil', {
      delay: 200, // slower than the debounce: every key asks its own question
      route: async (rt) => {
        n += 1;
        if (new URL(rt.request().url()).searchParams.get('q') === 'z') {
          await new Promise((res) => setTimeout(res, 600));
          return rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ids: [decoy], measurable: true }) });
        }
        return rt.continue();
      },
    });
    assert.ok(n >= 3, 'several questions went out (positive control: the probe sees the intermediate requests)');
    assert.equal(x.rows.length, 1);
    assert.match(x.rows[0], /First choice/, 'only the answer to the current input counts');
  });
});
