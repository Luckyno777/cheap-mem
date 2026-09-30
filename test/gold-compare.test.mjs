// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Probe for the retrieval gold set and its two-state runner
// (bench/gold/*.jsonl, bench/gold-compare.mjs; X5 + O5).
//
// Three things are held here:
//   1. The set is loaded and sound: at least 40 cases, all six
//      categories, at least five each of scope/temporal/status, and every
//      expected/forbidden id exists in the world (the guard against dead
//      ids) — with a positive control that the guard actually fires.
//   2. Positive control for the runner: a deliberately broken ranker
//      (a copy of this checkout whose `search()` returns its weakest
//      hits first) is reported as WORSE against this checkout, on the same
//      world, through the same CLI path the real comparison uses.
//   3. A code state that does not start is UNKNOWN, never pass or fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REPO, CATEGORIES, loadCases, loadWorld, checkSet, buildWorld, copyWorld,
  runSide, compareSides, summarise, judge,
} from '../bench/gold-compare.mjs';

test('gold set: loaded, at least 40 cases, every category, >= 5 each of scope/temporal/status', () => {
  const cases = loadCases();
  assert.ok(cases.length >= 40, `only ${cases.length} cases`);
  const count = (c) => cases.filter((x) => x.category === c).length;
  for (const c of CATEGORIES) assert.ok(count(c) >= 1, `category ${c} is empty`);
  for (const c of ['scope', 'temporal', 'status']) assert.ok(count(c) >= 5, `${c}: only ${count(c)} cases`);
  for (const c of ['scope', 'temporal', 'status']) {
    for (const x of cases.filter((y) => y.category === c)) {
      assert.ok(x.forbidden.length >= 1, `${x.id}: a ${c} case needs a forbidden id, or it cannot catch a leak`);
    }
  }
});

test('gold set: every expected and forbidden id exists in the world (no dead ids)', () => {
  const problems = checkSet(loadCases(), loadWorld());
  assert.deepEqual(problems, []);
});

test('gold set guard, positive control: a dead id and a missing expectation are caught', () => {
  const world = loadWorld();
  const cases = loadCases();
  const broken = [
    { ...cases[0], id: 'probe-dead', expected: ['no-such-id'] },
    { ...cases[1], id: 'probe-forbidden-dead', forbidden: ['also-not-there'] },
    { ...cases[2], id: 'probe-empty', expected: [] },
  ];
  const problems = checkSet(broken, world);
  assert.ok(problems.some((p) => p.includes("'no-such-id' does not exist")), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes("'also-not-there' does not exist")), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('probe-empty') && p.includes('expected')), problems.join('\n'));
});

test('gold set: the world is synthetic (config says so; only the invented projects)', () => {
  const world = loadWorld();
  assert.equal(world.config?.name, 'gold-demo');
  const projects = new Set(world.entries.map((e) => e.project).filter(Boolean));
  assert.deepEqual([...projects].sort(), ['alpha', 'beta']);
});

// A copy of this checkout's runtime code with one sabotage appended to
// src/search.mjs (fetch wider, reverse, cut back to the asked width — a
// bare reverse would leave the top-k SET unchanged whenever a caller asks
// for exactly k). `search` is a function declaration, so reassigning it
// inside the module changes the live binding every importer sees.
function brokenCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-gold-broken-'));
  for (const part of ['bin', 'src', 'shared', 'package.json', 'HOUSE-RULES.md']) {
    const from = path.join(REPO, part);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, part), { recursive: true });
  }
  const file = path.join(dir, 'src', 'search.mjs');
  fs.appendFileSync(file, '\n// gold probe sabotage: fetch ten times as wide, best hit last\n'
    + 'search = ((orig) => function sabotaged(index, query, o = {}) {\n'
    + '  const top = o.top ?? 10;\n'
    + '  return orig(index, query, { ...o, top: top * 10 }).reverse().slice(0, top);\n'
    + '})(search);\n');
  return dir;
}

test('runner positive control: a deliberately broken ranker is reported as worse', async () => {
  const cases = loadCases().filter((c) => c.category === 'lexical' || c.category === 'status');
  const root = await buildWorld(loadWorld());
  const broken = brokenCopy();
  const a = copyWorld(root);
  const b = copyWorld(root);
  try {
    const base = runSide(REPO, a, cases);
    const head = runSide(broken, b, cases);
    // The control only means something if the good ranker does its job.
    const good = summarise(base).byCategory.lexical;
    assert.equal(good.unknown, 0, JSON.stringify(base.filter((r) => r.state === 'unknown')));
    assert.ok(good.pass >= 6, `this checkout passes only ${good.pass}/8 lexical cases`);
    const cmp = compareSides(base, head);
    assert.equal(cmp.byCategory.lexical, 'worse', JSON.stringify(cmp));
    assert.equal(cmp.overall, 'worse');
    assert.ok(cmp.flips.some((f) => f.from === 'pass' && f.to === 'fail'));
    // And the same ranker against itself moves nothing.
    const again = runSide(REPO, copyWorld(root), cases.filter((c) => c.category === 'lexical'));
    const self = compareSides(base.filter((r) => r.category === 'lexical'), again);
    assert.equal(self.byCategory.lexical, 'same');
  } finally {
    for (const d of [root, broken, a, b]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('runner: a code state whose CLI does not start is unknown, never pass or fail', async () => {
  const dead = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-gold-dead-'));
  fs.mkdirSync(path.join(dead, 'bin'));
  fs.writeFileSync(path.join(dead, 'bin', 'mem'), 'throw new Error("does not build");\n');
  const root = await buildWorld(loadWorld());
  try {
    const cases = loadCases().slice(0, 3);
    const res = runSide(dead, root, cases);
    assert.ok(res.every((r) => r.state === 'unknown'), JSON.stringify(res));
    const pretendBase = cases.map((c) => judge(c, { ids: c.expected }));
    const cmp = compareSides(pretendBase, res);
    assert.equal(cmp.overall, 'unknown');
  } finally {
    fs.rmSync(dead, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compareSides: a regression is never netted away by a gain in the same category', () => {
  const mk = (id, state) => ({ id, category: 'lexical', state });
  const base = [mk('a', 'pass'), mk('b', 'fail'), mk('c', 'pass')];
  const head = [mk('a', 'fail'), mk('b', 'pass'), mk('c', 'pass')];
  assert.equal(compareSides(base, head).byCategory.lexical, 'worse');
  assert.equal(compareSides([mk('a', 'fail')], [mk('a', 'pass')]).byCategory.lexical, 'better');
  assert.equal(compareSides([mk('a', 'pass')], [mk('a', 'pass')]).byCategory.lexical, 'same');
});

test('judge: a forbidden id in the top k fails the case even when the expected one is first', () => {
  const c = { id: 'x', category: 'temporal', expected: ['new'], forbidden: ['old'] };
  assert.equal(judge(c, { ids: ['new', 'old'] }).state, 'fail');
  assert.equal(judge(c, { ids: ['new', 'other'] }).state, 'pass');
  assert.equal(judge(c, { ids: ['other'] }).state, 'fail');
  assert.equal(judge(c, { unknown: 'exit 1' }).state, 'unknown');
});
