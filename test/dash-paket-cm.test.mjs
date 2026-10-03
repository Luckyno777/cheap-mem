// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/dash-paket-cm.test.mjs — the dashboard package ported from lucky-mem
// (task dash-paket-cm, 2026-10-03; lm commits c92a2eb2, c2d19731, 11274653,
// 42950344, b7bff3f4, 07da6811).
//
// What is secured (the browser side is in dash-paket-cm-browser.test.mjs):
//   (1) the task `project-confirm`: persons only, a closed parameter, the
//       CLI call with --json, `mem project confirm --json` names the event.
//   (2) the offline reading view (src/readview.mjs): one file, no address,
//       no network call, encrypted entries without envelope, `</script>`
//       in a title cannot break out; the route serves it as a download.
//   (3) every entry row carries its (alias-resolved) topic.
//   (4) the stylesheet: no new hex colour in the added block, and every new
//       text/background pair meets WCAG AA (4.5:1) in both themes.
//   (5) the shipped script: the overview's order, the legend in two
//       paragraphs, no "(not built)" button, categories hidden without data.
//
// Red proof, pinned to the FIXED base commit 24cd9a9 (never merge-base): the
// same probes on the old files fail; positive controls show the probes bite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as tasks from '../src/tasks.mjs';
import * as readview from '../src/readview.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '24cd9a9';
const old = (file) => {
  try { return execFileSync('git', ['-C', REPO, 'show', `${OLD}:${file}`], { encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const JS = read('assets/dashboard/dashboard.js');
const CSS = read('assets/dashboard/dashboard.css');

// --- (1) project-confirm ------------------------------------------------------
test('(1) task project-confirm: persons only, closed parameter, the CLI call', (t) => {
  const root = tempDir('cm-dpc-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'dpc', participants: { alex: { human: true } }, language: 'en' }));
  const spec = tasks.KINDS['project-confirm'];
  assert.ok(spec, 'the kind exists');
  assert.equal(spec.humanOnly, true);
  assert.throws(() => tasks.start(root, 'project-confirm', { name: 'garden' }, { user: false }), (e) => e.code === 'NOT_A_PERSON');
  assert.throws(() => tasks.start(root, 'project-confirm', { name: '../x' }, { user: true }), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => tasks.start(root, 'project-confirm', { name: 'a', extra: 'b' }, { user: true }), (e) => e.code === 'INVALID_PARAMS');
  assert.deepEqual(spec.command(root, 'x', { name: 'garden' }).args, ['project', 'confirm', 'garden', '--json']);
  assert.equal(spec.classify({ new: 'abc' }).state, 'ok');
  assert.equal(spec.classify({}).state, 'warning', 'positive control: no event named = not ok');
});

test('(1b) `mem project confirm --json` names the new event; without --json the text is unchanged', (t) => {
  const root = tempDir('cm-dpc2-', t);
  const env = { ...process.env, CHEAP_MEM_ROOT: root };
  delete env.MEM_HEADLESS;
  const mem = (...a) => execFileSync('node', [path.join(REPO, 'bin', 'mem'), ...a], { env, encoding: 'utf8' });
  mem('init');
  mem('project', 'new', 'garden', '--title', 'Garden', '--reason', 'probe');
  mem('project', 'new', 'meadow', '--title', 'Meadow', '--reason', 'probe two');
  const j = JSON.parse(mem('project', 'confirm', 'garden', '--json'));
  assert.equal(j.project, 'garden');
  assert.match(j.new, /^[a-z0-9]{8,}$/);
  assert.match(mem('project', 'confirm', 'meadow'), /Project meadow confirmed \(event /, 'plain output unchanged');
});

// --- (2) the offline reading view ----------------------------------------------
const PKG = {
  header: { selection: { project: 'demo' }, created: '2026-10-03T00:00:00Z', counts: { entries: 2, encrypted: 1, historical: 0, externalRefs: 1 }, completeness: { state: 'good', reasons: [] }, code: { commit: 'abcdef123456' } },
  entries: [
    { id: 'aaa11111', type: 'learning', project: 'demo', state: 'active', encrypted: false, relations: [{ kind: 'derived_from', id: 'bbb22222', inPackage: true }], entry: { title: 'Plain </script><b>x</b>', text: 'visible words' } },
    { id: 'bbb22222', type: 'decision', project: 'demo', state: 'active', encrypted: true, relations: [], entry: { body_enc: { v: 1, ct: 'CIPHERTEXT-ENVELOPE' }, topic: 'SIDE-FIELD-LEAK' } },
  ],
  refs: [{ id: 'ccc33333', type: 'learning', project: 'other', title: 'Outside', encrypted: false, known: true }],
};
test('(2) reading view: one file, nothing from the outside, encrypted entries without envelope', () => {
  const html = readview.buildHtml(PKG);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('visible words'), 'plain content is there');
  assert.ok(!html.includes('CIPHERTEXT-ENVELOPE') && !html.includes('SIDE-FIELD-LEAK'), 'no envelope, no side field of an encrypted entry');
  assert.ok(!/(?:src|href)\s*=\s*["']?https?:/i.test(html) && !/@import|url\(\s*["']?https?:|fetch\(|XMLHttpRequest|WebSocket/.test(html), 'no address, no network call');
  assert.equal((html.match(/<script/g) || []).length, 2, 'the data block and the script — and the title cannot add a third');
  assert.ok(!/<\/script><b>/.test(html), 'a </script> in a title does not break out');
  assert.ok(!/innerHTML/.test(html), 'content is set through textContent only');
  assert.equal(readview.fileName('demo', new Date('2026-10-03T10:00:00Z')), 'cheap-mem-demo-2026-10-03-reading.html');
  assert.ok(!/[äöüßÄÖÜ]/.test(read('src/readview.mjs')), 'English only');
});

test('(2b) the route serves the same package as one HTML download; the JSON stays the default', async (t) => {
  const root = tempDir('cm-dpc3-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'dpc3', participants: { alex: { human: true } }, language: 'en' }));
  memory.projectInit(root, 'demo');
  memory.logEntry(root, 'learning', { title: 'Reading view probe', text: 'hello' }, { project: 'demo' });
  const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?dpc=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let res;
  for (let i = 0; i < 60; i += 1) { // the first build may still be running (503)
    res = await fetch(`${base}/dashboard/project-package.json?project=demo&format=html`);
    if (res.status !== 503) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="cheap-mem-demo-\d{4}-\d{2}-\d{2}-reading\.html"/);
  assert.ok((await res.text()).includes('Reading view probe'));
  const j = await fetch(`${base}/dashboard/project-package.json?project=demo`);
  assert.match(j.headers.get('content-type'), /json/);
  assert.equal((await j.json()).header.format, 'cheap-mem-project-package');
});

// --- (3) the topic on every entry row ------------------------------------------
test('(3) entryRow carries the alias-resolved topic; none stays absent', () => {
  const z = { id: 'x1', type: 'learning', headline: 'h', tags: ['a'], project: 'global' };
  assert.equal(dashboardData.entryRow(z, { topic: 'old/name' }, null, null, new Map([['old/name', 'new/name']])).topic, 'new/name');
  assert.equal(dashboardData.entryRow(z, { topic: 'plain' }, null, null).topic, 'plain', 'no alias: the raw name');
  assert.equal(dashboardData.entryRow(z, {}, null, null).topic, undefined, 'positive control: no topic, no field');
});

// --- (4) the stylesheet ---------------------------------------------------------
const block = CSS.slice(CSS.indexOf('/* dash-paket-cm (2026-10-03)'));
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const tokens = (src) => Object.fromEntries([...src.matchAll(/--([a-z]+):(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
test('(4) added CSS: no new hex colour; every new text/background pair is AA in both themes', () => {
  assert.ok(block.length > 500 && block.startsWith('/* dash-paket-cm'), 'the block exists');
  assert.deepEqual(block.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], 'tokens only');
  const dark = tokens(CSS.slice(CSS.indexOf(':root{'), CSS.indexOf('}', CSS.indexOf(':root{'))));
  const light = tokens(CSS.slice(CSS.indexOf('body.light{'), CSS.indexOf('}', CSS.indexOf('body.light{'))));
  // [text token, background token, where it is used]
  const pairs = [['muted', 'panel', '.tl-count'], ['quiet', 'panel', '.tl-head, .tl-lbl'], ['text', 'raised', '.tl-tile'], ['muted', 'raised', '.tl-group, row hover'], ['accent', 'panel', 'pressed switch'], ['accent', 'raised', 'pressed switch on hover'], ['muted', 'raised', '.tl-row:hover .tl-count'], ['gold', 'panel', 'proposal badge'], ['green', 'panel', 'confirmed badge']];
  for (const [name, theme] of [['dark', dark], ['light', light]]) {
    for (const [fg, bg, where] of pairs) {
      const r = ratio(theme[fg], theme[bg]);
      assert.ok(r >= 4.5, `${name}: ${fg} on ${bg} (${where}) = ${r.toFixed(2)}:1`);
    }
  }
  assert.ok(ratio('#777777', '#808080') < 4.5, 'positive control: the calculation does reject a weak pair');
});

// --- (5) the shipped script -----------------------------------------------------
test('(5) overview order, two-paragraph legend, a working reading-view button, categories only with data', () => {
  const home = JS.slice(JS.indexOf('function home() {'), JS.indexOf('function boardPanel()'));
  const at = (needle) => { const i = home.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = ['id="homeDay"', 'metrics([', 'class="home-layout"', 'class="overview-today"', 'Recently connected', 'boardPanel()'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'title, day slot, figures, network, Today, recently, board');
  assert.ok(!/\(not built\)/.test(JS), 'no "(not built)" button any more');
  assert.match(JS, /function graphLegend\(\)/);
  assert.match(JS, /<strong>What you see<\/strong>/);
  assert.match(JS, /<strong>Controls<\/strong>/);
  assert.match(JS, /const cd = atlasCondensed\(\)/, 'the condensed atlas is named only under its own condition');
  assert.match(JS, /if \(!topicsAreTopics\(\) \|\| !k \|\| k\.error \|\| !Array\.isArray\(k\.list\)\) return \{ on: false/, 'no data, no categories');
  assert.ok(!/[äöüßÄÖÜ]/.test(CSS.slice(CSS.indexOf('/* dash-paket-cm'))) , 'English only');
});

test('(5b) red proof against the fixed base: the old files lack every one of these', (t) => {
  const oldJs = old('assets/dashboard/dashboard.js');
  const oldCss = old('assets/dashboard/dashboard.css');
  if (!oldJs || !oldCss) return t.skip(`commit ${OLD} not reachable (shallow clone?) — red proof unknown, not green`);
  for (const needle of ['topicListHtml', 'graphLegend', 'overview-today', "taskStart({ kind: 'project-confirm'", "exportJson('html')", 'id="configStatus"']) {
    assert.ok(!oldJs.includes(needle), `old script must lack ${needle}`);
    assert.ok(JS.includes(needle), `positive control: the new script has ${needle}`);
  }
  assert.ok(oldJs.includes('(not built)'), 'the old button said so');
  assert.ok(!oldCss.includes('.tl-row'), 'old stylesheet has no topic list');
  assert.equal(old('src/readview.mjs'), null, 'the old tree has no reading view');
});
