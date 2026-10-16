// test/dash-stamp-r4-cm.test.mjs — the generation stamp of the dashboard cache and the code state of the recall
// server see what they must and nothing else (dashboard-tempo-cm, 2026-10-16; the sibling's R4, levers 25 and 7).
//
// Promises, each with a probe:
//   1. A change the dashboard shows turns the stamp: a new entry, a new inbox message (positive controls - the stamp
//      is not a constant).
//   2. Derived caches do NOT turn it: the expanded index (`MEM_EXPAND=1` writes `.mem/search-index-expand`), the
//      component table with its lock and log, the time track, the drawer locks, and the scratch names of an atomic
//      write. Before, one expanded search was enough for the dashboard to count as stale and rebuild.
//   3. `recallserver.codeState()` notices a change of the same size whose mtime was set back (the ctime moves);
//      before, count, newest mtime and total size stayed equal and the server went on with the old code.
//
// Red proof against the fixed base dc6b69d (origin/kette/cm before this branch): the same scenarios with the old
// modules - the expanded index and the derived caches turn the stamp, codeState stays equal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as cache from '../src/dashboard-cache.mjs';
import * as recallserver from '../src/recallserver.mjs';
import * as search from '../src/search.mjs';
import { oldModuleCopy } from './helpers/old-source-copy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const BASE = 'dc6b69d58cbc90e35827f62381897bc3abe8fee6';
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stamp-r4-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'stamp', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  memory.logEntry(r, 'learning', { title: 'First entry', text: 'Evidence for the stamp.' });
  memory.logEntry(r, 'error', { title: 'Second entry', text: 'Deploy failed twice.' });
  return r;
}

// The writes of derived caches a running memory makes beside the dashboard (each named in DERIVED or a pattern).
function derivedWrites(root, after) {
  const mem = path.join(root, '.mem');
  const put = (rel, text = 'x') => { const p = path.join(mem, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); after(rel); };
  put('component-table.json', '{"v":1}');
  put('component-table-rebuild.lock', '1');
  put('component-table-rebuild.log', 'built');
  put(path.join('timetrack', 'track-0.json'), '{}');
  put('timetrack-build.lock', '1');
  put(path.join('locks', 'drawer-learning.lock'), '1');
  put(`backlinks.json.${process.pid}.k3x9a.tmp`, '{}');
  put(path.join(`search-index.stale.${process.pid}.q1w2e3`, 'meta.json'), '{}');
  put(path.join(`search-index-expand.${process.pid}.z9y8x7.tmp`, 'meta.json'), '{}');
}

// One expanded index build: the switch on, the index loaded (it writes `.mem/search-index-expand`).
function expandedIndex(root) {
  const before = process.env.MEM_EXPAND;
  process.env.MEM_EXPAND = '1';
  try { search.loadIndex(root); } finally { if (before === undefined) delete process.env.MEM_EXPAND; else process.env.MEM_EXPAND = before; }
  assert.ok(fs.existsSync(path.join(root, '.mem', 'search-index-expand')), 'the expanded index cache was written (precondition)');
}

/** The scenario of promise 2 against a stamp function; returns which writes turned it. */
function derivedTurns(stampOf) {
  const root = world();
  search.loadIndex(root); // the plain index first: it is derived in both states, so the stamp after it is the baseline
  const turned = [];
  let s = stampOf(root);
  expandedIndex(root);
  if (stampOf(root) !== s) turned.push('search-index-expand');
  s = stampOf(root);
  derivedWrites(root, (rel) => {
    const now = stampOf(root);
    if (now !== s) turned.push(rel);
    s = now;
  });
  return turned;
}

// Wait until the clock has moved on, so a new ctime is distinguishable from the old one (coarse file-system clocks).
function clockPast(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* a condition on the clock, not a sleep on a result */ }
}

/** The scenario of promise 3 against a codeState function: same size, mtime set back. */
function sameSizeOldMtime(codeStateOf) {
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-codestate-'));
  made.push(code);
  fs.mkdirSync(path.join(code, 'src'));
  const file = path.join(code, 'src', 'a.mjs');
  fs.writeFileSync(file, 'export const a = 1;\n');
  fs.writeFileSync(path.join(code, 'src', 'b.mjs'), 'export const b = 2;\n');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(file, old, old);
  const before = codeStateOf(code);
  clockPast(50);
  fs.writeFileSync(file, 'export const a = 7;\n'); // the same length
  fs.utimesSync(file, old, old); // the mtime set back, like `touch -d`, `cp -p`, `rsync -t`
  const st = fs.statSync(file);
  assert.equal(st.size, 'export const a = 1;\n'.length, 'precondition: the same size');
  assert.equal(Math.round(st.mtimeMs), Math.round(old.getTime()), 'precondition: the old mtime');
  return { before, after: codeStateOf(code) };
}

test('stamp: a new entry and a new inbox message turn it (positive controls: not a constant)', () => {
  const root = world();
  search.loadIndex(root);
  const s0 = cache.generationStamp(root);
  assert.equal(cache.generationStamp(root), s0, 'equal without a change');
  memory.logEntry(root, 'learning', { title: 'Third entry', text: 'A new one.' });
  const s1 = cache.generationStamp(root);
  assert.notEqual(s1, s0, 'a new entry turns the stamp');
  fs.mkdirSync(path.join(root, 'inbox', 'alex'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', 'alex', 'm1.md'), 'hello');
  assert.notEqual(cache.generationStamp(root), s1, 'a new inbox message turns the stamp');
});

test('stamp: the expanded index and the other derived caches do not turn it', () => {
  assert.deepEqual(derivedTurns((r) => cache.generationStamp(r)), []);
});

test('isDerived: the names, their scratch forms and the expand suffix - and not their neighbours', () => {
  for (const n of ['search-index', 'search-index-expand', 'search-index.json', 'component-table.json', 'timetrack', 'locks',
    `backlinks.json.${process.pid}.a1b2c.tmp`, `search-index-expand.12.abc123.tmp`, 'search-index.stale.12.abc123', 'x-heartbeat.json']) {
    assert.equal(cache.isDerived(n), true, n);
  }
  // A scratch name of something that is NOT derived stays seen; a name that only ends like a derived one too.
  for (const n of ['config.json', 'config.json.12.abc12.tmp', 'tasks', 'inbox-seen.json', 'my-search-index', 'search-index-expanded', 'console-log.jsonl']) {
    assert.equal(cache.isDerived(n), false, n);
  }
});

test('codeState: a change of the same size with the mtime set back is seen (the ctime)', () => {
  const { before, after } = sameSizeOldMtime((c) => recallserver.codeState(c));
  assert.notEqual(after, before);
});

test('codeState: equal without a change (positive control)', () => {
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-codestate-'));
  made.push(code);
  fs.mkdirSync(path.join(code, 'src'));
  fs.writeFileSync(path.join(code, 'src', 'a.mjs'), 'export const a = 1;\n');
  assert.equal(recallserver.codeState(code), recallserver.codeState(code));
});

function oldModule(t, rel) {
  let source;
  try {
    source = execFileSync('git', ['-C', REPO, 'show', `${BASE}:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip(`commit ${BASE} not reachable (shallow clone?) - red proof unknown, not green`);
    return null;
  }
  const copy = oldModuleCopy(path.join(REPO, path.dirname(rel)), path.basename(rel), source);
  made.push(copy.dir);
  return copy.file;
}

test(`RED on the base (${BASE.slice(0, 7)}): the expanded index and the derived caches turn the stamp`, async (t) => {
  const file = oldModule(t, 'src/dashboard-cache.mjs');
  if (!file) return;
  const old = await import(pathToFileURL(file).href);
  const turned = derivedTurns((r) => old.generationStamp(r));
  assert.ok(turned.includes('search-index-expand'), `the expanded index turned the old stamp (turned: ${turned.join(', ')})`);
  assert.ok(turned.includes('component-table.json'), 'the component table turned the old stamp');
});

test(`RED on the base (${BASE.slice(0, 7)}): codeState misses the same-size change with the old mtime`, async (t) => {
  const file = oldModule(t, 'src/recallserver.mjs');
  if (!file) return;
  const old = await import(pathToFileURL(file).href);
  const { before, after } = sameSizeOldMtime((c) => old.codeState(c));
  assert.equal(after, before, 'the old code state did not move');
});
