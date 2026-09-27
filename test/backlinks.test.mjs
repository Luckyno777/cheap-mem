// test/backlinks.test.mjs — the backlink index in src/backlinks.mjs
// (dashboard build plan E1.4). Mirrors lucky-mem's
// test/rueckverweise.test.mjs, in English, for cheap-mem's own memory.
//
// Four fields:
//   measure    missing backlinks in the single-entry lookup (edges from
//              a DIFFERENT drawer than the id's own — see dashboard.
//              getEntryFast()'s GRAPH_NOTE)
//   baseline   every foreign-drawer derived_from edge (unmeasured —
//              getEntryFast() does not search for them at all)
//   target     0, on a fresh index (backlinks() hands them back)
//   abort      the index disagrees with the full pass (probe a)
//
// Four probes, in the order the assignment names them:
//   (a) equivalence: index == full pass (positive control), including
//       a cross-drawer AND cross-project edge
//   (b) incremental: append in a foreign drawer -> stale (without
//       update()), fresh with the new source (with it)
//   (c) cost: one lookup does not read the corpus (file opens constant
//       across two corpus sizes)
//   (d) rebuild from nothing (a deleted cache) gives the same map
// plus the four states covered individually.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as net from '../src/net.mjs';
import * as bl from '../src/backlinks.mjs';

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backlinks-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'backlinks-test', participants: ['someone'], language: 'en' }));
  return r;
}

function gone(r) { fs.rmSync(r, { recursive: true, force: true }); }

/**
 * A small, multi-project and multi-drawer corpus: the actual gap
 * `getEntryFast()` has is a `derived_from` edge from a DIFFERENT drawer
 * AND a DIFFERENT project than the target id.
 */
function baseCorpus(r) {
  // Target id lives in global/errors.jsonl.
  const target = memory.logEntry(r, 'error', { title: 'crack', text: 'the cause' }).entry;

  // Foreign-drawer source: global/learnings.jsonl derives from the error.
  const lesson = memory.logEntry(r, 'learning',
    { title: 'see the crack early', origin: { derived_from: [target.id] } }).entry;

  // Foreign-drawer AND foreign-project source: project 'demo', thoughts.jsonl.
  const thought = memory.logEntry(r, 'thought',
    { text: 'a thought about the crack', origin: { derived_from: [target.id] } },
    { project: 'demo' }).entry;

  // Filler in drawers that do NOT touch the target id.
  for (let i = 0; i < 12; i += 1) {
    memory.logEntry(r, 'event', { title: `filler ${i}`, text: 'x' });
  }
  return { target, lesson, thought };
}

// --- (a) equivalence: index == full pass -------------------------------

test('(a) positive control: the index matches the full pass, across drawers and projects', () => {
  const r = world();
  const { target, lesson, thought } = baseCorpus(r);

  bl.write(r);
  const answer = bl.backlinks(r, target.id);
  assert.equal(answer.state, 'ok');

  // The full pass: every entry of every drawer of every project,
  // net.linksOf() over each one — the same primitive dashboard.mjs's
  // own net view and getEntryFast() already use, not reinvented here.
  const rows = [];
  for (const project of [null, ...memory.listProjects(r)]) {
    for (const type of Object.keys(memory.TYPES)) {
      let it;
      try { it = memory.iterLog(r, type, { project }); } catch { continue; }
      for (const e of it) if (!e.__broken) rows.push(e);
    }
  }
  const expected = [];
  for (const e of rows) {
    for (const l of net.linksOf(e)) {
      if (l.to === target.id) expected.push({ kind: l.kind, id: l.from });
    }
  }
  const sorted = (list) => [...list].sort((x, y) => x.id.localeCompare(y.id) || x.kind.localeCompare(y.kind));
  assert.deepEqual(sorted(answer.sources), sorted(expected),
    'the index disagrees with the full pass (abort criterion)');

  // The actual gap named in the header comment: BOTH foreign-drawer
  // sources are present, including the foreign-project one — exactly
  // what getEntryFast() cannot see.
  const ids = answer.sources.map((s) => s.id).sort();
  assert.deepEqual(ids, [lesson.id, thought.id].sort(),
    'foreign-drawer/foreign-project derived_from edges are missing from the index');
  gone(r);
});

test('(a) a leaf with no edge at all: ok, sources empty — a measured zero, not unknown', () => {
  const r = world();
  const leaf = memory.logEntry(r, 'event', { title: 'leaf', text: 'no edges at all' }).entry;
  bl.write(r);
  const answer = bl.backlinks(r, leaf.id);
  assert.equal(answer.state, 'ok');
  assert.deepEqual(answer.sources, []);
  gone(r);
});

// --- (b) incremental: append in a foreign drawer ------------------------

function waitForNewSecond() {
  const start = Date.now();
  while (Date.now() - start < 1100) { /* busy-wait, deliberately short — mtime resolution */ }
}

test('(b) after an append in a foreign drawer: stale until update(), fresh with the new source after', () => {
  const r = world();
  const { target } = baseCorpus(r);

  bl.write(r);
  const before = bl.backlinks(r, target.id);
  assert.equal(before.state, 'ok');
  assert.equal(before.sources.length, 2);

  waitForNewSecond();
  // A FOREIGN drawer (not 'error', not 'link'): duties.jsonl, project 'demo'
  // — foreign-drawer AND foreign-project relative to the target id.
  const added = memory.logEntry(r, 'duty',
    { title: 'new duty', text: 'x', origin: { derived_from: [target.id] } },
    { project: 'demo' }).entry;

  // Without update(): the corpus changed, the cache did not — 'warning',
  // never a silent 'ok' on the old snapshot.
  const stale = bl.backlinks(r, target.id);
  assert.equal(stale.state, 'warning', 'an unrefreshed cache should have read as stale');
  assert.ok(stale.reason && stale.reason.length > 0, 'a stale answer with no reason is a silent miss');
  assert.ok(!stale.sources.some((s) => s.id === added.id),
    'the new entry was not in the (unrebuilt) cache yet — it should not have appeared here');

  // After bl.update(): the new backlink is there, and the state is 'ok' again.
  bl.update(r);
  const after = bl.backlinks(r, target.id);
  assert.equal(after.state, 'ok');
  assert.equal(after.sources.length, 3);
  assert.ok(after.sources.some((s) => s.id === added.id && s.kind === 'derived_from'),
    'the new backlink is missing after update()');
  gone(r);
});

test('(b) update() does NOT rebuild when the corpus has not changed', () => {
  const r = world();
  baseCorpus(r);
  const first = bl.update(r);
  const second = bl.update(r);
  assert.equal(first.builtAt, second.builtAt, 'an unchanged corpus still triggered a rebuild');
  gone(r);
});

// --- (c) cost: one lookup does not read the corpus ----------------------

function countOpens(fn) {
  const origOpen = fs.openSync;
  const origRead = fs.readFileSync;
  let n = 0;
  fs.openSync = (...a) => { n += 1; return origOpen(...a); };
  fs.readFileSync = (...a) => { n += 1; return origRead(...a); };
  try { fn(); } finally { fs.openSync = origOpen; fs.readFileSync = origRead; }
  return n;
}

test('(c) measure: file opens per backlinks() lookup do not grow with corpus size', () => {
  const small = world();
  const large = world();
  const { target: targetSmall } = baseCorpus(small);
  const { target: targetLarge } = baseCorpus(large);
  for (let i = 0; i < 4000; i += 1) {
    memory.logEntry(large, 'thought', { text: `filler ${i}, does not touch the target id` });
  }
  bl.write(small);
  bl.write(large);

  const nSmall = countOpens(() => bl.backlinks(small, targetSmall.id));
  const nLarge = countOpens(() => bl.backlinks(large, targetLarge.id));
  assert.equal(nSmall, nLarge,
    `file opens grow with corpus size: small=${nSmall}, large=${nLarge} — abort criterion reached`);
  assert.equal(nSmall, 1, `backlinks() should read exactly one file, read ${nSmall}`);
  gone(small);
  gone(large);
});

// --- (d) rebuild from nothing --------------------------------------------

test('(d) rebuilding from nothing (a deleted cache) gives the same content', () => {
  const r = world();
  const { target } = baseCorpus(r);
  const first = bl.write(r);

  // "from nothing": the register is deleted, not merely stale.
  fs.rmSync(path.join(r, bl.BACKLINKS_PATH), { force: true });
  assert.equal(bl.backlinks(r, target.id).state, 'error',
    'without a register, backlinks() should not silently claim something else');

  const second = bl.rebuild(r);
  assert.deepEqual(second.map, first.map, 'the rebuild produced a different map than the first build');
  const answer = bl.backlinks(r, target.id);
  assert.equal(answer.state, 'ok');
  assert.equal(answer.sources.length, 2);
  gone(r);
});

// --- The four states, individually --------------------------------------

test('error: no register present at all', () => {
  const r = world();
  baseCorpus(r);
  const answer = bl.backlinks(r, 'never-built-yet');
  assert.equal(answer.state, 'error');
  assert.ok(answer.reason);
  gone(r);
});

test('unknown: fresh register, id never seen in the corpus', () => {
  const r = world();
  baseCorpus(r);
  bl.write(r);
  const answer = bl.backlinks(r, 'never-seen-id');
  assert.equal(answer.state, 'unknown');
  assert.ok(answer.reason);
  assert.deepEqual(answer.sources, []);
  gone(r);
});

test('warning: a broken line during the build', () => {
  const r = world();
  const { target } = baseCorpus(r);
  fs.appendFileSync(path.join(r, 'global', 'events.jsonl'), 'not-json{{{\n');

  const built = bl.write(r);
  assert.equal(built.incomplete, true, 'the build should have noticed the broken line');
  const answer = bl.backlinks(r, target.id);
  assert.equal(answer.state, 'warning');
  assert.ok(answer.reason && /could not be read/i.test(answer.reason));
  assert.equal(answer.sources.length, 2, 'the known sources should still come through despite the warning');
  gone(r);
});

test('error: a corrupted cache file (not valid JSON)', () => {
  const r = world();
  baseCorpus(r);
  bl.write(r);
  fs.writeFileSync(path.join(r, bl.BACKLINKS_PATH), 'not json at all {{{');
  const answer = bl.backlinks(r, 'anything');
  assert.equal(answer.state, 'error');
  assert.match(answer.reason, /damaged/i);
  gone(r);
});
