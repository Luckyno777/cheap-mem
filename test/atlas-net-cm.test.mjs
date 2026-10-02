// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/atlas-net-cm.test.mjs — the atlas shows the real net: every topic and
// every relation bundle is a node (no cap, no "Other topics"), above 16 groups
// as a radial hierarchy (main nodes, subtopics further out), loops of stored
// links, derived links dashed, every strand with its evidence, neighbours
// bright on hover. Port of the sibling house's vernetz-lm (backlog item 10).
//
// Measured on the RENDERED dashboard: the real `mem serve` on a temp memory,
// a real Chromium (test/fixture/browser.mjs), counted from graphAPI.inspect()
// and the canvas data set. Without Chromium: SKIPPED with the reason (not
// measured is not passed). Pages run with reducedMotion (no permanent motion):
// counted is the model, not the motion.
//
// RED proof against the FIXED commit 8397f6c (never merge-base): the old
// client caps topics at five plus "Other topics" and bundles at seven plus
// "Other relations", knows no loops and no dashed strand. POSITIVE control:
// with three topics (under the old cap) old and new count the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startBrowser } from './fixture/browser.mjs';
import { withServer, COUNT_OVERLAP } from './fixture/board-parity-atlas-cm.mjs';
import { netWorld } from './fixture/atlas-net-cm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD = '8397f6c77b5d6da7ffa8437e0de276d7787b8afd';
const oldClient = () => {
  try { return execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
};
const { browser, reason: WHY } = await startBrowser();
const LIMIT = 6 * 60 * 1000;

async function atlas(base, mode, { viewport = { width: 1100, height: 760 }, client = null } = {}) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (client) await page.route('**/dashboard/app.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
  await page.goto(base + '/dashboard#knowledge/network', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof sections === 'object' && !document.querySelector('#screen .loading'), null, { timeout: 90000 });
  await page.waitForSelector('#graphModeSelect');
  await page.evaluate((m) => { const s = document.querySelector('#graphModeSelect'); s.value = m; s.dispatchEvent(new Event('change', { bubbles: true })); }, mode);
  await page.waitForFunction((m) => typeof graphAPI === 'object' && graphAPI && graphAPI.inspect().model.mode === m, mode);
  await page.locator('#brain').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  page.errors = errors;
  return page;
}
/** Every topic/bundle node on its level: main nodes plus subtopic cells (recursive). */
const NODES = () => {
  const m = graphAPI.inspect().model, out = [];
  const walk = (c) => { if (c.topic) out.push(c.label); (c.cells || []).forEach(walk); };
  for (const g of m.groups) { out.push(g.key.replace(/^(tag|ref):/, '')); g.cells.forEach(walk); }
  return { keys: m.groups.map((g) => g.key), nodes: out, many: !!m.many, tiered: !!m.tiered, total: m.topicsTotal, members: m.groups.reduce((n, g) => n + g.members.length, 0), text: document.querySelector('#graphEdgeCount').textContent, labels: Number(document.querySelector('#brain').dataset.groupLabels || 0) };
};

test('topics: every topic is a node on its level, no "Other topics" (old: capped at five); 3 topics = the same count old and new', { skip: WHY, timeout: LIMIT }, async () => {
  const old = oldClient();
  const big = await netWorld(REPO, { topics: 30, members: 3 });
  const few = await netWorld(REPO, { topics: 3, members: 3 });
  try {
    await withServer(REPO, few.root, async (base) => {
      const pn = await atlas(base, 'topics');
      const n = await pn.evaluate(NODES);
      await pn.close();
      assert.equal(n.keys.length, 3, 'POSITIVE: three topics, three nodes');
      if (old) {
        const po = await atlas(base, 'topics', { client: old });
        const o = await po.evaluate(() => graphAPI.inspect().model.groups.length);
        await po.close();
        assert.equal(o, 3, 'POSITIVE: the probe counts the same under the old cap');
      }
    });
    await withServer(REPO, big.root, async (base) => {
      if (old) {
        const po = await atlas(base, 'topics', { client: old });
        const o = await po.evaluate(() => graphAPI.inspect().model.groups.map((g) => g.key));
        await po.close();
        console.log('   old topics 30:', o.length, o.slice(-2));
        assert.ok(o.includes('other-topics') && o.length === 6, `RED: the old client caps (${o.join(',')})`);
      }
      const p = await atlas(base, 'topics');
      const n = await p.evaluate(NODES);
      console.log('   new topics 30:', n.keys.length, 'main,', n.nodes.length, 'nodes ·', n.text);
      assert.ok(!n.keys.includes('other-topics'), 'no collecting node');
      assert.ok(n.tiered && n.keys.length >= 8 && n.keys.length <= 20, `8..20 main nodes (${n.keys.length})`);
      for (let t = 0; t < 30; t++) assert.ok(n.nodes.includes(`topic-${String(t).padStart(3, '0')}`), `topic ${t} is a node`);
      assert.equal(n.members, 90, 'every entry is in exactly one main node');
      assert.match(n.text, /30 topics \(\d+ main\)/);
      assert.ok(n.labels >= 1 && n.labels <= 10 + 26, `label tiers (${n.labels})`);
      assert.equal((await p.evaluate(COUNT_OVERLAP)).pairs, 0, 'no label covers another');
      assert.deepEqual(p.errors, []);
      await p.close();
    });
  } finally { for (const w of [big, few]) fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('relations: every bundle is a node, no "Other relations" (old: capped at seven)', { skip: WHY, timeout: LIMIT }, async () => {
  const old = oldClient();
  const w = await netWorld(REPO, { bundles: 20 });
  try {
    await withServer(REPO, w.root, async (base) => {
      if (old) {
        const po = await atlas(base, 'relations', { client: old });
        const o = await po.evaluate(() => graphAPI.inspect().model.groups.map((g) => g.key));
        await po.close();
        assert.ok(o.includes('ref-rest'), `RED: the old client collects the rest (${o.length} groups)`);
      }
      const p = await atlas(base, 'relations');
      const n = await p.evaluate(NODES);
      console.log('   new relations 20:', n.keys.length, 'main,', n.nodes.length, 'nodes ·', n.text);
      assert.ok(!n.keys.includes('ref-rest'));
      assert.equal(n.nodes.length, 20, 'every bundle is a node on its level (main or subtopic)');
      assert.equal(n.members, 60, 'every entry is in a main node');
      assert.match(n.text, /20 bundles \(\d+ main\)/);
      assert.deepEqual(p.errors, []);
      await p.close();
    });
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('radial hierarchy: subtopics bloom further out than their main node, main nodes further than the core', { skip: WHY, timeout: LIMIT }, async () => {
  const w = await netWorld(REPO, { topics: 20, members: 40, sub: 5 });
  try {
    await withServer(REPO, w.root, async (base) => {
      const p = await atlas(base, 'topics');
      const r = await p.evaluate(() => {
        const m = graphAPI.inspect().model, core = graphAPI.inspect().core;
        const d = (c) => Math.hypot(c.x - core.x, c.y - core.y, c.z - core.z);
        const rows = [];
        for (const g of m.groups) for (const c of g.cells) if (c.topic) rows.push({ main: d(g.center), sub: d(c.center) });
        return { rows, n: rows.length, mainMin: Math.min(...m.groups.map((g) => d(g.center))) };
      });
      console.log('   hierarchy: subtopics', r.n, 'nearest main', r.mainMin.toFixed(2));
      assert.ok(r.n >= 20, `subtopics exist (${r.n})`);
      assert.ok(r.mainMin > 0.6, 'main nodes keep their distance from the core');
      for (const x of r.rows) assert.ok(x.sub > x.main, `a subtopic lies outside its main node (${x.sub.toFixed(2)} <= ${x.main.toFixed(2)})`);
      assert.deepEqual(p.errors, []);
      await p.close();
    });
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('loops: A->B->C->A is found and drawn, a chain without the way back is none; hover keeps neighbours bright', { skip: WHY, timeout: LIMIT }, async () => {
  const ring = await netWorld(REPO, { topics: 3, members: 3, ring: 'ring' });
  const chain = await netWorld(REPO, { topics: 3, members: 3, ring: 'chain' });
  try {
    await withServer(REPO, chain.root, async (base) => {
      const p = await atlas(base, 'structure');
      const c = await p.evaluate(() => document.querySelector('#brain').dataset.cycles);
      await p.close();
      assert.equal(c, '0', 'POSITIVE: a chain is no loop');
    });
    await withServer(REPO, ring.root, async (base) => {
      const p = await atlas(base, 'structure');
      const ds = await p.evaluate(() => ({ ...document.querySelector('#brain').dataset }));
      assert.equal(ds.cycles, '1');
      assert.equal(ds.cyclesDrawn, '1');
      assert.match(await p.evaluate(() => document.querySelector('#graphEdgeCount').textContent), /1 loop/);
      // Hover over Ring A: its neighbours stay bright, the rest is dimmed.
      const target = await p.evaluate((id) => graphAPI.inspect().points.find((x) => x.id === id), ring.ids.ring[0]);
      const box = await p.locator('#brain').boundingBox();
      await p.mouse.move(box.x + target.x, box.y + target.y);
      await p.waitForTimeout(300);
      const dims = await p.evaluate((ids) => {
        const pts = graphAPI.inspect().points;
        return { nb: pts.filter((x) => ids.includes(x.id)).map((x) => x.dim), rest: pts.filter((x) => !ids.includes(x.id)).map((x) => x.dim) };
      }, ring.ids.ring);
      assert.ok(dims.nb.every((x) => x === 1), `ring members stay bright (${dims.nb})`);
      assert.ok(dims.rest.some((x) => x < 1), 'the rest steps back');
      assert.deepEqual(p.errors, []);
      await p.close();
    });
  } finally { for (const w of [ring, chain]) fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('derived links: drawn dashed, counted apart, every strand names its source, a click lists them; the review panel lists them', { skip: WHY, timeout: LIMIT }, async () => {
  const w = await netWorld(REPO, { topics: 30, members: 17, derived: true });
  try {
    await withServer(REPO, w.root, async (base) => {
      const p = await atlas(base, 'topics');
      const r = await p.evaluate(() => ({ ds: { ...document.querySelector('#brain').dataset }, text: document.querySelector('#graphEdgeCount').textContent, strands: graphAPI.inspect().strands }));
      console.log('   derived:', r.ds.edgeDashed, 'dashed of', r.ds.edgeStrands, '·', r.text);
      assert.equal(r.ds.edgeDashed, '1');
      assert.match(r.text, /\+ 1 derived \(dashed\)/);
      for (const s of r.strands) for (const e of s.edges) assert.ok(e.source && !/not loaded/.test(e.source), `every edge has its source (${JSON.stringify(e)})`);
      const dashed = r.strands.find((s) => s.dashed);
      assert.match(dashed.edges[0].source, /^derived, automatic guess · shared rare terms: barnacle/);
      assert.deepEqual([dashed.edges[0].from, dashed.edges[0].to], [w.ids.derived[1], w.ids.derived[0]], 'from the younger to the older');
      // The review panel below the atlas.
      assert.match(await p.locator('text=Derived links to review').first().evaluate((el) => el.closest('article, section, div').textContent), /auto · dashed|1 auto/);
      // A click on the dashed strand opens its evidence: on a point of the strand that no label covers.
      const box = await p.locator('#brain').boundingBox();
      const spot = await p.evaluate(([path, bx, by]) => {
        for (let k = 4; k < path.length - 4; k++) {
          const [x, y, vis] = path[k];
          if (!vis) continue;
          const pts = graphAPI.inspect().points;
          if (pts.some((q) => q.visible && Math.hypot(q.x - x, q.y - y) < 24)) continue;
          if (document.elementFromPoint(bx + x, by + y)?.id === 'brain') return [x, y];
        }
        return null;
      }, [dashed.path, box.x, box.y]);
      assert.ok(spot, 'a free point on the strand');
      await p.mouse.click(box.x + spot[0], box.y + spot[1]);
      await p.waitForTimeout(300);
      const opened = await p.evaluate(() => !!document.querySelector('#info')?.open && /Source: derived/.test(document.querySelector('#info').textContent));
      assert.ok(opened, 'the strand click shows the evidence');
      assert.deepEqual(p.errors, []);
      await p.close();
    });
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});
