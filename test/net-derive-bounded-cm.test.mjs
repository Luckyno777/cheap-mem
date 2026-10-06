// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// net-derive-bounded-cm.test.mjs — `derive` (src/netderive.mjs) with bounded memory
// (port of lucky-mem's vernetz-speicher.test.mjs, commit 3c88a5a0).
//
// Measure:            (1) the heap at which `derive` still runs over 50 000 generated entries;
//                     (2) equality of the OLD and the NEW result as complete JSON.
// Baseline:           (1) the OLD code needs a heap of several hundred MiB for 50 000 entries
//                     (9-10 KiB per entry) and dies at 128 MiB.
// Expected change:    (1) NEW runs at 128 MiB, OLD dies there; (2) byte-identical JSON on a store
//                     with file evidence, term evidence, replaced, already linked, closing,
//                     retired, held-off and duplicate-id rows, and an array and a stream as input.
// Abort criterion:    OLD survives 128 MiB (the probe does not bite) / NEW dies / results differ.
//
// Red proof: OLD is the FIXED commit OLD_COMMIT (never merge-base, that moves). The probe
// extracts its `src/` and `bin/` with `git archive` and runs it. Positive control of the memory
// probe: OLD runs at 1024 MiB, so it dies at 128 because of memory, not because of a broken call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD_COMMIT = 'f9fd134'; // before the rebuild: derive holds every entry, feature set and pair
const CHILD = path.join(HERE, 'fixture', 'netderive-run-child.mjs');

let oldCache = null;
function oldTree(t) {
  if (oldCache && fs.existsSync(oldCache)) return oldCache;
  const dir = tempDir('nd-old-', t);
  const tar = path.join(dir, 'old.tar');
  execFileSync('git', ['-C', REPO, 'archive', '-o', tar, OLD_COMMIT, 'src', 'bin', 'package.json']);
  execFileSync('tar', ['-x', '-C', dir, '-f', tar]);
  oldCache = dir;
  return dir;
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rows with every kind of evidence and the edge cases; words Zipf-like so many are rare (df 2..6). */
function buildRows() {
  const r = prng(4242);
  const syl = ['ka', 'lo', 'mi', 'ru', 'te', 'sa', 'ni', 'bo', 'fe', 'du', 'xa', 'zu'];
  const word = (n) => { let s = ''; let k = n + 3; do { s += syl[k % syl.length]; k = Math.floor(k / syl.length); } while (k > 0); return `${s}ung${s.length}`; };
  const zipf = () => word(Math.floor((r() ** 3) * 260));
  const files = Array.from({ length: 70 }, (_, i) => `src/mod${i}.mjs`);
  const drawers = ['decision', 'error', 'event', 'thought', 'learning', 'duty', 'question', 'skill', 'procedure', 'update'];
  const rows = [];
  let seq = 0;
  const add = (drawer, entry, extra = {}) => {
    seq += 1;
    const e = { id: `n${String(seq).padStart(5, '0')}`, ts: `2026-09-${String(1 + (seq % 28)).padStart(2, '0')}T${String(seq % 24).padStart(2, '0')}:00:00Z`, ...entry };
    rows.push({ project: 'global', drawer, entry: e, held: true, ...extra });
    return e;
  };
  const made = [];
  for (let n = 0; n < 500; n++) {
    const text = Array.from({ length: 14 + Math.floor(r() * 12) }, zipf).join(' ');
    const d = { title: `${zipf()} ${zipf()}`, text };
    if (r() < 0.45) d.text += ` ${files[Math.floor(r() ** 2 * files.length)]} ${files[Math.floor(r() * files.length)]}`;
    if (r() < 0.3) d.file = files[Math.floor(r() ** 2 * files.length)];
    if (r() < 0.1) d.files = [files[Math.floor(r() * files.length)], 'src/shared-pair.mjs'];
    if (made.length > 30 && r() < 0.06) d.replaces_id = made[Math.floor(r() * 30)].id;
    if (made.length > 30 && r() < 0.04) d.closes_id = made[Math.floor(r() * 30)].id;
    if (made.length > 40 && r() < 0.06) d.origin = { derived_from: [made[Math.floor(r() * 40)].id] };
    made.push(add(drawers[Math.floor(r() * drawers.length)], d, r() < 0.04 ? { held: false } : {}));
  }
  // Twins: shared rare words and a shared file; every other pair already linked.
  const letters = (k) => String.fromCharCode(97 + (k % 26)) + String.fromCharCode(97 + (Math.floor(k / 26) % 26));
  for (let k = 0; k < 10; k++) {
    const shared = Array.from({ length: 7 }, (_, j) => `twin${letters(k)}${letters(j)}nom`).join(' ');
    const a = add('error', { title: `twin ${k} error`, text: `${shared} src/twin${letters(k)}.mjs` });
    add('learning', { title: `twin ${k} learned`, text: `${shared} src/twin${letters(k)}.mjs`, ...(k % 2 ? { origin: { derived_from: [a.id] } } : {}) });
  }
  // Terms alone (borderline), file alone (dropped), a retired row and an unreadable id.
  for (let k = 0; k < 14; k++) {
    const shared = Array.from({ length: 5 }, (_, j) => `blank${letters(k)}${letters(j)}ung`).join(' ');
    add('learning', { title: `blank ${k} one`, text: shared });
    add('event', { title: `blank ${k} two`, text: shared });
  }
  add('learning', { title: 'file only a', text: 'common words src/only-file.mjs' });
  add('learning', { title: 'file only b', text: 'other words src/only-file.mjs' });
  add('learning', { title: 'retired twin', text: 'twinaaaanom twinaaabnom twinaaacnom twinaaadnom', retires_id: 'n00001' });
  rows.push({ project: 'global', drawer: 'learning', held: true, entry: { title: 'no id', text: 'twinaaaanom' } });
  // Duplicate ids: the same entry appears twice (two drawers); the old code counts both rows.
  const dup = rows[10].entry;
  rows.push({ project: 'other', drawer: rows[10].drawer, held: true, entry: { ...dup, ts: '2026-09-30T00:00:00Z' } });
  rows.push({ project: 'global', drawer: 'link', held: true, entry: { id: 'lk1', kind: 'derived_from', from: 'n00020', to: 'n00021' } });
  return rows;
}

async function load(src) {
  const u = (f) => import(`${pathToFileURL(path.join(src, f)).href}?${Math.random()}`);
  return u('netderive.mjs');
}

test('equality: OLD and NEW give the same complete JSON (array and stream input, shuffled drawers too)', async (t) => {
  const old = await load(path.join(oldTree(t), 'src'));
  const fresh = await load(path.join(REPO, 'src'));
  const rows = buildRows();
  const a = old.derive(rows);
  // Positive control: the store really produces every outcome and every counter.
  assert.ok(a.auto.length >= 5 && a.borderlineTotal >= 10 && a.dropped > 50 && a.linked >= 3, JSON.stringify([a.auto.length, a.borderlineTotal, a.dropped, a.linked]));
  assert.ok([...a.auto, ...a.borderline].some((l) => /side evidence/.test(l.reason)) || a.auto.length > 0);
  assert.equal(JSON.stringify(fresh.derive(rows)), JSON.stringify(a), 'array input differs');
  const stream = { *[Symbol.iterator]() { yield* rows; } };
  assert.equal(JSON.stringify(fresh.derive(stream)), JSON.stringify(a), 'stream input differs');
  assert.equal(JSON.stringify(fresh.derive(rows[Symbol.iterator]())), JSON.stringify(a), 'one-shot iterator differs');
  const rev = [...rows].reverse();
  assert.equal(JSON.stringify(fresh.derive(rev)), JSON.stringify(old.derive(rev)), 'reversed input differs');
  // Edge cases: fewer than two rows, no rows.
  assert.equal(JSON.stringify(fresh.derive(rows.slice(0, 1))), JSON.stringify(old.derive(rows.slice(0, 1))));
  assert.equal(JSON.stringify(fresh.derive([])), JSON.stringify(old.derive([])));
});

test('equality through the CLI: `mem net --derived` (text and --json) on a real store, OLD tree vs NEW tree', (t) => {
  const old = oldTree(t);
  const root = tempDir('nd-cli-', t);
  assert.equal(spawnSync(process.execPath, [path.join(REPO, 'bin', 'mem'), 'init', '--root', root], { input: '' }).status, 0);
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  for (let i = 0; i < 520; i++) memory.logEntry(root, 'learning', { title: `filler ${i}`, text: 'common words about memory' }, { now: new Date(t0 + i * 1000) });
  const a = memory.logEntry(root, 'error', { title: 'Zebrafish quorum handshake fails', text: 'barnacle lease lost in src/quorum.mjs' }, { now: new Date(t0 + 1e6) }).entry;
  const b = memory.logEntry(root, 'learning', { title: 'Zebrafish quorum handshake retry', text: 'renew the barnacle lease, src/quorum.mjs' }, { now: new Date(t0 + 2e6) }).entry;
  // A retired twin must not count (held = false), through the retirement map.
  const c = memory.logEntry(root, 'learning', { title: 'Zebrafish quorum handshake old', text: 'barnacle lease lost in src/quorum.mjs' }, { now: new Date(t0 + 3e6) }).entry;
  memory.retireEntry(root, 'learning', c.id, { state: 'obsolete', why: 'test' });
  memory.logEntry(root, 'learning', { title: 'Plankton borderline one', text: 'plankton harpoon sextant nautilus lantern keel' }, { now: new Date(t0 + 4e6) });
  memory.logEntry(root, 'event', { title: 'Plankton borderline two', text: 'plankton harpoon sextant nautilus lantern keel' }, { now: new Date(t0 + 5e6) });
  for (const flags of [['--json'], []]) {
    const run = (tree) => spawnSync(process.execPath, [path.join(tree, 'bin', 'mem'), 'net', '--derived', ...flags, '--root', root], { encoding: 'utf8', input: '' });
    const o = run(old); const n = run(REPO);
    assert.equal(o.status, 0, o.stderr); assert.equal(n.status, 0, n.stderr);
    assert.equal(n.stdout, o.stdout, `CLI output differs (${flags.join(' ') || 'text'})`);
    assert.match(o.stdout, flags.length ? /"tier": "auto"/ : /auto 1 · borderline 1/);
  }
  void a; void b;
});

function child(srcDir, root, heapMiB, mode) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [`--max-old-space-size=${heapMiB}`, CHILD, srcDir, root, mode], { encoding: 'utf8', timeout: 150000 });
  return { rc: r.status, out: r.stdout, err: r.stderr, s: (Date.now() - t0) / 1000 };
}

test('memory: 50 000 generated entries — OLD dies at 128 MiB heap, NEW runs; OLD runs at 1024 (positive control)', { timeout: 280000 }, (t) => {
  const corpus = tempDir('nd-50k-', t);
  const build = spawnSync(process.execPath, [path.join(REPO, 'bench', 'heaps-corpus.mjs'), 'build', corpus, '50000', '--seed', '1337', '--budget', '50000'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(build.status, 0, build.stderr);
  const old = path.join(oldTree(t), 'src');
  const fresh = child(path.join(REPO, 'src'), corpus, 128, 'stream');
  assert.equal(fresh.rc, 0, `NEW must run at 128 MiB: rc=${fresh.rc} ${fresh.err.slice(-300)}`);
  const ne = JSON.parse(fresh.out.trim().split('\n').pop());
  assert.ok(ne.entries > 40000, `entries ${ne.entries}`); // content drawers of the 50 000 lines
  const small = child(old, corpus, 128, 'array');
  assert.notEqual(small.rc, 0, 'OLD must fail at 128 MiB (otherwise the probe does not bite)');
  assert.match(small.err, /heap out of memory|Allocation failed|Invalid string length|Map maximum size/i);
  const big = child(old, corpus, 1024, 'array');
  assert.equal(big.rc, 0, `positive control: OLD runs at 1024 MiB: ${big.err.slice(-300)}`);
  const og = JSON.parse(big.out.trim().split('\n').pop());
  for (const k of ['entries', 'auto', 'borderlineTotal', 'dropped', 'linked']) assert.equal(ne[k], og[k], k);
});
