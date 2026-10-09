// test/x3c-core-knowledge-status.test.mjs — X3c: the "Always present: core
// knowledge" panel shows only what holds.
//
// "Always present" sounds like "in force". Since X3/X3b/Z1b there are the
// statuses proposed / trial / released / withdrawn / unknown. The panel
// still showed every rule with a label. Now:
//   * proposed and unknown (and withdrawn) rules are out,
//   * trial stays ONLY with a visible label,
//   * released and legacy rules stay as before.
// The one truth is procedure.statusFor (the server hands `status` over
// finished); the page computes nothing again.
//
// Visibility is checked ONLY through getComputedStyle (not innerText
// alone); the browser comes from test/fixture/browser.mjs; readiness is
// waitReady (no networkidle).
//
// RED proof against the FIXED start commit aa31bbc8552bb79cffb4b7cc374bdfe2e51059eb:
// its dashboard.js, put under the page with page.route, shows the
// proposed rule in the panel — also the positive control that the probe
// sees the rule at all.
// invariant: kernwissen-nur-geltendes
/* global document, getComputedStyle, location -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { startBrowser, waitReady, startView } from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD = 'aa31bbc8552bb79cffb4b7cc374bdfe2e51059eb';
const AFTER_CUTOFF = new Date('2026-10-01T09:00:00Z');
const BEFORE_CUTOFF = new Date('2026-09-01T09:00:00Z');

const { browser, reason: why } = await startBrowser();
const NEEDS = why ? { skip: why } : {};

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-x3c-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'x3c', participants: { alex: { human: true } }, language: 'en' }));
  return r;
}
function rule(r, title, fields, now = AFTER_CUTOFF) {
  memory.logEntry(r, 'procedure', { title, rule: `Rule text of ${title}.`, issued_by: 'owner', agent: 'owner', ...fields }, { now });
}
/** Three rules that do NOT hold or are only on trial. */
function worldUnfinished() {
  const r = world();
  rule(r, 'Rule Proposed', { start_status: 'proposed' });
  rule(r, 'Rule Unknown', {});
  rule(r, 'Rule Trial', { start_status: 'trial' });
  return r;
}
/** Rules in force (released, legacy, trial) plus a proposed one. */
function worldMixed() {
  const r = world();
  rule(r, 'Rule Released', { start_status: 'released' });
  rule(r, 'Rule Legacy', {}, BEFORE_CUTOFF);
  rule(r, 'Rule Trial', { start_status: 'trial' });
  rule(r, 'Rule Proposed', { start_status: 'proposed' });
  return r;
}

async function startServer(r) {
  // warm: the cold start of the server is not part of the browser deadlines (chain 2026-10-09: waitReady, 30 s)
  return startView(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' }, { serveOpts: { allowWrites: true } });
}

/** What a person sees in the "Always present: core knowledge" panel — computed values only. */
async function panelView(base, { oldScript } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    if (oldScript) {
      await page.route(/\/dashboard\/app\.js(\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
    }
    await page.goto(base + '/dashboard', { waitUntil: 'load', timeout: 60000 });
    await waitReady(page);
    await page.evaluate(() => { location.hash = '#work/context'; });
    await page.waitForFunction(() => [...document.querySelectorAll('#screen .panel h2')].some((h) => /Always present: core knowledge/.test(h.textContent)), null, { timeout: 15000 });
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('#screen .panel h2')].find((x) => /Always present: core knowledge/.test(x.textContent));
      h.closest('.panel').scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    // Wait for the running reveal animations (0.7 s + at most 275 ms delay); a
    // PAUSED one never ends and stays invisible -- that is what must show up.
    await page.waitForTimeout(300);
    await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime)).map((a) => a.finished.catch(() => null))),
      new Promise((res) => setTimeout(res, 3000)),
    ]));
    // Under load (parallel suite) the reveal can lag: poll the computed opacity
    // up to 10 s instead of trusting one fixed wait. Never swallow the result --
    // the assertion below still reads getComputedStyle.
    await page.waitForFunction(() => {
      const h = [...document.querySelectorAll('#screen .panel h2')].find((x) => /Always present: core knowledge/.test(x.textContent));
      return h && Number(getComputedStyle(h.closest('.panel')).opacity) >= 0.99;
    }, null, { timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(150);
    return await page.evaluate(() => {
      const visible = (el) => {
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.99) return false;
        }
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };
      const h = [...document.querySelectorAll('#screen .panel h2')].find((x) => /Always present: core knowledge/.test(x.textContent));
      const panel = h.closest('.panel');
      return {
        panelVisible: visible(panel),
        rows: [...panel.querySelectorAll('.row')].map((row) => ({
          title: row.querySelector('.textlink, .open-entry')?.textContent.trim() ?? '',
          visible: visible(row),
          label: [...row.querySelectorAll('.rule-status')].filter(visible).map((x) => x.textContent.trim()),
        })),
      };
    });
  } finally { await ctx.close(); }
}
// The row title reads "Procedure, issued by <who> on <date> — <title>"; compare the tail.
const short = (t) => t.split(' — ').pop();
const titles = (v) => v.rows.map((z) => short(z.title)).sort();

test('RED on the fixed old state: a proposed rule stands in the panel (positive control)', NEEDS, async (t) => {
  let old;
  try {
    old = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    t.skip(`commit ${OLD} not reachable (shallow clone?) — red proof unknown, not green`);
    return;
  }
  const s = await startServer(worldUnfinished());
  try {
    const v = await panelView(s.base, { oldScript: old });
    assert.ok(v.panelVisible, 'the panel itself is visible');
    assert.deepEqual(titles(v), ['Rule Proposed', 'Rule Trial', 'Rule Unknown'],
      'old state shows proposed and unknown rules as "Always present"');
  } finally { await s.stop(); }
});

test('GREEN: proposed and unknown rules are out, trial stays with a visible label', NEEDS, async () => {
  const s = await startServer(worldUnfinished());
  try {
    const v = await panelView(s.base);
    assert.ok(v.panelVisible);
    assert.deepEqual(titles(v), ['Rule Trial']);
    assert.ok(v.rows[0].visible, 'the trial row is visible');
    assert.deepEqual(v.rows[0].label, ['trial'], 'the trial rule carries a visible label');
  } finally { await s.stop(); }
});

test('GREEN: released and legacy stay without a label, trial with one, proposed is missing', NEEDS, async () => {
  const s = await startServer(worldMixed());
  try {
    const v = await panelView(s.base);
    assert.deepEqual(titles(v), ['Rule Legacy', 'Rule Released', 'Rule Trial']);
    for (const z of v.rows) {
      assert.ok(z.visible, `${short(z.title)} visible`);
      assert.deepEqual(z.label, short(z.title) === 'Rule Trial' ? ['trial'] : [], `${short(z.title)}: label`);
    }
  } finally { await s.stop(); }
});
