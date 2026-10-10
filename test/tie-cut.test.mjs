// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// The cut with a guard for a tie -- port of lucky-mem's "Antwortschranke bei
// Gleichstand" (src/gleichstand.mjs, decision 11p8eskakvf5).
//
// The recall hook cut the ordered list hard at `top`. When the first hit behind
// the cut scored almost exactly like the last one before it, the order of two
// near-equal hits decided by accident which went out. Now the first remaining
// hit within 1 % (relative) of the last shown one comes along; at most ONE more
// (src/tiecut.mjs). It acts on the hook's own call (`mem find --recall`) only.
//
//   A. the pure function, with positive controls (1 % in, 2 % out, cap +1, 0 = old);
//   B. `mem find` as the hook calls it, on a fixture whose scores the probe
//      reads itself (precondition: otherwise it would aim at nothing);
//   C. an explicit `mem find --top N` stays exactly N;
//   D. the REAL hook script: the OLD state (pinned commit) shows 3, now 4;
//   E. the warm recall server answers like the direct path.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cutWithTie, tieSpread, TIE_DEFAULT, TIE_SPREAD_LM } from '../src/tiecut.mjs';
import * as place from '../src/recallserver-place.mjs';
import { CODE, tiedMemory, find, hookIds, oldTree, oldStateMissing, drop } from './fixture/recall-parity.mjs';

// --- A. the pure function ----------------------------------------------

const list = (...scores) => scores.map((score, i) => ({ id: `t${i + 1}`, score }));
const ids = (l) => l.map((t) => t.id).join(',');

test('function: rank 4 within 1 % of rank 3 comes along', () => {
  assert.equal(ids(cutWithTie(list(20, 19, 18, 17.9, 10), 3)), 't1,t2,t3,t4');
});

test('function: exactly 1 % still counts, a hair beyond does not', () => {
  assert.equal(cutWithTie(list(20, 19, 100, 99), 3).length, 4);
  assert.equal(cutWithTie(list(20, 19, 100, 98.9), 3).length, 3);
});

test('function: rank 4 at 2 % is not shown (positive control for the spread)', () => {
  assert.equal(ids(cutWithTie(list(20, 19, 18, 17.64), 3)), 't1,t2,t3');
});

test('function: the cap is ONE more, however many lie inside', () => {
  assert.equal(ids(cutWithTie(list(20, 19, 18, 17.9, 17.9, 17.9), 3)), 't1,t2,t3,t4');
});

test('function: the FIRST remaining hit inside takes the place, not the best one', () => {
  // rank 4 is outside, rank 5 (first inside, in the order given) wins over rank 6 (closer)
  assert.equal(ids(cutWithTie(list(20, 19, 18, 10, 17.9, 18), 3)), 't1,t2,t3,t5');
});

test('function: spread 0 is the old hard cut, as are values outside 0 < x <= 0.5', () => {
  const l = list(20, 19, 18, 18);
  assert.equal(ids(cutWithTie(l, 3, 0)), 't1,t2,t3');
  for (const bad of [-0.01, 0.51, 1, 100, Number.NaN, '0.01', null]) {
    assert.equal(cutWithTie(l, 3, bad).length, 3, `spread ${String(bad)}`);
  }
  assert.equal(cutWithTie(l, 3, 0.5).length, 4, 'the bound itself is valid');
  assert.equal(cutWithTie(l, 3).length, 4, 'the function\'s own spread is 1 %');
});

test('function: a hit already shown is skipped, a hit without a score never qualifies', () => {
  const same = [{ entry: { id: 'a' }, score: 20 }, { entry: { id: 'b' }, score: 19 }, { entry: { id: 'c' }, score: 18 },
    { entry: { id: 'a' }, score: 18 }, { entry: { id: 'd' }, score: 17.9 }];
  assert.equal(cutWithTie(same, 3).map((h) => h.entry.id).join(','), 'a,b,c,d');
  assert.equal(cutWithTie([...list(20, 19, 18), { id: 't4' }, { id: 't5', score: '17.9' }], 3).length, 3);
});

test('function: nothing to take (short list, no score on the last shown, zero), always a new array', () => {
  assert.equal(cutWithTie(list(20, 19, 18), 3).length, 3);
  assert.equal(cutWithTie(list(20, 19, 0, 0), 3).length, 3);
  assert.equal(cutWithTie([...list(20, 19), { id: 't3' }, ...list(18)], 3).length, 3);
  const input = list(20, 19, 18, 18);
  const out = cutWithTie(input, 3);
  assert.notEqual(out, input);
  assert.equal(input.length, 4);
  assert.deepEqual(cutWithTie([], 3), []);
  assert.deepEqual(cutWithTie(list(5, 4), 0), []);
});

test('switch: MEM_RETRIEVE_TIE unset or empty is the default, a number is taken as given', () => {
  assert.equal(TIE_DEFAULT, 0, 'ships off');
  assert.equal(TIE_SPREAD_LM, 0.01);
  assert.equal(tieSpread({}), 0);
  assert.equal(tieSpread({ MEM_RETRIEVE_TIE: '' }), 0);
  assert.equal(tieSpread({ MEM_RETRIEVE_TIE: '0' }), 0);
  assert.equal(tieSpread({ MEM_RETRIEVE_TIE: '0.01' }), TIE_SPREAD_LM);
  assert.equal(tieSpread({ MEM_RETRIEVE_TIE: '0.05' }), 0.05);
  assert.ok(Number.isNaN(tieSpread({ MEM_RETRIEVE_TIE: 'abc' })));
});

// --- B + C. `mem find` --------------------------------------------------

// The rule ships OFF; every probe of the rule itself switches it on the way a user would.
const ON = { MEM_RETRIEVE_TIE: String(TIE_SPREAD_LM) };
const findOn = (tree, root, q, o = {}) => find(tree, root, q, { ...o, env: { ...ON, ...o.env } });
const hookOn = (tree, root, prompt, o = {}) => hookIds(tree, root, prompt, { ...o, env: { ...ON, ...o.env } });

const QUESTION = 'payment retry policy';
// ages in days: three at the top, rank 4 and 5 a day or two behind (inside 1 %), rank 6 three weeks back (outside 2 %)
const NEAR = [0, 1, 2, 3, 4, 21];

test('find --recall: the fixture really ties (precondition read from the scores)', () => {
  const root = tiedMemory(NEAR);
  const r = findOn(CODE, root, QUESTION, { top: 6, recall: true, weak: true });
  assert.equal(r.status, 0, r.stderr);
  const gap = (a, b) => (a - b) / a;
  assert.ok(gap(r.scores[2], r.scores[3]) <= 0.01, `rank 4 inside: ${r.scores}`);
  assert.ok(gap(r.scores[2], r.scores[4]) <= 0.01, `rank 5 inside: ${r.scores}`);
  assert.ok(gap(r.scores[2], r.scores[5]) > 0.02, `rank 6 outside: ${r.scores}`);
  drop(root);
});

test('find --recall --top 3: ONE more comes along, the cap holds although two lie inside; without the flag it stays 3', () => {
  const root = tiedMemory(NEAR);
  const hand = findOn(CODE, root, QUESTION, { top: 3, weak: true });
  const hook = findOn(CODE, root, QUESTION, { top: 3, recall: true, weak: true });
  assert.equal(hand.ids.length, 3, 'an explicit --top 3 is exactly 3');
  assert.equal(hook.ids.length, 4, 'the hook call: 3 + 1');
  assert.deepEqual(hook.ids.slice(0, 3), hand.ids, 'the first three are untouched');
  drop(root);
});

test('find --recall: rank 4 at 2 % stays out (positive control)', () => {
  const root = tiedMemory([0, 1, 2, 20]);
  const hook = findOn(CODE, root, QUESTION, { top: 3, recall: true, weak: true });
  assert.equal(hook.ids.length, 3, `${hook.scores}`);
  drop(root);
});

test('find --recall: MEM_RETRIEVE_TIE=0 is the old cut, 0.05 reaches further', () => {
  const root = tiedMemory([0, 1, 2, 12]);
  assert.equal(findOn(CODE, root, QUESTION, { top: 3, recall: true, weak: true }).ids.length, 3, 'rank 4 is about 1.5 % behind');
  assert.equal(findOn(CODE, root, QUESTION, { top: 3, recall: true, weak: true, env: { MEM_RETRIEVE_TIE: '0.05' } }).ids.length, 4);
  const root2 = tiedMemory(NEAR);
  assert.equal(findOn(CODE, root2, QUESTION, { top: 3, recall: true, weak: true, env: { MEM_RETRIEVE_TIE: '0' } }).ids.length, 3);
  assert.equal(findOn(CODE, root2, QUESTION, { top: 3, recall: true, weak: true, env: { MEM_RETRIEVE_TIE: '1' } }).ids.length, 3, '1 means 100 %: the hard cut, not "take everything"');
  drop(root); drop(root2);
});

// --- the default: OFF ------------------------------------------------------

test('default: the rule is off -- MEM_RETRIEVE_TIE unset is the hard cut, in `find --recall` and in the real hook', () => {
  assert.equal(TIE_DEFAULT, 0);
  assert.equal(tieSpread({}), 0);
  const root = tiedMemory(NEAR);
  try {
    // precondition: with the switch on the same memory does give a fourth hit
    assert.equal(find(CODE, root, QUESTION, { top: 3, recall: true, weak: true, env: ON }).ids.length, 4);
    assert.equal(find(CODE, root, QUESTION, { top: 3, recall: true, weak: true }).ids.length, 3, 'find --recall cuts hard at top');
    assert.equal(hookIds(CODE, root, QUESTION, { session: 'def1', env: ON }).ids.length, 4);
    assert.equal(hookIds(CODE, root, QUESTION, { session: 'def2' }).ids.length, 3, 'the hook cuts hard at top');
  } finally { drop(root); }
});

// --- D. the real hook, old state against now -----------------------------

test('hook: the OLD state shows three entries on a tie, the hook now four (RED on the old state)', (t) => {
  const missing = oldStateMissing();
  if (missing) { t.skip(`unknown, not green: ${missing}`); return; }
  const root = tiedMemory(NEAR);
  const old = oldTree();
  try {
    const prompt = QUESTION;
    const before = hookOn(old, root, prompt, { session: 'old' });
    const after = hookOn(CODE, root, prompt, { session: 'new' });
    assert.equal(before.ids.length, 3, `RED: the old hook cuts hard (${before.ids})`);
    assert.equal(after.ids.length, 4, `the hook now (${after.text})`);
    assert.deepEqual(after.ids.slice(0, 3), before.ids, 'the first three are the same');
    // control: the switch gives the old picture back on the NEW code
    assert.equal(hookOn(CODE, root, prompt, { session: 'off', env: { MEM_RETRIEVE_TIE: '0' } }).ids.length, 3);
  } finally { drop(root); drop(old); }
});

test('hook: with H5 the extra hit never lifts the hook past its five-line cap; below the cap it still comes', () => {
  const root = tiedMemory([0, 1, 2, 3, 4, 5, 6, 30]);
  try {
    const h5 = { MEM_SEARCH_LEVERS: 'h5' };
    // top 5 (the H5 default) + 1 = 6 asked for, the H5 renderer holds five
    assert.equal(hookOn(CODE, root, QUESTION, { session: 'h5a', env: h5 }).ids.length, 5);
    // top 4 + 1 = 5 fits under the cap; with the switch at 0 it is the hard cut 4
    assert.equal(hookOn(CODE, root, QUESTION, { session: 'h5b', env: { ...h5, MEM_RETRIEVE_TOP: '4' } }).ids.length, 5);
    assert.equal(hookOn(CODE, root, QUESTION, { session: 'h5c', env: { ...h5, MEM_RETRIEVE_TOP: '4', MEM_RETRIEVE_TIE: '0' } }).ids.length, 4);
  } finally { drop(root); }
});

// --- E. the warm recall server ------------------------------------------

test('server: the warm recall server answers a tie like the direct path (one find handler)', async () => {
  const root = tiedMemory(NEAR);
  const kid = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(pathToFileURL(path.join(CODE, 'src', 'recallserver.mjs')).href)}).then((r) => r.start(${JSON.stringify(root)}))
      .then((x) => {
        if (!x.running) process.exit(1);
        const stop = () => x.close().then(() => process.exit(0));
        process.on('message', (m) => { if (m === 'stop') stop(); });
      });
  `], { env: { ...process.env, ...ON, MEM_RECALL_SERVER_DIR: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    let err = '';
    kid.stderr.on('data', (s) => { err += s; });
    const until = Date.now() + 15000;
    while (!/listening on/.test(err) && Date.now() < until && kid.exitCode == null) await new Promise((r) => setTimeout(r, 25));
    assert.match(err, /listening on/, err);
    const client = path.join(CODE, 'bin', 'mem-retrieve-client.mjs');
    const out = execFileSync(process.execPath, [client, root, QUESTION, '3'], { encoding: 'utf8', env: { ...process.env, MEM_HOOK_START_MS: String(Date.now()) } });
    const viaServer = JSON.parse(out).hits.map((h) => h.entry.id);
    const direct = findOn(CODE, root, QUESTION, { top: 3, recall: true }).ids;
    assert.equal(viaServer.length, 4, `server: ${viaServer}`);
    assert.deepEqual(viaServer, direct);
    assert.ok(place.CLIENT_RC);
  } finally {
    try { kid.send('stop'); } catch { /* gone */ }
    await new Promise((r) => { kid.once('exit', r); setTimeout(r, 5000); });
    drop(root);
  }
});
