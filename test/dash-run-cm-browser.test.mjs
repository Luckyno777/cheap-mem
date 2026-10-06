// test/dash-run-cm-browser.test.mjs — F18, F19, F20 of the audit of 2026-10-06 in a real Chromium
// (the sibling's test/dash-lauf-lm-browser.test.mjs).
//
// F18: a late message/dashboard run A must not overwrite the newer selection B.
// F19: when the state of the entry list keeps changing, loading ends bounded and with a visible
//      notice (button "Load again"), not in an endless loop; one click fetches the list afterwards.
// F20: atlas — an error does not stay stuck (button "Try again"), and a store that is permanently
//      being built ends with a message instead of an empty apparent success.
// The answers of the part routes are controlled through page.route; server, page and context are
// torn down in finally (cm lesson of 2026-10-06: a probe hung for 2 h because the page open sat outside try).
// Red proof: the scenario also runs against the dashboard.js of the FIXED old state 4bbca61 (git show,
// played in through page.route as /dashboard/app.js) and must show the old fault there.
// Screenshots (1920/390, dark/light, overflow measured) only with DASH_RUN_IMAGES=<folder>.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startBrowser, waitReady } from './fixture/browser.mjs';
import * as inbox from '../src/inbox.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const OLD = '4bbca61';
const IMAGES = process.env.DASH_RUN_IMAGES || null;
const TAGS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const { browser, reason } = await startBrowser();
const SKIP = reason;
let oldScript = null;
try { oldScript = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { /* no history: the red probes skip */ }
const NO_OLD = oldScript ? false : 'old state not available in this checkout';

const PARTICIPANTS = { alex: { human: true }, bot: {} };
function world({ n, textLength = 20, messages = 0 }) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dashrun-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'dashrun', participants: PARTICIPANTS, language: 'en' }));
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(JSON.stringify({
      id: `dr${String(i).padStart(6, '0')}`, ts: new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString(),
      title: `Probe entry ${i}`, text: 'x'.repeat(textLength), tags: [TAGS[i % TAGS.length], TAGS[(i * 3) % TAGS.length]],
    }));
  }
  fs.writeFileSync(path.join(r, 'global', 'learnings.jsonl'), `${rows.join('\n')}\n`);
  for (let i = 0; i < messages; i += 1) {
    inbox.write(r, PARTICIPANTS, { from: 'bot', to: 'alex', subject: `Message ${'AB'[i] || i}`, text: `Text ${i}`, now: new Date(Date.parse('2026-10-03T10:00:00Z') + i * 60000) });
  }
  return r;
}

// Opens the page of a real server; everything that was opened is torn down in finally.
async function withPage(root, { script = null, env = {} } = {}, fn) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', MEM_RECALL_SERVER: '0',
    CHEAP_MEM_SERVE_TEMPO_TEST_MS: '5', ...env,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let ctx = null;
  try {
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('cm-dash-light', '0'); } catch { /* without storage */ } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (script) await page.route(/\/dashboard\/app\.js(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: script }));
    await fn(page, base, errors);
  } finally {
    await ctx?.close().catch(() => {});
    await new Promise((res) => { server.closeAllConnections?.(); server.close(res); });
  }
}

// Screenshots at 1920 and 390, dark and light, with the sideways overflow measured (cap 1 px).
async function shots(page, name, focus = null) {
  if (!IMAGES) return;
  fs.mkdirSync(IMAGES, { recursive: true });
  for (const [width, height] of [[1920, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const light of [false, true]) {
      await page.evaluate((l) => { document.body.classList.toggle('light', l); }, light);
      if (focus) await page.locator(focus).first().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(250);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 1, `sideways overflow ${over}px at ${width} ${light ? 'light' : 'dark'}`);
      await page.screenshot({ path: path.join(IMAGES, `${name}-${width}-${light ? 'light' : 'dark'}.png`) });
    }
  }
  await page.setViewportSize({ width: 1400, height: 900 });
}

const release = (rt) => rt.continue().catch(() => {});

// ---------------------------------------------------------------- F18
// Returns what the page shows after the late answer A arrived: { title, probe }.
async function scenarioF18(page, base, { images = null } = {}) {
  const held = { name: '', route: null };
  await page.route('**/dashboard/message.json?name=*', (rt) => {
    const name = decodeURIComponent(new URL(rt.request().url()).searchParams.get('name'));
    if (held.name && held.name === name) held.route = rt; else release(rt);
  });
  await page.goto(`${base}/dashboard#work/inbox`, { waitUntil: 'load' });
  await waitReady(page);
  await page.waitForFunction(() => typeof messages !== 'undefined' && messages.length >= 2);
  const names = await page.evaluate(() => messages.map((m) => [m.name, m.subject]));
  const [a] = names.find(([, s]) => s === 'Message A');
  const [b] = names.find(([, s]) => s === 'Message B');
  held.name = a;
  await page.locator(`[data-action="message"][data-id="${a}"]`).first().click();
  await page.waitForFunction(() => /Message A/.test(document.querySelector('#infoTitle')?.textContent || ''));
  await page.waitForFunction(() => document.querySelector('#info .loading'), null, { timeout: 5000 });
  for (let i = 0; i < 100 && !held.route; i += 1) await page.waitForTimeout(50);
  assert.ok(held.route, 'positive control: the request for A is held');
  await page.keyboard.press('Escape'); // close A while its answer is pending
  await page.waitForFunction(() => !document.querySelector('#info').open);
  held.name = '';
  await page.locator(`[data-action="message"][data-id="${b}"]`).first().click();
  await page.waitForFunction(() => /Store the reply/.test(document.querySelector('#info')?.textContent || '') && /Message B/.test(document.querySelector('#infoTitle')?.textContent || ''));
  await release(held.route); // the late answer A arrives
  await page.waitForTimeout(700);
  const title = await page.evaluate(() => document.querySelector('#infoTitle').textContent);
  if (images) await shots(page, images);

  // loadData: two runs, the older one answers last, with a marker
  await page.keyboard.press('Escape');
  const holds = [];
  await page.route('**/dashboard.json', (rt) => { holds.push(rt); });
  await page.evaluate(() => { window.__p = [loadData({ quiet: true }), loadData({ quiet: true })]; return true; });
  for (let i = 0; i < 100 && holds.length < 1; i += 1) await page.waitForTimeout(50);
  const mark = async (rt, marker) => {
    try { const ans = await rt.fetch(); const body = await ans.json(); body.__probe = marker; await rt.fulfill({ response: ans, json: body }); } catch { /* an aborted request cannot be answered */ }
  };
  if (holds.length >= 2) { await mark(holds[1], 'B'); await page.waitForTimeout(200); await mark(holds[0], 'A'); } else { await mark(holds[0], 'B'); }
  await page.waitForTimeout(500);
  const probe = await page.evaluate(() => D.__probe);
  return { title, probe };
}

test('F18: message A late, message B selected -> B stays visible; likewise loadData', { skip: SKIP, timeout: 300000 }, async () => {
  await withPage(world({ n: 30, messages: 2 }), {}, async (page, base, errors) => {
    const r = await scenarioF18(page, base, { images: 'f18-message-after' });
    assert.equal(r.title, 'Message B', 'the late answer A overwrote message B');
    assert.equal(r.probe, 'B', 'the older loadData run overwrote the newer state: ' + r.probe);
    assert.deepEqual(errors, []);
  });
});

test(`F18 RED on the fixed old state (${OLD}): the late answer A overwrites B (positive control: the same scenario is green on the new state)`, { skip: SKIP || NO_OLD, timeout: 300000 }, async () => {
  await withPage(world({ n: 30, messages: 2 }), { script: oldScript }, async (page, base) => {
    const r = await scenarioF18(page, base, { images: 'f18-message-before' });
    assert.ok(r.title !== 'Message B' || r.probe !== 'B', `the old state showed no fault (${JSON.stringify(r)}) — the probe would not catch it`);
  });
});

// ---------------------------------------------------------------- F19
// The state of the entry list changes on every second page. `images` names the screenshots; `old` waits
// for the end of the endless fixture instead of for the visible notice (the old state has none).
async function scenarioF19(page, base, { images = null, old = false } = {}) {
  let mode = 'change';
  let n = 0;
  const row = (i) => ({ id: 'fake-' + i, ts: '2026-09-01T00:00:00Z', title: 'Probe ' + i, text: 't', tags: [], agent: 'probe', type: 'learning', project: 'global', readable: true });
  await page.route('**/dashboard/part.json?part=entries*', (rt) => {
    n += 1;
    if (mode === 'stable') return rt.fulfill({ json: { state: 'ok', part: 'entries', data: [row(1), row(2)], state_id: 'fixed', next: null, total: 2, window: false } });
    // old state: endless; the probe ends it itself after 400 requests
    return rt.fulfill({ json: { state: 'ok', part: 'entries', data: [row(n)], state_id: n % 2, next: n > 400 ? null : 1, total: 400, window: false } });
  });
  await page.goto(`${base}/dashboard#home`, { waitUntil: 'load' });
  await waitReady(page);
  if (old) await page.waitForFunction(() => document.querySelector('#entriesLoad') !== null, null, { timeout: 30000 }).catch(() => {});
  else await page.waitForSelector('#entriesDisturbance', { timeout: 30000 });
  if (old) for (let i = 0; i < 200 && n <= 400; i += 1) await page.waitForTimeout(100);
  const asked = n;
  const text = await page.evaluate(() => document.querySelector('#entriesDisturbance')?.textContent || '');
  const mixed = await page.evaluate(() => entries.filter((e) => e.id.startsWith('fake-')).length);
  if (images) await shots(page, images, '#entriesDisturbance, #entriesLoad');
  return { asked, text, mixed, setStable: () => { mode = 'stable'; } };
}

test('F19: the state changes on every second page -> bounded, visible notice, one click fetches the list', { skip: SKIP, timeout: 300000 }, async () => {
  await withPage(world({ n: 400 }), {}, async (page, base, errors) => {
    const r = await scenarioF19(page, base, { images: 'f19-entries-after' });
    assert.ok(r.asked >= 2, 'positive control: the page asks for the entry list');
    assert.ok(r.asked <= 40, `requests ${r.asked} (old state: until the fixture ends)`);
    assert.match(r.text, /changing/, 'visible end state: ' + r.text);
    assert.match(r.text, /Load again/, 'the notice carries the button');
    assert.equal(r.mixed, 0, 'no mixed list was taken over as the state');
    r.setStable();
    await page.locator('#entriesDisturbance [data-action="reload"]').click();
    await page.waitForFunction(() => !document.querySelector('#entriesDisturbance') && entries.length === 2 && entries.every((e) => e.id.startsWith('fake-')), null, { timeout: 30000 });
    assert.deepEqual(errors, []);
  });
});

test(`F19 RED on the fixed old state (${OLD}): the loop runs until the fixture ends, no notice (positive control: green on the new state)`, { skip: SKIP || NO_OLD, timeout: 300000 }, async () => {
  await withPage(world({ n: 400 }), { script: oldScript }, async (page, base) => {
    const r = await scenarioF19(page, base, { images: 'f19-entries-before', old: true });
    assert.ok(r.asked > 40, `the old state asked only ${r.asked} times — the probe would not catch the endless loop`);
    assert.equal(r.text, '', 'the old state shows no notice');
  });
});
