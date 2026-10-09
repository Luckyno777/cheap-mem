// test/palette-fulltext.test.mjs — the quick search (Ctrl+K) uses the full text (2026-09-29).
//
// Before, the command palette filtered only the excerpt `e._s`; a word only in
// `why` was not found although the knowledge-room field finds it since the
// full-text build. Now it asks through the same client function `fulltextAsk()`
// (debounce, dropping stale answers, fallback notice).
//
// RED proof against the FIXED commit 0accc86 (agent frame 12): the client from there
// (served via page.route) does NOT find the why word in the palette, the current one does.
// Positive control: a title word is found in both states. Visibility only via getComputedStyle.
//
// 2026-10-09 (palette-typeerror-cm, mirrors lucky-mem): with a substring hit the ranked search ("like mem find")
// never appeared — `paletteMemorySearch` mapped the local hits to ids and then mapped the ids AGAIN
// (`e.id || e.dataset.searchEntry` on a string): "TypeError: Cannot read properties of undefined (reading
// 'searchEntry')". The probes below ran green next to it because only the hit list was read; since then the
// file turns every uncaught page exception red (`lazyBrowser({ pageerror: true })`).
// The search is a fragment from the middle of a word: the old palette finds the entry neither in the
// excerpt nor via the ranked search (word search), the full text finds it as a substring.
/* global document, fulltextPalette, getComputedStyle -- these run inside the page (browser), not in Node */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { lazyBrowser, browserStartProbe, waitReady, startView } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD_STATE = '0accc86b319cb11c2df0af15b35a905492b62ae2';
// FIXED commit (never `merge-base`: that one moves with the merge) = the state BEFORE the TypeError fix.
const BEFORE_TYPEERROR = '77a535876050ebacd6a1e729fca878e78b1398d2';
const oldBeforeFix = (file) => execFileSync('git', ['-C', REPO, 'show', `${BEFORE_TYPEERROR}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const old = (file) => execFileSync('git', ['-C', REPO, 'show', `${OLD_STATE}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Every world is removed once, in after() (waits for a background rebuild first).
const ROOTS = [];
after(() => { for (const r of ROOTS) removeTree(r); });
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-fulltext-'));
  ROOTS.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'notes', participants: { alex: { human: true }, builder: {} }, language: 'en' }));
  const t0 = Date.parse('2026-09-01T09:00:00Z');
  let i = 0;
  const now = () => new Date(t0 + (i++) * 3600e3);
  memory.logEntry(r, 'decision', { agent: 'builder', title: 'First choice', choice: 'Variant A', why: 'because the zebrafinchcouncil wanted it' }, { now: now() });
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Penguinpath in the title', text: 'Short.' }, { now: now() });
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Decoy', text: 'None of it is here.' }, { now: now() });
  // Ranked search: 'sealcalls' is a substring of the first title only (a local hit); the second one is found only by
  // the word-stem search ("like mem find"), which is what the ranked block must show.
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Sealcalls today', text: 'Heard near the pier.' }, { now: now() });
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Sealcall noted', text: 'Logged in the evening.' }, { now: now() });
  return r;
}

test('palette-fulltext: the fixed old state filters only `_s`; now it asks through fulltextAsk', () => {
  assert.ok(!/fulltextAsk\(fulltextPalette\)/.test(old('assets/dashboard/dashboard.js')));
  const n = fs.readFileSync(path.join(REPO, 'assets/dashboard/dashboard.js'), 'utf8');
  assert.ok(/fulltextAsk\(fulltextPalette\)/.test(n));
  assert.equal((n.match(/\/api\/fulltext/g) || []).length, 1, 'one path, no second request');
});

// The browser starts on first use, not by a top-level await (a throwing start is a named red probe).
const B = lazyBrowser({ pageerror: true }); // an uncaught exception in the page turns the probe red (fixture/browser.mjs)
browserStartProbe(B);

async function withServer(r, env, run) {
  const view = await startView(r, {
    ...process.env, CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0',
    CHEAP_MEM_SERVE_TOKEN: '', ...env,
  });
  try {
    return await run(view.base);
  } finally {
    await view.stop();
  }
}

async function paletteSearch(base, typed, { client = null, route = null, delay = 0, settle = null, ranked = false } = {}) {
  const { browser } = await B.get();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; // what the page threw (the fixture guard also reports it when the probe ends)
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  try {
    if (client) await page.route('**/dashboard/app.js*', (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
    if (route) await page.route('**/api/fulltext*', (rt) => route(rt, page));
    await page.goto(base + '/dashboard', { waitUntil: 'load' }); // never networkidle
    await waitReady(page);
    // Under load the key press can arrive before the handler: press again until the field has focus.
    let open = false;
    for (let i = 0; i < 6 && !open; i++) {
      await page.keyboard.press('Control+k');
      open = await page.waitForFunction(() => document.activeElement?.id === 'commandInput', null, { timeout: 5000 }).then(() => true, () => false);
    }
    assert.ok(open, 'the palette opens');
    // No fixed wait (900 ms was not enough under a full suite, chain red
    // 2026-09-30): wait for the full-text answer to the LAST input, then
    // one paint tick. The old client never asks — there the cap runs out,
    // and the result is what it shows without full text.
    const answer = page.waitForResponse((r) => r.url().includes('/api/fulltext') && new URL(r.url()).searchParams.get('q') === typed, { timeout: 8000 }).catch(() => null);
    await page.keyboard.type(typed, { delay });
    await answer;
    if (settle) await settle(page);
    // The ranked block: wait for its heading (cap 5 s) — the broken client never draws it.
    if (ranked) await page.waitForFunction(() => document.querySelector('#commandMemory .label'), null, { timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(300);
    // With a failing route: wait for the VISIBLE notice (cap 5 s) — 300 ms
    // after the 500 answer was not enough under a full suite (2026-09-30).
    if (route) {
      await page.waitForFunction(() => { const h = document.getElementById('fulltextNoticePalette'); if (!h) return false; const cs = getComputedStyle(h); return cs.display !== 'none' && cs.visibility !== 'hidden' && h.getClientRects().length > 0; }, null, { timeout: 5000 }).catch(() => null);
    }
    return await page.evaluate(() => ({
      hits: [...document.querySelectorAll('#commandResults > [data-search-entry]')].map((b) => b.textContent),
      rankedHeading: document.querySelector('#commandMemory .label')?.textContent ?? null,
      rankedHits: [...document.querySelectorAll('#commandMemory [data-search-entry]')].map((b) => b.textContent),
      focus: document.activeElement?.id,
      value: document.getElementById('commandInput')?.value,
      notice: (() => {
        const h = document.getElementById('fulltextNoticePalette');
        if (!h) return null;
        const cs = getComputedStyle(h);
        return { visible: cs.display !== 'none' && cs.visibility !== 'hidden' && h.getClientRects().length > 0, text: h.textContent };
      })(),
    })).then((x) => ({ ...x, errors }));
  } finally {
    await page.close();
  }
}

test('palette-fulltext: browser — why word GREEN with the new client, RED with 0accc86; title word in both', async (t) => {
  if (!(await B.need(t))) return;
  const r = world();
  await withServer(r, {}, async (base) => {
    const fresh = await paletteSearch(base, 'brafinchcounc');
    assert.equal(fresh.hits.filter((z) => /First choice/.test(z)).length, 1, 'new: palette finds the why entry');
    assert.equal(fresh.focus, 'commandInput');
    assert.equal(fresh.value, 'brafinchcounc');
    assert.equal(fresh.notice, null);
    const oldClient = old('assets/dashboard/dashboard.js');
    const red = await paletteSearch(base, 'brafinchcounc', { client: oldClient });
    assert.equal(red.hits.filter((z) => /First choice/.test(z)).length, 0, 'RED: the old client does not find it in the palette');
    for (const [name, opt] of [['new', {}], ['old', { client: oldClient }]]) {
      const x = await paletteSearch(base, 'penguinpath', opt);
      assert.equal(x.hits.filter((z) => /Penguinpath/.test(z)).length, 1, `positive control (${name}): title word`);
    }
  });
});

test('palette-fulltext: browser — route not measurable: title word still found, notice visible', async (t) => {
  if (!(await B.need(t))) return;
  const r = world();
  await withServer(r, {}, async (base) => {
    const fail = (rt) => rt.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ measurable: false, reason: 'probe' }) });
    const t = await paletteSearch(base, 'penguinpath', { route: fail });
    assert.equal(t.hits.filter((z) => /Penguinpath/.test(z)).length, 1);
    assert.equal(t.notice?.visible, true);
    assert.match(t.notice.text, /Full text unavailable/);
    const z = await paletteSearch(base, 'brafinchcounc', { route: fail });
    assert.equal(z.hits.filter((x) => /First choice/.test(x)).length, 0, 'in fallback only the excerpt counts');
  });
});

// The product guard that drops a stale answer (one line in `fulltextAsk`). The mutant removes it; the probe below
// must turn red on it (positive control: the probe really bites).
const STALE_GUARD = '    if (run !== source.run || q !== source.current()) return;\n    if (b.expired) { fulltextAsk(source); return; }';
const withoutStaleGuard = (js) => {
  assert.equal(js.split(STALE_GUARD).length - 1, 1, 'the stale guard stands exactly once in the product');
  return js.replace(STALE_GUARD, '    if (b.expired) { fulltextAsk(source); return; }');
};

// The FIRST really sent intermediate question (a true prefix of the input, typed slower than the debounce) is held
// until the answer to the whole input has been applied in the page; only then does the late answer arrive. An answer
// that would be applied now overwrites the mark and the hit disappears.
async function staleRun(base, typed, client) {
  const held = { q: null, arrived: false };
  const x = await paletteSearch(base, typed, {
    delay: 300, // longer than FULLTEXT_DEBOUNCE_MS (150): every prefix is really sent
    client,
    route: (rt, page) => {
      const q = new URL(rt.request().url()).searchParams.get('q');
      if (held.q === null && q !== typed && typed.startsWith(q)) {
        held.q = q;
        held.done = (async () => {
          await page.waitForFunction((full) => fulltextPalette.q === full, typed, { timeout: 15000 });
          const arrived = page.waitForResponse((r) => r.url().includes('/api/fulltext') && new URL(r.url()).searchParams.get('q') === q, { timeout: 5000 }).then(() => true, () => false);
          await rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ids: ['doesnotexist'], measurable: true }) });
          held.arrived = await arrived;
        })();
        return held.done;
      }
      return rt.continue();
    },
    settle: async () => { if (held.done) await held.done; },
  });
  return { held, x };
}

test('palette-fulltext: browser — a stale answer is dropped', async (t) => {
  if (!(await B.need(t))) return;
  const r = world();
  await withServer(r, {}, async (base) => {
    const { held, x } = await staleRun(base, 'brafinchcounc');
    assert.ok(held.q && 'brafinchcounc'.startsWith(held.q), `positive control: an intermediate question ('${held.q}') was really sent and held`);
    assert.equal(held.arrived, true, 'positive control: the late answer reached the page');
    assert.equal(x.hits.filter((z) => /First choice/.test(z)).length, 1, 'only the answer to the current input counts');
    assert.deepEqual(x.errors, []);
  });
});

test('palette-fulltext: browser — a stale answer without the product guard turns the probe RED (positive control)', async (t) => {
  if (!(await B.need(t))) return;
  const r = world();
  const mutant = withoutStaleGuard(fs.readFileSync(path.join(REPO, 'assets/dashboard/dashboard.js'), 'utf8'));
  await withServer(r, {}, async (base) => {
    const { held, x } = await staleRun(base, 'brafinchcounc', mutant);
    assert.equal(held.arrived, true, 'the late answer reached the page');
    assert.equal(x.hits.filter((z) => /First choice/.test(z)).length, 0, 'RED: without the guard the late answer overwrites the mark and the hit is gone');
  });
});

test('palette-fulltext: browser — a substring hit AND the ranked search ("like mem find"), no page error', async (t) => {
  if (!(await B.need(t))) return;
  const r = world();
  await withServer(r, {}, async (base) => {
    const x = await paletteSearch(base, 'sealcalls', { ranked: true });
    assert.deepEqual(x.errors, [], 'the page threw nothing');
    assert.equal(x.hits.filter((z) => /Sealcalls today/.test(z)).length, 1, 'the substring hit stands above');
    assert.match(x.rankedHeading || '', /Ranked search in the memory/, 'the ranked search appears');
    assert.equal(x.rankedHits.filter((z) => /Sealcall noted/.test(z)).length, 1, 'the ranked-only hit stands in it');
    assert.equal(x.rankedHits.filter((z) => /Sealcalls today/.test(z)).length, 0, 'the local hit is not shown twice');
  });
});

test('palette-fulltext: browser — RED side of the same probe against the fixed state before the fix (TypeError, no ranked search)', async (t) => {
  if (!(await B.need(t))) return;
  B.allow(t, { allowed: /reading 'searchEntry'/, reason: 'the pinned old client is the broken one on purpose' });
  const r = world();
  await withServer(r, {}, async (base) => {
    const x = await paletteSearch(base, 'sealcalls', { client: oldBeforeFix('assets/dashboard/dashboard.js'), ranked: true });
    assert.equal(x.hits.filter((z) => /Sealcalls today/.test(z)).length, 1, 'positive control: the local hit is there in the old state too');
    assert.ok(x.errors.some((e) => /reading 'searchEntry'/.test(e)), `RED: the old client throws the TypeError (${x.errors.join(' | ')})`);
    assert.equal(x.rankedHeading, null, 'RED: the old client never draws the ranked search');
  });
});
