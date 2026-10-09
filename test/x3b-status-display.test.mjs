// X3b — the status of a rule shows in EVERY display: `mem find`, `mem show`,
// the JSON output (field `status`) and the dashboard (entry list, detail, palette).
//
// Red on the FIXED commit 201a087f2d2f634f9b061f4681bd1f78f27408be (agent frame 12):
// there find/show/dashboard show a proposed rule without a mark. The CLI probes run
// against an archive of that commit, the dashboard probe with its dashboard.js (page.route).
// Positive control: a released rule and a legacy rule look unchanged, no mark, in both states.
// The truth about the status stays ONE function (procedure.statusFor); nothing is
// recomputed here, only read back against `procedure.statusOf`.
// Visibility only through getComputedStyle, browser only through test/fixture/browser.mjs.
/* global document, location -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { startBrowser, waitReady } from './fixture/browser.mjs';
import * as procedure from '../src/procedure.mjs';
import * as memoryApi from '../src/memory.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD_STATE = '201a087f2d2f634f9b061f4681bd1f78f27408be';

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-x3b-'));
  return r;
}
const mem = (bin, r, ...argv) => spawnSync(process.execPath, [bin, '--root', r, ...argv], { encoding: 'utf8' });
const idOf = (out) => /id:\s+(\S+)/.exec(out)[1];

/** Four rules: proposed (global), trial (project), released (status line), legacy. */
function fill(r, bin) {
  const init = mem(bin, r, 'init');
  assert.equal(init.status, 0, init.stderr);
  const log = (title, extra = []) => {
    const o = mem(bin, r, 'log', 'procedure', '--title', title, '--rule', `Rule text for ${title} hummingbird`, '--issued-by', 'owner', ...extra);
    assert.equal(o.status, 0, o.stderr);
    return idOf(o.stdout);
  };
  const ids = {};
  ids.proposed = log('Quokka proposal', ['--start-as', 'proposed']);
  mem(bin, r, 'project', 'init', 'pp');
  ids.trial = log('Wombat trial', ['--project', 'pp', '--start-as', 'trial']);
  ids.released = log('Emu released', ['--start-as', 'proposed']);
  const o = mem(bin, r, 'procedures', 'status', ids.released, 'released', '--issued-by', 'owner');
  assert.equal(o.status, 0, o.stderr);
  // E4: only a rule filed BEFORE the cut-off without a status is legacy
  // (released); a rule filed today without one would be unknown.
  ids.legacy = memoryApi.logEntry(r, 'procedure', {
    title: 'Dingo legacy', rule: 'Rule text for Dingo legacy hummingbird', issued_by: 'owner', agent: 'owner',
  }, { now: new Date('2026-09-01T10:00:00Z') }).entry.id;
  return ids;
}

const MARK = { proposed: '[proposed]', trial: '[trial]' };

/** The CLI claims. On the old state they throw. */
function checkCli(bin, r, ids) {
  const lineOf = (out, title) => out.split('\n').find((l) => l.includes(title)) ?? '';
  for (const json of [false, true]) {
    for (const literal of [false, true]) {
      const args = ['find', 'hummingbird', ...(literal ? ['--literal'] : []), ...(json ? ['--json', '--brief'] : [])];
      const out = mem(bin, r, ...args).stdout;
      if (json) {
        const hits = JSON.parse(out).hits;
        const byTitle = (title) => hits.find((h) => h.label.includes(title));
        assert.equal(byTitle('Quokka proposal').status, 'proposed', `${args.join(' ')}: JSON field status`);
        assert.equal(byTitle('Wombat trial').status, 'trial', `${args.join(' ')}: JSON field status (project)`);
        assert.ok(byTitle('Quokka proposal').label.includes(MARK.proposed));
      } else {
        assert.ok(lineOf(out, 'Quokka proposal').includes(MARK.proposed), `${args.join(' ')}: mark missing (proposed)`);
        assert.ok(lineOf(out, 'Wombat trial').includes(MARK.trial), `${args.join(' ')}: mark missing (trial)`);
      }
    }
  }
  const full = JSON.parse(mem(bin, r, 'find', 'Quokka', '--json').stdout).hits.find((h) => h.entry.id === ids.proposed);
  assert.equal(full.status, 'proposed', 'find --json: field status (full)');
  const s1 = mem(bin, r, 'show', ids.proposed).stdout;
  assert.match(s1, /\[proposed\]/, 'show: mark missing');
  assert.match(s1, /status: proposed/);
  assert.equal(JSON.parse(mem(bin, r, 'show', ids.trial, '--json').stdout).status, 'trial', 'show --json: field status');
}

/** Released and legacy: the same picture as before — no mark, no field. */
function checkPositive(bin, r, ids) {
  for (const title of ['Emu released', 'Dingo legacy']) {
    for (const flag of [[], ['--literal']]) {
      const text = mem(bin, r, 'find', title, ...flag).stdout;
      assert.ok(text.includes(title), `${title} is found`);
      assert.ok(!/\[(proposed|trial|withdrawn)\]/.test(text), `${title}: no mark`);
    }
    const j = JSON.parse(mem(bin, r, 'find', title, '--json', '--brief').stdout).hits;
    assert.ok(j.length >= 1 && j.every((h) => !('status' in h)), `${title}: no field status`);
  }
  for (const id of [ids.released, ids.legacy]) {
    // E4: the raw field `start_status:` now sits in the entry, so match the
    // display line `status:` at the line start, not the field name.
    assert.ok(!/^\s*status:|\[(proposed|trial)\]/m.test(mem(bin, r, 'show', id).stdout), `show ${id}: unchanged`);
    assert.ok(!('status' in JSON.parse(mem(bin, r, 'show', id, '--json').stdout)));
  }
}

test('CLI: find/show/JSON carry the status mark, released and legacy stay unchanged', () => {
  const r = world();
  try {
    const bin = path.join(REPO, 'bin', 'mem');
    const ids = fill(r, bin);
    checkCli(bin, r, ids);
    checkPositive(bin, r, ids);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('RED: on the fixed old state find/show show the proposed rule without a mark; the positive check is green there', () => {
  const r = world();
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-x3b-old-'));
  try {
    exportCommit(REPO, OLD_STATE, ['.'], old);
    try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(old, 'node_modules')); } catch { /* no dependencies needed */ }
    const bin = path.join(old, 'bin', 'mem');
    const ids = fill(r, bin);
    assert.throws(() => checkCli(bin, r, ids), /mark missing \(proposed\)/, 'the old state must be RED');
    checkPositive(bin, r, ids); // the probe sees something: the unchanged picture is green there
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test('one function: the mark follows procedure.statusOf, there is no second calculation', () => {
  const r = world();
  try {
    const bin = path.join(REPO, 'bin', 'mem');
    const ids = fill(r, bin);
    const raw = JSON.parse(mem(bin, r, 'show', ids.trial, '--json').stdout);
    assert.equal(procedure.statusField(r, raw), 'trial');
    assert.equal(procedure.statusFor(r, raw).status, 'trial');
    assert.equal(procedure.statusFor(r, { title: 'Fact', id: 'x' }), null, 'no rule -> no status');
    assert.equal(procedure.statusField(r, JSON.parse(mem(bin, r, 'show', ids.legacy, '--json').stdout)), undefined);
    assert.equal(procedure.statusMark('released'), '');
    assert.equal(procedure.statusMark('trial'), '[trial]');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// ---- Dashboard ----------------------------------------------------------

const { browser, reason: REASON } = await startBrowser();

async function withServer(r, run) {
  const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?t=${Math.random()}`);
  const { server } = await mod.serve(r, {
    ...process.env, CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0',
    CHEAP_MEM_SERVE_TOKEN: '',
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((res) => { server.closeAllConnections?.(); server.close(res); });
  }
}

const tabOf = (byTitle, word) => byTitle[Object.keys(byTitle).find((k) => (k || '').includes(word))];

/** Collects the visible labels the dashboard shows: list, tab, detail, palette. */
async function dashboardPicture(base, ids, { client = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const visible = `(el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0; }`;
  try {
    if (client) await page.route('**/dashboard/app.js*', (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
    await page.goto(`${base}/dashboard#knowledge/entries`, { waitUntil: 'load' }); // never networkidle
    await waitReady(page);
    await page.waitForSelector(`#screen [data-entry="${ids.legacy}"]`, { timeout: 15000 });
    const list = await page.evaluate((sc) => {
      const vis = eval(sc);
      const byId = {};
      for (const b of document.querySelectorAll('#screen [data-entry]')) {
        const row = b.closest('tr') || b.closest('.row');
        const tag = row?.querySelector('.rule-status');
        byId[b.dataset.entry] = tag ? { text: tag.textContent, visible: vis(tag) } : null;
      }
      return byId;
    }, visible);
    // The skills-and-procedures tab: the card of the rule carries the label
    await page.evaluate(() => { location.hash = 'knowledge/skills'; });
    // Since the skill catalogue (src/skillcatalog.mjs) the tab shows compact
    // rows (`.sk-row`, full title in `title`); the old client shows panels.
    await page.waitForFunction(() => [...document.querySelectorAll('#screen .panel h2')].some((h) => h.textContent.includes('Quokka proposal'))
      || [...document.querySelectorAll('#screen .sk-row')].some((r) => (r.title || '').includes('Quokka proposal')), null, { timeout: 15000 });
    const tab = await page.evaluate((sc) => {
      const vis = eval(sc);
      const byTitle = {};
      for (const p of document.querySelectorAll('#screen .panel')) {
        if (!p.querySelector('h2')) continue;
        const tag = p.querySelector('.rule-status');
        byTitle[p.querySelector('h2')?.textContent] = tag ? { text: tag.textContent, visible: vis(tag) } : null;
      }
      for (const r of document.querySelectorAll('#screen .sk-row')) {
        const tag = r.querySelector('.rule-status');
        byTitle[r.title] = tag ? { text: tag.textContent, visible: vis(tag) } : null;
      }
      return byTitle;
    }, visible);
    await page.evaluate(() => { location.hash = 'knowledge/entries'; });
    await page.waitForSelector(`#screen [data-entry="${ids.legacy}"]`, { timeout: 15000 });
    // Detail
    const detail = {};
    for (const [name, id] of Object.entries(ids)) {
      await page.click(`#screen [data-entry="${id}"]`);
      await page.waitForFunction((i) => document.querySelector('#detail')?.open && document.querySelector('#detailTitle') && document.querySelector('#detail').textContent.includes(i), id, { timeout: 15000 });
      detail[name] = await page.evaluate((sc) => {
        const vis = eval(sc);
        const tag = document.querySelector('#detail .drawer-head .rule-status');
        return tag ? { text: tag.textContent, visible: vis(tag) } : null;
      }, visible);
      await page.evaluate(() => document.querySelector('#detail').close());
    }
    // Palette
    let open = false;
    for (let i = 0; i < 6 && !open; i++) {
      await page.keyboard.press('Control+k');
      open = await page.waitForFunction(() => document.activeElement?.id === 'commandInput', null, { timeout: 5000 }).then(() => true, () => false);
    }
    assert.ok(open, 'the palette opens');
    await page.keyboard.type('hummingbird');
    await page.waitForFunction(() => document.querySelectorAll('#commandResults [data-search-entry]').length >= 4, null, { timeout: 15000 });
    const palette = await page.evaluate((sc) => {
      const vis = eval(sc);
      const byId = {};
      for (const b of document.querySelectorAll('#commandResults [data-search-entry]')) {
        const tag = b.querySelector('.rule-status');
        byId[b.dataset.searchEntry] = tag ? { text: tag.textContent, visible: vis(tag) } : null;
      }
      return byId;
    }, visible);
    return { list, tab, detail, palette };
  } finally { await page.close(); }
}

test('dashboard: list, tab, detail and palette carry a visible label; released/legacy do not — the old client is RED', { skip: REASON }, async () => {
  const r = world();
  try {
    const ids = fill(r, path.join(REPO, 'bin', 'mem'));
    await withServer(r, async (base) => {
      const j = await (await fetch(`${base}/dashboard.json`)).json();
      const byId = new Map((j.entries || []).map((e) => [e.id, e]));
      assert.equal(byId.get(ids.proposed)?.status, 'proposed', 'dashboard.json: field status');
      assert.equal(byId.get(ids.trial)?.status, 'trial');
      assert.ok(!('status' in byId.get(ids.released)) && !('status' in byId.get(ids.legacy)), 'no field for released/legacy');

      const fresh = await dashboardPicture(base, ids);
      for (const [name, value] of [['proposed', 'proposed'], ['trial', 'trial']]) {
        const id = ids[name];
        for (const place of ['list', 'palette']) {
          assert.deepEqual(fresh[place][id], { text: value, visible: true }, `${place}: label ${name}`);
        }
        assert.deepEqual(fresh.detail[name], { text: value, visible: true }, `detail: label ${name}`);
      }
      assert.deepEqual(tabOf(fresh.tab, 'Quokka proposal'), { text: 'proposed', visible: true }, 'procedures tab: label');
      assert.equal(tabOf(fresh.tab, 'Dingo legacy'), null, 'procedures tab: legacy without label');
      for (const name of ['released', 'legacy']) {
        assert.equal(fresh.list[ids[name]], null, `list: ${name} without label`);
        assert.equal(fresh.detail[name], null, `detail: ${name} without label`);
        assert.equal(fresh.palette[ids[name]], null, `palette: ${name} without label`);
      }

      // RED: the client of the fixed old state shows the proposed rule without a label.
      const oldClient = execFileSync('git', ['-C', REPO, 'show', `${OLD_STATE}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const red = await dashboardPicture(base, ids, { client: oldClient });
      assert.equal(red.list[ids.proposed], null, 'RED: old list without label');
      assert.equal(red.detail.proposed, null, 'RED: old detail without label');
      assert.equal(red.palette[ids.proposed], null, 'RED: old palette without label');
      assert.equal(tabOf(red.tab, 'Quokka proposal'), null, 'RED: old tab without label');
      // Positive control: the rows themselves are there in the old state (the probe sees something).
      assert.ok(Object.hasOwn(red.list, ids.proposed) && Object.hasOwn(red.palette, ids.proposed));
    });
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
