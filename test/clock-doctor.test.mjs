// test/clock-doctor.test.mjs — `env/clock` as `mem doctor` reports it,
// wired to src/clock.mjs (P18, 2026-09-20 bauplan). test/clock.test.mjs
// covers the measurement itself; this file covers the finding it
// produces inside src/doctor.mjs — the four states, and the same
// abort-criterion counter-probe repeated at the doctor boundary, since
// that boundary (checkEnvironmentContract's LEVEL mapping) is exactly
// what a real `mem doctor` run shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { checkClockSkew, checkEnvironmentContract, LEVEL } from '../src/doctor.mjs';

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-clock-doctor-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  return root;
}
const away = (root) => fs.rmSync(root, { recursive: true, force: true });

test('env/clock on a bare, empty memory: unknown, not good', () => {
  const root = tmpRoot();
  try {
    const f = checkClockSkew(root);
    assert.equal(f.name, 'env/clock');
    assert.equal(f.level, LEVEL.UNKNOWN);
    assert.match(f.text, /no timestamped entry/);
  } finally { away(root); }
});

test('env/clock on a single-writer memory: unknown, not "no skew detected" — '
  + '`selfWriter` fixed so the test does not depend on who actually runs it', () => {
  const root = tmpRoot();
  try {
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y', why: 'z', agent: 'only-me' });
    const f = checkClockSkew(root, { selfWriter: 'only-me' });
    assert.equal(f.level, LEVEL.UNKNOWN);
    assert.match(f.text, /single writer/);
  } finally { away(root); }
});

test('env/clock reports a genuinely skewed foreign writer as ERROR, signed', () => {
  const root = tmpRoot();
  try {
    const now = Date.now();
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y', why: 'z', agent: 'human:me' },
      { now: new Date(now) });
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y2', why: 'z2', agent: 'human:other' },
      { now: new Date(now + 30 * 60000) });
    const f = checkClockSkew(root, { selfWriter: 'human:me', now });
    assert.equal(f.level, LEVEL.ERROR);
    assert.match(f.text, /human:other/);
    assert.match(f.text, /AHEAD/);
    assert.ok(f.advice, 'a non-good finding must carry a next step');
  } finally { away(root); }
});

test('COUNTER-PROBE at the doctor boundary: a healthy multi-writer memory with ordinary '
  + 'latency reports GOOD — the abort criterion this measurement must never violate', () => {
  const root = tmpRoot();
  try {
    const now = Date.now();
    // Two writers, both writing at roughly "now", the way an active
    // shared memory actually looks. Neither entry is in the future.
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y', why: 'z', agent: 'human:me' },
      { now: new Date(now - 200) });
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y2', why: 'z2', agent: 'human:teammate' },
      { now: new Date(now - 1500) });
    const f = checkClockSkew(root, { selfWriter: 'human:me', now });
    assert.equal(f.level, LEVEL.GOOD,
      'a normal two-writer memory must never be reported as skewed');
  } finally { away(root); }
});

test('checkEnvironmentContract still returns exactly one env/clock finding, alongside the '
  + 'other three environment checks, and never the raw environment.checkClock reading', () => {
  const root = tmpRoot();
  try {
    const findings = checkEnvironmentContract(root);
    const names = findings.map((f) => f.name);
    assert.deepEqual([...names].sort(), [
      'env/append-atomicity', 'env/clock', 'env/merge-driver', 'env/pre-commit',
    ].sort());
    const own = findings.filter((f) => f.name === 'env/clock');
    assert.equal(own.length, 1);
  } finally { away(root); }
});
