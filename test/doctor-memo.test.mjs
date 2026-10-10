// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/doctor-memo.test.mjs — `mem doctor` reads and parses every drawer once.
//
// Port of the lucky-mem build "doktor-pass-lm" (shared pass over the drawers;
// the register half of it has no counterpart here, see src/drawermemo.mjs).
// Trigger: at 100 000 entries every drawer was opened 12 to 17 times in one
// doctor run and parsed as often (measured 2026-10-10: ~14 s, ~5 s of it
// readFileSync, ~3 s garbage collection).
//
// What is claimed, and how each claim is probed:
//   1. READ PASSES (the red/green proof, counted, not timed): an fs spy counts
//      the opens of each drawer file during one `checkAll`. The FIXED prior
//      state (git, never merge-base) opens a drawer at least OLD_MIN_PASSES
//      times; the new code at most NEW_MAX_PASSES (one memoized read, one
//      index-stamp read). Positive control: the spy counts on the old code at
//      all, and `memo: false` on the new code is red again, so the memo is
//      what turned it green, not the corpus.
//   2. SAME FINDINGS: old code, new code with the memo and new code without
//      it return the same findings, summary and report text on several
//      corpora (mixed with broken lines, non-object lines, BOM, CRLF,
//      correction chains, tombstones, refused retirements, duplicate ids,
//      a project drawer; empty; a directory where a drawer should be; a
//      generated Heaps corpus). Positive control: the mixed corpus really
//      produces warnings and errors, and a doctored finding is caught.
//   3. THE MEMO'S OWN RULES: three states stay three (missing, empty,
//      unreadable), a file that changes during a run is read again, what a
//      consumer gets is its own copy, the byte budget is honoured, and a
//      run with every stored value deep-frozen still gives the same findings
//      (no consumer reaches into what it does not own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as doctor from '../src/doctor.mjs';
import * as drawermemo from '../src/drawermemo.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// FIXED prior state (origin/main before this change). Never `merge-base`:
// that moves with the merge and would turn this probe red by itself.
const OLD_STATE = 'b5959ed38a2d859a762df7da893f6ce17b0ee0cb';
const OLD_MIN_PASSES = 8;   // measured on the old state: 12 to 17 per drawer
const NEW_MAX_PASSES = 3;   // measured on the new code: 2 (memo + index stamp)
const TS = '2026-09-01T10:00:00.000Z';

const hasOld = (() => {
  try {
    return spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${OLD_STATE}^{commit}`]).status === 0;
  } catch { return false; }
})();

const trees = [];
function tempRoot(prefix) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trees.push(w);
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'), JSON.stringify({
    version: 1, language: 'en',
    participants: { user: { role: 'the human', human: true }, session: 'an AI session' },
  }));
  return w;
}
process.on('exit', () => { for (const t of trees) { try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* best effort */ } } });

function put(w, rel, lines, { eol = '\n', bom = false } = {}) {
  const abs = path.join(w, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join(eol) + eol;
  fs.writeFileSync(abs, (bom ? '﻿' : '') + body);
}

/** The forms of a memory old and new must answer alike on. */
const FORMS = {
  mixed() {
    const w = tempRoot('dm-mixed-');
    put(w, 'global/decisions.jsonl', [
      { id: 'd1', ts: TS, title: 'Cache', topic: 'cache', choice: 'Use zorbulax for the cache layer', why: 'fast' },
      { id: 'd1b', ts: TS, replaces_id: 'd1', title: 'Cache again', topic: 'cache', choice: 'Use a cache layer', why: 'fast' },
      { id: 'd2', ts: TS, title: 'Two', topic: 'cache', choice: 'B', why: 'because' },
      { id: 'dup', ts: TS, title: 'Dup one', topic: 'x', choice: 'a', why: 'b' },
      { id: 'dup', ts: TS, title: 'Dup two', topic: 'x', choice: 'a', why: 'b' },
      '{"this is not json',
      'null',
      '[1,2]',
      '7',
      '',
      { ts: TS, title: 'no id', choice: 'a', why: 'b' },
      { id: 'nots', title: 'no timestamp', choice: 'a', why: 'b' },
      { id: 'future', ts: '2099-01-01T00:00:00.000Z', title: 'future', choice: 'a', why: 'b' },
      { id: 'orph', ts: TS, replaces_id: 'does-not-exist', title: 'orphan', choice: 'a', why: 'b' },
      { id: 'tomb', ts: TS, retires_id: 'd2', state: 'discarded', agent: 'someone' },
    ], { bom: true });
    put(w, 'global/duties.jsonl', [
      { id: 'u1', ts: TS, title: 'Open duty', text: 'do it', agent: 'lucky' },
      { id: 'u2', ts: TS, title: 'Closed duty', text: 'done', agent: 'session' },
      { id: 'u2c', ts: TS, closes_id: 'u2', state: 'done', agent: 'session', why: 'ok' },
      { id: 'u3c', ts: TS, closes_id: 'nowhere', state: 'done', agent: 'session' },
    ], { eol: '\r\n' });
    put(w, 'global/errors.jsonl', [
      { id: 'e1', ts: TS, title: 'Crash in src/a.mjs', class: 'crash', text: 'src/a.mjs threw' },
      { id: 'e2', ts: TS, title: 'Crash in src/a.mjs again', class: 'crash', text: 'src/a.mjs threw again' },
      { id: 'e3', ts: TS, title: 'Crash in src/a.mjs third', class: 'crash', text: 'src/a.mjs threw a third time' },
    ]);
    put(w, 'global/links.jsonl', [
      { id: 'l1', ts: TS, from: 'e1', to: 'ghost', rel: 'resolves' },
      { id: 'l2', ts: TS, from: 'e2', to: 'd1', rel: 'relates' },
    ]);
    put(w, 'projects/p1/learnings.jsonl', [
      { id: 'p1l', ts: TS, title: 'Learned', topic: 'cache', text: 'A learning in a project.', tags: ['["a"', 'b'] },
      { id: 'p1l2', ts: TS, closes_id: 'p1l', agent: 'session' },
    ]);
    return w;
  },
  empty() { return tempRoot('dm-empty-'); },
  clean() {
    const w = tempRoot('dm-clean-');
    for (let i = 0; i < 12; i += 1) {
      memory.logEntry(w, 'decision', { title: `Filler ${i}`, choice: 'filler', why: `filler text number ${i}`, topic: i % 2 ? 'odd' : 'even' });
    }
    memory.logEntry(w, 'event', { title: 'An event', text: 'something happened' });
    return w;
  },
  dirdrawer() {
    const w = tempRoot('dm-dir-');
    memory.logEntry(w, 'decision', { title: 'One', choice: 'a', why: 'b' });
    fs.mkdirSync(path.join(w, 'global', 'events.jsonl'), { recursive: true });
    put(w, 'global/thoughts.jsonl', []);   // an empty drawer (one blank line), not a missing one
    fs.writeFileSync(path.join(w, 'global', 'questions.jsonl'), '');
    return w;
  },
  heaps() {
    const w = tempRoot('dm-heaps-');
    const r = spawnSync(process.execPath, [path.join(REPO, 'bench/heaps-corpus.mjs'), 'build', w, '1500', '--seed', '7'],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    return w;
  },
};

// Two findings read the CODE tree (docs images, integration contract), not the memory: the
// exported old state has no docs/ and install/, so they differ for a reason that has nothing
// to do with the drawers. Everything else is compared.
const CODE_TREE_FINDINGS = new Set(['docs-images-fresh', 'integration-contract']);
// The O_APPEND probe races worker threads against a deadline: under load it answers "could not
// measure" for a reason that is the machine's, so its text is not compared.
const TIMING_PROBE = /concurrent (O_APPEND writes|writers)/;

/** Findings with the few run-to-run moving numbers (clock distance, timings, cache state) blanked. */
function normal(result) {
  const text = JSON.stringify(result.findings.filter((f) => !CODE_TREE_FINDINGS.has(f.name) && !TIMING_PROBE.test(f.text)), null, 1)
    .replace(/[\d.]+ min ahead/gi, 'N min ahead')
    .replace(/[\d.]+ min behind/gi, 'N min behind')
    .replace(/\d+(\.\d+)? ?ms\b/g, 'N ms')
    .replace(/\((fresh build|cached)\)/g, '(index)');
  return { findings: JSON.parse(text) };
}

// ---------------------------------------------------------------------
// the fs spy: opens per drawer file, counted in this process
// ---------------------------------------------------------------------
function spied(fn) {
  const counts = new Map();
  const originals = {};
  const bump = (p) => {
    const f = typeof p === 'string' ? p : (p instanceof URL ? fileURLToPath(p) : null);
    if (!f || !/\.jsonl$/.test(f)) return;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  };
  for (const name of ['openSync', 'readFileSync', 'createReadStream']) {
    originals[name] = fs[name];
    fs[name] = function spy(...a) { bump(a[0]); return originals[name].apply(this, a); };
  }
  module.syncBuiltinESMExports();
  try { return { result: fn(), counts }; } finally {
    for (const [name, orig] of Object.entries(originals)) fs[name] = orig;
    module.syncBuiltinESMExports();
  }
}

/** Passes per drawer that EXISTS as a file and holds lines (the number the claim is about). */
function passes(counts, w) {
  const out = {};
  for (const [f, n] of counts) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.isFile() && st.size > 0 && f.startsWith(w)) out[path.relative(w, f).split(path.sep).join('/')] = n;
  }
  return out;
}

let oldPromise = null;
function old() {
  oldPromise ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-old-'));
    trees.push(dir);
    exportCommit(REPO, OLD_STATE, ['src', 'bin', 'shared', 'package.json', 'bench/cold-find.json'], dir);
    return import(pathToFileURL(path.join(dir, 'src/doctor.mjs')).href);
  })();
  return oldPromise;
}

// ---------------------------------------------------------------------
// 1. read passes
// ---------------------------------------------------------------------
test('read passes: the old state opens a drawer many times, the new code a few (counted, not timed)',
  { skip: !hasOld && 'NOTICE: fixed old state not in this clone' }, async () => {
    const w = FORMS.mixed();
    for (let i = 0; i < 40; i += 1) {
      memory.logEntry(w, 'learning', { title: `Filler ${i}`, text: `text ${i}`, topic: 'filler' });
    }
    const o = await old();
    doctor.checkAll(w);   // warm the index cache: a cold build is not what is counted here
    const a = spied(() => o.checkAll(w));
    const before = passes(a.counts, w);
    const drawers = Object.keys(before);
    assert.ok(drawers.length >= 4, `positive control: the spy sees the drawers (${drawers.join(', ')})`);
    const oldMax = Math.max(...Object.values(before));
    assert.ok(oldMax >= OLD_MIN_PASSES, `RED on the old state: some drawer is opened >= ${OLD_MIN_PASSES} times (${JSON.stringify(before)})`);

    // The probe: no drawer opened more than NEW_MAX_PASSES times.
    const fewPasses = (counts) => {
      for (const [rel, n] of Object.entries(counts)) {
        assert.ok(n <= NEW_MAX_PASSES, `${rel} opened ${n} times (max ${NEW_MAX_PASSES})`);
      }
    };
    assert.throws(() => fewPasses(before), /opened \d+ times/, 'RED: the probe fails on the old state');

    const b = spied(() => doctor.checkAll(w));
    const after = passes(b.counts, w);
    assert.deepEqual(Object.keys(after).sort(), drawers.sort(), 'same drawers seen on both sides');
    fewPasses(after);   // GREEN
    assert.ok(Math.max(...Object.values(after)) >= 1, 'positive control: the new code reads the drawers too');

    // The memo is what turned it green: switched off, the new code is red again.
    const c = spied(() => doctor.checkAll(w, { memo: false }));
    const off = passes(c.counts, w);
    assert.ok(Math.max(...Object.values(off)) >= OLD_MIN_PASSES, `positive control: memo:false is back to many passes (${JSON.stringify(off)})`);
    assert.throws(() => fewPasses(off), /opened \d+ times/);
  });

// ---------------------------------------------------------------------
// 2. same findings
// ---------------------------------------------------------------------
for (const [name, build] of Object.entries(FORMS)) {
  test(`same findings, old state / new / new without memo: ${name}`,
    { skip: !hasOld && 'NOTICE: fixed old state not in this clone' }, async () => {
      const w = build();
      const o = await old();
      doctor.checkAll(w);   // warm the index cache so both sides see "cached"
      const a = normal(o.checkAll(w));
      const b = normal(doctor.checkAll(w));
      const c = normal(doctor.checkAll(w, { memo: false }));
      assert.deepEqual(b, a, 'new (memo) == old state');
      assert.deepEqual(c, a, 'new (no memo) == old state');
      if (name === 'mixed') {
        // Positive control: the corpus is not trivially green.
        const levels = new Set(b.findings.map((f) => f.level));
        assert.ok(levels.has('warn') && levels.has('error'), `mixed corpus produces warn and error (${[...levels]})`);
        const names = b.findings.filter((f) => f.level !== 'good' && f.level !== 'unknown').map((f) => f.name);
        for (const want of ['drawers', 'orphans', 'integrity']) assert.ok(names.includes(want), `${want} fires on the mixed corpus (${names})`);
        // ... and the comparison itself bites: one doctored finding is different.
        const doctored = structuredClone(b);
        doctored.findings.find((f) => f.name === 'drawers').text += ' ';
        assert.notDeepEqual(doctored, a, 'positive control: a doctored finding is caught');
      }
    });
}

test('a run with every stored value deep-frozen gives the same findings (no consumer reaches into shared values)', () => {
  for (const build of [FORMS.mixed, FORMS.clean, FORMS.heaps]) {
    const w = build();
    const plain = normal(doctor.checkAll(w, { memo: false }));
    const frozen = normal(drawermemo.runWithMemo({ maxBytes: 1 << 30, freeze: true }, () => doctor.checkAll(w)));
    assert.deepEqual(frozen, plain);
  }
});

// ---------------------------------------------------------------------
// 3. the memo's own rules
// ---------------------------------------------------------------------
test('three states stay three inside a run: missing, empty, unreadable', () => {
  const w = FORMS.dirdrawer();
  drawermemo.runWithMemo({ maxBytes: 1 << 30 }, () => {
    assert.deepEqual(memory.readLog(w, 'decision').entries.map((e) => e.title), ['One']);
    const missing = memory.readLog(w, 'error');
    assert.equal(missing.missing, true);
    assert.deepEqual(missing.entries, []);
    const empty = memory.readLog(w, 'question');
    assert.equal(empty.missing, false);
    assert.deepEqual(empty.entries, []);
    assert.throws(() => memory.readLog(w, 'event'), memory.ReadError, 'a directory in the place of a drawer is unreadable, not empty');
    assert.throws(() => [...memory.iterLog(w, 'event')], memory.ReadError);
    assert.equal(drawermemo.rowsOf(path.join(w, 'global', 'events.jsonl')), null, 'not memoized');
    assert.equal(drawermemo.rowsOf(path.join(w, 'global', 'errors.jsonl')), null, 'not memoized');
  });
});

test('outside a run nothing is memoized, and a run leaves nothing behind', () => {
  const w = FORMS.clean();
  const p = memory.logPath(w, 'decision');
  assert.equal(drawermemo.memoActive(), false);
  assert.equal(drawermemo.rowsOf(p), null);
  assert.equal(drawermemo.textOf(p), null);
  drawermemo.runWithMemo({ maxBytes: 1 << 30 }, () => {
    assert.equal(drawermemo.memoActive(), true);
    assert.ok(drawermemo.rowsOf(p));
    // nested: re-entrant, the same memo
    drawermemo.runWithMemo({ maxBytes: 0 }, () => assert.ok(drawermemo.rowsOf(p), 'the outer budget stays'));
  });
  assert.equal(drawermemo.memoActive(), false);
  assert.equal(drawermemo.rowsOf(p), null);
  // an exception does not leave the memo switched on
  assert.throws(() => drawermemo.runWithMemo({ maxBytes: 1 << 30 }, () => { throw new Error('boom'); }), /boom/);
  assert.equal(drawermemo.memoActive(), false);
});

test('a file that changes during a run is read again', () => {
  const w = FORMS.clean();
  const p = memory.logPath(w, 'decision');
  drawermemo.runWithMemo({ maxBytes: 1 << 30 }, () => {
    const n = memory.readLog(w, 'decision').entries.length;
    fs.appendFileSync(p, `${JSON.stringify({ id: 'late', ts: TS, title: 'late', choice: 'a', why: 'b' })}\n`);
    const again = memory.readLog(w, 'decision').entries;
    assert.equal(again.length, n + 1);
    assert.equal(again.at(-1).id, 'late');
    assert.equal([...memory.iterLog(w, 'decision')].length, n + 1);
  });
});

test('a consumer gets its own copy: sorting, annotating and pushing do not reach the next reader', () => {
  const w = FORMS.clean();
  drawermemo.runWithMemo({ maxBytes: 1 << 30 }, () => {
    const first = memory.readLog(w, 'decision').entries;
    const wasLength = first.length;
    const wasTitle = first[0].title;
    first[0].title = 'CHANGED';
    first[0].extra = true;
    first.push({ id: 'pushed' });
    first.reverse();
    const second = memory.readLog(w, 'decision').entries;
    assert.equal(second.length, wasLength);
    assert.equal(second[0].title, wasTitle);
    assert.equal('extra' in second[0], false);
    const viaIter = [...memory.iterLog(w, 'decision')];
    assert.equal(viaIter[0].title, wasTitle);
  });
});

test('the byte budget is honoured: what does not fit is read the old way, with the same result', () => {
  const w = FORMS.mixed();
  const p = memory.logPath(w, 'decision');
  const plain = memory.readLog(w, 'decision');
  drawermemo.runWithMemo({ maxBytes: 10 }, () => {
    assert.equal(drawermemo.rowsOf(p), null, 'over budget: not memoized');
    assert.deepEqual(memory.readLog(w, 'decision'), plain);
    assert.deepEqual([...memory.iterLog(w, 'decision')], plain.entries);
  });
  drawermemo.runWithMemo({ maxBytes: 1 << 30 }, () => {
    assert.deepEqual(memory.readLog(w, 'decision'), plain, 'memoized: the same entries, broken lines and BOM included');
    assert.deepEqual([...memory.iterLog(w, 'decision')], plain.entries);
  });
});

test('the doctor passes a bounded budget to the memo: a tenth of the heap limit', () => {
  const budget = doctor.drawerMemoBytes();
  assert.ok(budget > 1 << 20 && budget < 64 * 1024 ** 3, `bounded, not unbounded (${budget})`);
});
