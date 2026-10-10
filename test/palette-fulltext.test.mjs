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
//
// 2026-10-10 (job fresh-cm; mirrors lucky-mem de69a930 / report palette-wettlauf-lm): the chain flake "new: palette finds
// the why entry 0 !== 1" (first browser probe) was a race of the probe's READINESS. `waitReady` is true when the loading
// tile is gone; the page builds the 3-D network (`initGraph`) one frame LATER and holds its main thread meanwhile (1-3 s
// quiet, 35-45 s under load). A probe that typed in the gap finished typing before the page could serve its debounce and
// its request, and the 8 s deadline of `waitForResponse` (which also started BEFORE the typing) ran out: no answer, 0 hits.
// Now: `waitGraph` first (the build is through before anything is typed), the answer is recognised by the page's own
// state (`fulltextPalette.q` is the typed text, set only when an answer to the CURRENT input was applied), the deadline
// counts from AFTER the typing, and the fixed 300 ms wait is gone. Probe "race" pins the order of events with an
// emulation (positive control: the build really began; old readiness RED, `waitGraph` GREEN).
/* global document, window, requestAnimationFrame, fulltextPalette, getComputedStyle -- these run inside the page (browser), not in Node */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { lazyBrowser, browserStartProbe, waitReady, waitGraph, startView } from './fixture/browser.mjs';
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

// The emulated race (see waitGraph in test/fixture/browser.mjs): the start page's network build (`initGraph`, deferred in
// render() by requestAnimationFrame + setTimeout 0) is HELD and begins LATE: as soon as the input has `chars` characters,
// else after `start` ms (the fallback is for probes that do not type before the network: waitGraph waits for it). It then
// holds the page's main thread for `stall` ms (software GL under load: measured 35-45 s). Holding makes the order "typed
// first, build after" compulsory; in the chain it was chance.
async function emulateLateNetwork(page, { start, stall, chars }) {
  await page.addInitScript(([s0, s1, z]) => {
    const st = window.setTimeout.bind(window);
    const raf = window.requestAnimationFrame.bind(window);
    let release = null, typedEnough = false;
    const go = () => { if (!release) return; const f = release; release = null; st(f, 0); };
    window.requestAnimationFrame = (f) => {
      if (typeof f === 'function' && String(f).includes('initGraph')) {
        release = () => { window.__stallBegan = true; const e = performance.now() + s1; while (performance.now() < e); raf(f); };
        if (typedEnough) go(); else st(go, s0);
        return 0;
      }
      return raf(f);
    };
    document.addEventListener('input', (ev) => { if ((ev.target?.value || '').length >= z) { typedEnough = true; go(); } }, true);
  }, [start, stall, chars]);
}

// The answer to EXACTLY this input has arrived in the page AND been applied: `fulltextPalette.q` is set only when an answer
// to the current input was processed (reset when the field is emptied), and `redrawPalette()` follows in the same call. A state
// of the page instead of a network event: it stays, so there is no race between "the answer came" and "the probe waits already".
const answerApplied = (page, typed, ms) => page.waitForFunction((q) => fulltextPalette.q === q, typed, { timeout: ms, polling: 50 }).then(() => true, () => false);

async function paletteSearch(base, typed, { client = null, route = null, delay = 0, settle = null, ranked = false, network = true, emulate = null } = {}) {
  const { browser } = await B.get();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; // what the page threw (the fixture guard also reports it when the probe ends)
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  try {
    if (client) await page.route('**/dashboard/app.js*', (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
    if (route) await page.route('**/api/fulltext*', (rt) => route(rt, page));
    if (emulate) await emulateLateNetwork(page, emulate);
    await page.goto(base + '/dashboard', { waitUntil: 'load' }); // never networkidle
    await waitReady(page);
    // Race (chain 2026-10-10, "0 !== 1"): "ready" only means the loading tile is gone. The page builds the 3-D network one
    // frame LATER and holds its main thread for 1-3 s, under load 35-45 s; whoever types before has its debounce and its
    // request standing until every deadline below has run out. `network: false` is the old readiness (race probe only).
    if (network) await waitGraph(page);
    // Under load the key press can arrive before the handler: press again until the field has focus.
    let open = false;
    for (let i = 0; i < 6 && !open; i++) {
      await page.keyboard.press('Control+k');
      open = await page.waitForFunction(() => document.activeElement?.id === 'commandInput', null, { timeout: 5000 }).then(() => true, () => false);
    }
    assert.ok(open, 'the palette opens');
    // No fixed wait (900 ms was not enough under a full suite, chain red 2026-09-30): wait for the answer to the LAST
    // input (`answerApplied`; deadline 20 s counted AFTER the typing, the typing itself does not belong in the deadline
    // of the answer). The old client has no `fulltextPalette` and never asks: nothing to wait for, all inputs are
    // processed after two frames and a timer round, and the result is what it shows without full text.
    // The two probes with `settle` (stale answers) synchronise on the late answer themselves and keep the event of
    // the final response plus one paint tick.
    const answer = settle ? page.waitForResponse((r) => r.url().includes('/api/fulltext') && new URL(r.url()).searchParams.get('q') === typed, { timeout: 8000 }).catch(() => null) : null;
    const asked = [];
    page.on('request', (r) => { if (r.url().includes('/api/fulltext')) asked.push(r.url()); });
    await page.keyboard.type(typed, { delay });
    let answered = null; // diagnosis: was the answer to the last input applied? (null: old client / settle probes)
    if (settle) { await answer; await settle(page); await page.waitForTimeout(300); }
    else if (client) await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok, 0)))));
    else answered = await answerApplied(page, typed, emulate ? emulate.deadlineAfterTyping : 20000);
    // The ranked block: wait for its heading (cap 5 s) — the broken client never draws it.
    if (ranked) await page.waitForFunction(() => document.querySelector('#commandMemory .label'), null, { timeout: 5000 }).catch(() => null);
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
      empty: /Nothing found/.test(document.getElementById('commandResults')?.textContent || ''), // the input was processed and the result is empty
      stallBegan: window.__stallBegan === true,
      notice: (() => {
        const h = document.getElementById('fulltextNoticePalette');
        if (!h) return null;
        const cs = getComputedStyle(h);
        return { visible: cs.display !== 'none' && cs.visibility !== 'hidden' && h.getClientRects().length > 0, text: h.textContent };
      })(),
    })).then((x) => ({ ...x, errors, answered, asked: asked.length }));
  } finally {
    await page.close();
  }
}

test('palette-fulltext: browser — why word GREEN with the new client, RED with 0accc86; title word in both', async (t) => {
  if (!(await B.need(t))) return;
  const r = world();
  await withServer(r, {}, async (base) => {
    const fresh = await paletteSearch(base, 'brafinchcounc');
    assert.equal(fresh.hits.filter((z) => /First choice/.test(z)).length, 1, `new: palette finds the why entry (diagnosis: answer applied ${fresh.answered}, ${fresh.asked} questions, ${fresh.hits.length} hits, field '${fresh.value}')`);
    assert.equal(fresh.focus, 'commandInput');
    assert.equal(fresh.value, 'brafinchcounc');
    assert.equal(fresh.notice, null);
    const oldClient = old('assets/dashboard/dashboard.js');
    const red = await paletteSearch(base, 'brafinchcounc', { client: oldClient });
    assert.equal(red.hits.filter((z) => /First choice/.test(z)).length, 0, 'RED: the old client does not find it in the palette');
    // The RED side must not be red "by chance" because the input was not processed yet: the palette shows its empty
    // result ("Nothing found") for exactly this input, and the field holds the whole word.
    assert.equal(red.value, 'brafinchcounc', 'RED: the input is complete in the field');
    assert.equal(red.empty, true, 'RED: the palette processed the input and shows "Nothing found" (not: nothing has happened yet)');
    assert.equal(red.asked, 0, 'the old client never asks the full text (so there is nothing to wait for)');
    assert.ok(fresh.asked >= 1, 'positive control: the new client asks the full text');
    for (const [name, opt] of [['new', {}], ['old', { client: oldClient }]]) {
      const x = await paletteSearch(base, 'penguinpath', opt);
      assert.equal(x.hits.filter((z) => /Penguinpath/.test(z)).length, 1, `positive control (${name}): title word`);
    }
  });
});

// RED proof of the race (job fresh-cm, 2026-10-10; mirrors lucky-mem's probe "Wettlauf"). The chain saw "new: palette finds
// the why entry 0 !== 1": the probe had finished typing, the page had begun its 3-D network build only AFTERWARDS and held
// its main thread (debounce, request) beyond every deadline. Here with the emulation, deterministic: the build begins as
// soon as the last character stands in the field and lasts STALL ms; the deadline after the typing is shorter than the build.
//   OLD readiness (`waitReady` only): the answer is not applied within the deadline - RED.
//   NEW readiness (`waitGraph`):       the build is through BEFORE the typing; the answer comes - GREEN.
// Positive control: in both cases the build really began (`stallBegan`) - the emulation bites. The numbers are scaled down
// (real: deadline 20 s, build 35-45 s); they do not change the order of the events.
const STALL_MS = 6000, DEADLINE_AFTER_TYPING_MS = 2500;
test('palette-fulltext: browser — race: a long network build after the typing: old readiness RED, with waitGraph GREEN', async (t) => {
  if (!(await B.need(t))) return;
  const r = world();
  await withServer(r, {}, async (base) => {
    // old: the build begins ONLY with the last character (a fallback after `start` would be too early under load);
    // new: types only after the build, so it may begin at once.
    const old = await paletteSearch(base, 'brafinchcounc', { network: false, emulate: { start: 10 * 60 * 1000, stall: STALL_MS, chars: 13, deadlineAfterTyping: DEADLINE_AFTER_TYPING_MS } });
    assert.equal(old.stallBegan, true, 'positive control (old): the network build began - the emulation bites');
    assert.equal(old.answered, false, 'RED: without waitGraph the answer is not applied within the deadline after the typing (page in the network build)');
    const now = await paletteSearch(base, 'brafinchcounc', { network: true, emulate: { start: 300, stall: STALL_MS, chars: 13, deadlineAfterTyping: DEADLINE_AFTER_TYPING_MS } });
    assert.equal(now.stallBegan, true, 'positive control (new): the network build began - the emulation bites');
    assert.equal(now.answered, true, 'GREEN: with waitGraph the build is through before the typing, the answer is applied within the deadline');
    assert.equal(now.hits.filter((z) => /First choice/.test(z)).length, 1);
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
