// test/f4-doctor.test.mjs — F0/F2/abort-criterion (BAUPLAN-mem-admin_02.md
// Block F, ported as F4): the three new doctor findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import {
  checkRepetition, checkClosedWithoutEvidence, checkAutoDutyAge, LEVEL,
} from '../src/doctor.mjs';
import * as errorcontext from '../src/errorcontext.mjs';

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f4-doctor-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  return root;
}

// --- repetition -------------------------------------------------------

test('repetition: no error entries at all is UNKNOWN, not 0%', () => {
  const root = fresh();
  try {
    const f = checkRepetition(root);
    assert.equal(f.level, LEVEL.UNKNOWN);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repetition: errors with no determinable file is UNKNOWN, not 0%', () => {
  const root = fresh();
  try {
    memory.logEntry(root, 'error', { class: 'concurrency', title: 'a race', ts: '2026-09-25T00:00:00Z' });
    const f = checkRepetition(root, new Date('2026-09-26T00:00:00Z'));
    assert.equal(f.level, LEVEL.UNKNOWN);
    assert.match(f.text, /not measurable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repetition: clean when no new error repeats a file+class', () => {
  const root = fresh();
  try {
    memory.logEntry(root, 'error', { class: 'wrong-cause', file: 'src/a.mjs', ts: '2026-09-25T00:00:00Z' });
    memory.logEntry(root, 'error', { class: 'mishandling', file: 'src/b.mjs', ts: '2026-09-25T00:00:00Z' });
    const f = checkRepetition(root, new Date('2026-09-26T00:00:00Z'));
    assert.equal(f.level, LEVEL.GOOD);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: a real repetition ratio above the threshold warns, with a hotspot', () => {
  const root = fresh();
  try {
    // One repeated file+class inside 7 new errors -> ratio well above 15%.
    memory.logEntry(root, 'error', { class: 'wrong-cause', file: 'src/hot.mjs', ts: '2026-08-30T00:00:00Z' });
    memory.logEntry(root, 'error', { class: 'wrong-cause', file: 'src/hot.mjs', ts: '2026-09-25T00:00:00Z' });
    const f = checkRepetition(root, new Date('2026-09-26T00:00:00Z'));
    assert.equal(f.level, LEVEL.WARN);
    assert.match(f.text, /src\/hot\.mjs/);
    assert.ok(f.advice);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- closed-without-evidence -------------------------------------------

test('closed-without-evidence: good with no closed error-derived duties', () => {
  const root = fresh();
  try {
    const f = checkClosedWithoutEvidence(root);
    assert.equal(f.level, LEVEL.GOOD);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('closed-without-evidence: good once memory.closeDuty enforces the check going forward', () => {
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', {
      class: 'x', title: 'boom', guard: { kind: 'present', path: 'src/x.mjs' },
    }).entry;
    const duty = memory.logEntry(root, 'duty', { title: 'guard', error_ids: [err.id] }).entry;
    memory.closeDuty(root, duty.id, { state: 'done' });
    const f = checkClosedWithoutEvidence(root);
    assert.equal(f.level, LEVEL.GOOD);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: a duty closed without evidence through an OLDER path is caught', () => {
  // Simulates pre-F4 data: a closing line written directly, bypassing
  // memory.closeDuty entirely (exactly what an older build, or a write
  // path outside memory.mjs, would have left behind).
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', { class: 'x', title: 'boom' }).entry;
    const duty = memory.logEntry(root, 'duty', { title: 'guard', error_ids: [err.id] }).entry;
    memory.logEntry(root, 'duty', { closes_id: duty.id, state: 'done' });
    const f = checkClosedWithoutEvidence(root);
    assert.equal(f.level, LEVEL.WARN);
    assert.match(f.text, new RegExp(duty.id));
    assert.ok(f.advice);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- auto-duty-age -------------------------------------------------------

test('auto-duty-age: good with no open auto-duties', () => {
  const root = fresh();
  try {
    const f = checkAutoDutyAge(root);
    assert.equal(f.level, LEVEL.GOOD);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('auto-duty-age: a fresh auto-duty is not counted as old', () => {
  const root = fresh();
  try {
    const t1 = memory.logEntry(root, 'error', {
      class: 'x', file: 'src/a.mjs', ts: '2026-09-25T00:00:00Z',
    }).entry;
    const t2 = memory.logEntry(root, 'error', {
      class: 'x', file: 'src/a.mjs', ts: '2026-09-26T00:00:00Z',
    }).entry;
    errorcontext.checkAndDuty(root, t2, { now: new Date('2026-09-26T00:00:00Z') });
    const f = checkAutoDutyAge(root, new Date('2026-09-26T01:00:00Z'));
    assert.equal(f.level, LEVEL.GOOD);
    assert.match(f.text, /0 of 1 open auto-duties/);
    void t1;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: more than 20 old open auto-duties warns (the abort criterion)', () => {
  const root = fresh();
  try {
    for (let i = 0; i < 21; i += 1) {
      const a = memory.logEntry(root, 'error', {
        class: `class-${i}`, file: `src/f${i}.mjs`, ts: '2026-08-01T00:00:00Z',
      }).entry;
      const b = memory.logEntry(root, 'error', {
        class: `class-${i}`, file: `src/f${i}.mjs`, ts: '2026-08-10T00:00:00Z',
      }).entry;
      errorcontext.checkAndDuty(root, b, { now: new Date('2026-08-10T00:00:00Z') });
      void a;
    }
    const f = checkAutoDutyAge(root, new Date('2026-09-26T00:00:00Z'));
    assert.equal(f.level, LEVEL.WARN);
    assert.match(f.text, /21 of 21 open auto-duties/);
    assert.match(f.advice, /abort criterion/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('exactly 20 old open auto-duties does NOT warn — the threshold is "more than 20"', () => {
  const root = fresh();
  try {
    for (let i = 0; i < 20; i += 1) {
      const a = memory.logEntry(root, 'error', {
        class: `class-${i}`, file: `src/f${i}.mjs`, ts: '2026-08-01T00:00:00Z',
      }).entry;
      const b = memory.logEntry(root, 'error', {
        class: `class-${i}`, file: `src/f${i}.mjs`, ts: '2026-08-10T00:00:00Z',
      }).entry;
      errorcontext.checkAndDuty(root, b, { now: new Date('2026-08-10T00:00:00Z') });
      void a;
    }
    const f = checkAutoDutyAge(root, new Date('2026-09-26T00:00:00Z'));
    assert.equal(f.level, LEVEL.GOOD);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
