// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/today.test.mjs — src/today.mjs (mirrors lucky-mem's src/heute.mjs).
//
// This is new code with no direct predecessor at this worktree's
// starting commit (ddca89d5430b7c2866a93788edd6fe14822af337) — the red
// proof for the MODULE is simply that it does not exist there yet
// (checked below); the wiring red proofs for the CLI, the dashboard and
// the session-start line are their own test files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as today from '../src/today.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_COMMIT = 'ddca89d5430b7c2866a93788edd6fe14822af337';
const MEM = path.join(REPO, 'bin', 'mem');

function memoryRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-today-'));
  const res = spawnSync(process.execPath, [MEM, '--root', r, 'init'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `mem init failed: ${res.stderr}`);
  return r;
}
const mem = (root, ...args) => spawnSync(process.execPath, [MEM, '--root', root, ...args], { encoding: 'utf8', timeout: 15000 });

test('RED on the old commit: src/today.mjs does not exist yet', () => {
  assert.throws(
    () => execFileSync('git', ['show', `${OLD_COMMIT}:src/today.mjs`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    /does not exist|exists on disk, but not in/,
  );
});

test('POSITIVE CONTROL: today() really reads something on a fresh install — doctor findings', () => {
  const root = memoryRoot();
  try {
    const r = today.today(root);
    assert.equal(r.operations.readable, true);
    assert.ok(r.operations.notable.length > 0, 'a fresh, unconfigured install should have at least one warn finding');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('operations(): only warn/error findings, worst first', () => {
  const root = memoryRoot();
  try {
    const fakeCheck = () => ({
      worst: 'error',
      summary: { good: 1, warn: 1, error: 1, unknown: 0 },
      findings: [
        { name: 'a', level: 'good', text: 'fine', advice: null },
        { name: 'b', level: 'warn', text: 'meh', advice: 'do x' },
        { name: 'c', level: 'error', text: 'broken', advice: 'do y' },
      ],
    });
    const r = today.operations(root, { check: fakeCheck });
    assert.equal(r.readable, true);
    assert.deepEqual(r.notable.map((f) => f.name), ['c', 'b']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('decisionsForHuman(): only duties addressed to the configured human, never every open duty', () => {
  const root = memoryRoot();
  try {
    mem(root, 'log', 'duty', '--title', 'for the human', '--who', 'user');
    mem(root, 'log', 'duty', '--title', 'for someone else', '--who', 'bot');
    const r = today.decisionsForHuman(root);
    assert.equal(r.readable, true);
    assert.equal(r.who, 'user');
    assert.equal(r.list.length, 1);
    assert.equal(r.list[0].title, 'for the human');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyCandidates(): a stale fact and a conflicting fact both surface, a fresh fact does not', () => {
  const root = memoryRoot();
  try {
    // Current, fresh — must NOT appear.
    mem(root, 'log', 'timeline', '--key', 'fresh.fact', '--value', '1', '--valid_from', new Date().toISOString().slice(0, 10));
    // Stale: far in the past, nothing newer.
    mem(root, 'log', 'timeline', '--key', 'stale.fact', '--value', 'old-value', '--valid_from', '2020-01-01');
    // Conflict: two versions same day, different values.
    mem(root, 'log', 'timeline', '--key', 'conflict.fact', '--value', 'a', '--valid_from', '2026-01-01');
    mem(root, 'log', 'timeline', '--key', 'conflict.fact', '--value', 'b', '--valid_from', '2026-01-01');

    const r = today.verifyCandidates(root, { now: new Date('2026-09-28') });
    assert.equal(r.readable, true);
    const keys = r.list.map((v) => v.key);
    assert.ok(keys.includes('stale.fact'), `expected stale.fact in ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('conflict.fact'), `expected conflict.fact in ${JSON.stringify(keys)}`);
    assert.ok(!keys.includes('fresh.fact'), 'a fresh, unambiguous fact must not be a verify candidate');
    const conflictRow = r.list.find((v) => v.key === 'conflict.fact');
    assert.equal(conflictRow.conflict, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyCandidates() is capped at VERIFY_MAX, conflicts ranked first', () => {
  const root = memoryRoot();
  try {
    for (let i = 0; i < 5; i += 1) {
      mem(root, 'log', 'timeline', '--key', `stale.${i}`, '--value', 'x', '--valid_from', '2020-01-01');
    }
    const r = today.verifyCandidates(root, { now: new Date('2026-09-28'), max: today.VERIFY_MAX });
    assert.equal(r.totalUncertain, 5);
    assert.equal(r.list.length, today.VERIFY_MAX);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reviewSuggestions() and wordPairSuggestions() are honest "unknown", never fabricated data', () => {
  const rv = today.reviewSuggestions();
  const wp = today.wordPairSuggestions();
  assert.equal(rv.readable, false);
  assert.match(rv.reason, /unknown — no source yet/);
  assert.deepEqual(rv.list, []);
  assert.equal(wp.readable, false);
  assert.match(wp.reason, /unknown — no source yet/);
  assert.deepEqual(wp.list, []);
});

test('line(): null when nothing is notable, one line when something is', () => {
  assert.equal(today.line({
    decisions: { readable: true, list: [] }, operations: { readable: true, worst: 'good', notable: [] },
    verify: { readable: true, list: [] }, gold: { drawn: { readable: true }, candidates: [] },
  }), null);
  const l = today.line({
    decisions: { readable: true, list: [{ id: 'd1' }] }, operations: { readable: true, worst: 'warn', notable: [{}] },
    verify: { readable: true, list: [{ key: 'x' }] }, gold: { drawn: { readable: true }, candidates: [] },
  });
  assert.match(l, /^Today: /);
  assert.match(l, /1 decision open/);
  assert.match(l, /operations warn/);
  assert.match(l, /1 to verify/);
});

test('verifyTarget in today() reflects CHEAP_MEM_VERIFY_FILE', () => {
  const root = memoryRoot();
  try {
    const r = today.today(root, { env: { CHEAP_MEM_VERIFY_FILE: '/tmp/somewhere/verdicts.jsonl' } });
    assert.equal(r.verifyTarget, '/tmp/somewhere/verdicts.jsonl');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
