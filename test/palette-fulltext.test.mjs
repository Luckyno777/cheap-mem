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
// The search is a fragment from the middle of a word: the old palette finds the entry neither in the
// excerpt nor via the ranked search (word search), the full text finds it as a substring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startBrowser, waitReady } from './fixture/browser.mjs';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD_STATE = '0accc86b319cb11c2df0af15b35a905492b62ae2';
const old = (file) => execFileSync('git', ['-C', REPO, 'show', `${OLD_STATE}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-fulltext-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'notes', participants: { alex: { human: true }, builder: {} }, language: 'en' }));
  const t0 = Date.parse('2026-09-01T09:00:00Z');
  let i = 0;
  const now = () => new Date(t0 + (i++) * 3600e3);
  memory.logEntry(r, 'decision', { agent: 'builder', title: 'First choice', choice: 'Variant A', why: 'because the zebrafinchcouncil wanted it' }, { now: now() });
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Penguinpath in the title', text: 'Short.' }, { now: now() });
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Decoy', text: 'None of it is here.' }, { now: now() });
  return r;
}

test('palette-fulltext: the fixed old state filters only `_s`; now it asks through fulltextAsk', () => {
  assert.ok(!/fulltextAsk\(fulltextPalette\)/.test(old('assets/dashboard/dashboard.js')));
  const n = fs.readFileSync(path.join(REPO, 'assets/dashboard/dashboard.js'), 'utf8');
  assert.ok(/fulltextAsk\(fulltextPalette\)/.test(n));
  assert.equal((n.match(/\/api\/fulltext/g) || []).length, 1, 'one path, no second request');
});

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

async function paletteSearch(base, typed, { client = null, route = null, delay = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    if (client) await page.route('**/dashboard/app.js*', (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
    if (route) await page.route('**/api/fulltext*', route);
    await page.goto(base + '/dashboard', { waitUntil: 'load' }); // never networkidle
    await waitReady(page);
    // Unter Last kann der Tastendruck vor dem Handler ankommen: erneut druecken, bis das Feld den Fokus hat.
    let offen = false;
    for (let i = 0; i < 6 && !offen; i++) {
      await page.keyboard.press('Control+k');
      offen = await page.waitForFunction(() => document.activeElement?.id === 'commandInput', null, { timeout: 5000 }).then(() => true, () => false);
    }
    assert.ok(offen, 'die Palette oeffnet sich');
    await page.keyboard.type(typed, { delay });
    await page.waitForTimeout(900);
    return await page.evaluate(() => ({
      hits: [...document.querySelectorAll('#commandResults [data-search-entry]')].map((b) => b.textContent),
      focus: document.activeElement?.id,
      value: document.getElementById('commandInput')?.value,
      notice: (() => {
        const h = document.getElementById('fulltextNoticePalette');
        if (!h) return null;
        const cs = getComputedStyle(h);
        return { visible: cs.display !== 'none' && cs.visibility !== 'hidden' && h.getClientRects().length > 0, text: h.textContent };
      })(),
    }));
  } finally {
    await page.close();
  }
}

test('palette-fulltext: browser — why word GREEN with the new client, RED with 0accc86; title word in both', { skip: REASON }, async () => {
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

test('palette-fulltext: browser — route not measurable: title word still found, notice visible', { skip: REASON }, async () => {
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

test('palette-fulltext: browser — a stale answer is dropped', { skip: REASON }, async () => {
  const r = world();
  await withServer(r, {}, async (base) => {
    let n = 0;
    const x = await paletteSearch(base, 'brafinchcounc', {
      delay: 200,
      route: async (rt) => {
        n += 1;
        if (new URL(rt.request().url()).searchParams.get('q') === 'z') {
          await new Promise((res) => setTimeout(res, 600));
          return rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ids: ['doesnotexist'], measurable: true }) });
        }
        return rt.continue();
      },
    });
    assert.ok(n >= 3, 'positive control: the probe sees the intermediate requests');
    assert.equal(x.hits.filter((z) => /First choice/.test(z)).length, 1, 'only the answer to the current input counts');
  });
});
