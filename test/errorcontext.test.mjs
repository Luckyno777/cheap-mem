// test/errorcontext.test.mjs — F1/F2 (BAUPLAN-mem-admin_02.md Block F,
// ported from lucky-mem/src/fehlerkontext.mjs, as F4): the write-time
// history hint and the auto-duty-on-repetition path, plus the evidence
// check they share with `memory.closeDuty()`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as errorcontext from '../src/errorcontext.mjs';

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-errctx-'));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  return root;
}

test('historyLines is [] with no earlier error for the file', () => {
  const root = fresh();
  try {
    const { entry } = memory.logEntry(root, 'error', { class: 'wrong-cause', file: 'src/x.mjs', title: 'first' });
    assert.deepEqual(errorcontext.historyLines(root, entry), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('historyLines shows up to three earlier errors for the same file, newest first', () => {
  const root = fresh();
  try {
    for (let i = 0; i < 4; i += 1) {
      memory.logEntry(root, 'error', {
        class: 'wrong-cause', file: 'src/x.mjs', title: `attempt ${i}`, ts: `2026-09-0${i + 1}T00:00:00Z`,
      });
    }
    const { entry } = memory.logEntry(root, 'error', {
      class: 'wrong-cause', file: 'src/x.mjs', title: 'latest', ts: '2026-09-10T00:00:00Z',
    });
    const lines = errorcontext.historyLines(root, entry);
    assert.match(lines[0], /Earlier for src\/x\.mjs/);
    // header + at most 3 entries
    assert.ok(lines.length <= 4, lines.join('\n'));
    assert.match(lines[1], /attempt 3/, 'should show the newest earlier one first');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: checkAndDuty creates a duty on a real repetition', () => {
  const root = fresh();
  try {
    memory.logEntry(root, 'error', {
      class: 'wrong-cause', file: 'src/x.mjs', title: 'first', ts: '2026-08-30T00:00:00Z',
    });
    const { entry } = memory.logEntry(root, 'error', {
      class: 'wrong-cause', file: 'src/x.mjs', title: 'second', ts: '2026-09-10T00:00:00Z',
    });
    const r = errorcontext.checkAndDuty(root, entry, { now: new Date('2026-09-10T00:00:00Z') });
    assert.equal(r.triggered, true);
    assert.equal(r.created, true);
    assert.match(r.duty.title, /Guard for wrong-cause at src\/x\.mjs/);
    // Both the triggering error AND the earlier one it repeats travel
    // together onto the new duty — the whole point is to track the
    // WHOLE file+class history, not only the entry that just fired it.
    assert.equal(r.duty.error_ids.length, 2);
    assert.ok(r.duty.error_ids.includes(entry.id));
    assert.equal(r.duty[errorcontext.AUTOMATIC_FIELD], true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no repetition -> no duty', () => {
  const root = fresh();
  try {
    const { entry } = memory.logEntry(root, 'error', { class: 'wrong-cause', file: 'src/x.mjs', title: 'only one' });
    const r = errorcontext.checkAndDuty(root, entry);
    assert.equal(r.triggered, false);
    const { open } = memory.openDuties(root);
    assert.equal(open.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a SECOND repetition on the same file+class appends, it does not open a second duty', () => {
  const root = fresh();
  try {
    const t1 = memory.logEntry(root, 'error', {
      class: 'wrong-cause', file: 'src/x.mjs', title: 'first', ts: '2026-08-01T00:00:00Z',
    }).entry;
    const t2 = memory.logEntry(root, 'error', {
      class: 'wrong-cause', file: 'src/x.mjs', title: 'second', ts: '2026-08-10T00:00:00Z',
    }).entry;
    const r1 = errorcontext.checkAndDuty(root, t2, { now: new Date('2026-08-10T00:00:00Z') });
    assert.equal(r1.created, true);

    const t3 = memory.logEntry(root, 'error', {
      class: 'wrong-cause', file: 'src/x.mjs', title: 'third', ts: '2026-08-20T00:00:00Z',
    }).entry;
    const r2 = errorcontext.checkAndDuty(root, t3, { now: new Date('2026-08-20T00:00:00Z') });
    assert.equal(r2.created, false);
    assert.equal(r2.appended, true);
    // The correction is a NEW append-only line (`replaces_id`), so it
    // carries a NEW id of its own — the guarantee is not "the id never
    // changes", it is "openDuties() folds the chain to one entry".
    assert.notEqual(r2.duty.id, r1.duty.id, 'a correction is a new line, not a rewrite of the old one');
    assert.ok(r2.duty.error_ids.includes(t1.id) && r2.duty.error_ids.includes(t2.id)
      && r2.duty.error_ids.includes(t3.id));

    // The whole point of F1: exactly ONE open duty per file+class, not a flood.
    const { open } = memory.openDuties(root);
    const matching = open.filter((d) => d.file === 'src/x.mjs' && d.class === 'wrong-cause');
    assert.equal(matching.length, 1);
    assert.equal(matching[0].id, r2.duty.id, 'the newest stage of the chain is the one that counts as open');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('appending the SAME error id again is a no-op, not an empty correction line', () => {
  const root = fresh();
  try {
    memory.logEntry(root, 'error', {
      class: 'wrong-cause', file: 'src/x.mjs', title: 'first', ts: '2026-08-01T00:00:00Z',
    });
    const t2 = memory.logEntry(root, 'error', {
      class: 'wrong-cause', file: 'src/x.mjs', title: 'second', ts: '2026-08-10T00:00:00Z',
    }).entry;
    const r1 = errorcontext.checkAndDuty(root, t2, { now: new Date('2026-08-10T00:00:00Z') });
    const beforeLines = fs.readFileSync(path.join(root, 'global', 'duties.jsonl'), 'utf8').trim().split('\n').length;
    const r2 = errorcontext.checkAndDuty(root, t2, { now: new Date('2026-08-10T00:00:00Z') });
    assert.equal(r2.appended, false);
    assert.equal(r2.created, false);
    const afterLines = fs.readFileSync(path.join(root, 'global', 'duties.jsonl'), 'utf8').trim().split('\n').length;
    assert.equal(afterLines, beforeLines, 'no new line for an id already tracked');
    assert.equal(r1.duty.id, r2.duty.id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a class-threshold repetition with no determinable file creates no duty', () => {
  const root = fresh();
  try {
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = memory.logEntry(root, 'error', {
        class: 'concurrency', title: `race ${i}`, ts: `2026-09-0${i + 1}T00:00:00Z`,
      }).entry;
    }
    const r = errorcontext.checkAndDuty(root, last, { now: new Date('2026-09-03T00:00:00Z') });
    assert.equal(r.triggered, true);
    assert.equal(r.created, false);
    assert.equal(r.why, 'no determinable file');
    const { open } = memory.openDuties(root);
    assert.equal(open.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- F2/F4: evidence at the close, ported to errorcontext.evidencePresent ---

test('evidencePresent: no error_ids means F4 does not apply', () => {
  const root = fresh();
  assert.equal(errorcontext.evidencePresent(root, { id: 'd1' }).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POSITIVE CONTROL: a guard field on the error IS evidence', () => {
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', {
      class: 'x', title: 'boom', guard: { kind: 'present', path: 'src/x.mjs' },
    }).entry;
    const duty = { id: 'd1', error_ids: [err.id] };
    assert.equal(errorcontext.evidencePresent(root, duty).ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: a test/ file with the marker IS evidence', () => {
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', { class: 'x', title: 'boom' }).entry;
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'guard.test.mjs'),
      `// error: ${err.id}\ntest('x', () => {});\n`);
    const duty = { id: 'd1', error_ids: [err.id] };
    assert.equal(errorcontext.evidencePresent(root, duty).ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SABOTAGE: a comment with the marker but no test( is NOT evidence', () => {
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', { class: 'x', title: 'boom' }).entry;
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'notes.md'), `// error: ${err.id}\njust a note, no probe`);
    const duty = { id: 'd1', error_ids: [err.id] };
    assert.equal(errorcontext.evidencePresent(root, duty).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- The enforcement point: memory.closeDuty / memory.correctionEntry ---

test('closeDuty refuses to close an error-derived duty with no evidence', () => {
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', { class: 'x', title: 'boom' }).entry;
    const duty = memory.logEntry(root, 'duty', { title: 'guard', error_ids: [err.id] }).entry;
    assert.throws(() => memory.closeDuty(root, duty.id, { state: 'done' }), /has no evidence/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: closeDuty succeeds once the guard field is there', () => {
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', {
      class: 'x', title: 'boom', guard: { kind: 'present', path: 'src/x.mjs' },
    }).entry;
    const duty = memory.logEntry(root, 'duty', { title: 'guard', error_ids: [err.id] }).entry;
    const { entry: closed } = memory.closeDuty(root, duty.id, { state: 'done' });
    assert.equal(closed.state, 'done');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('closing a duty with no error_ids needs no evidence at all', () => {
  const root = fresh();
  try {
    const duty = memory.logEntry(root, 'duty', { title: 'plain duty' }).entry;
    const { entry: closed } = memory.closeDuty(root, duty.id, { state: 'done' });
    assert.equal(closed.state, 'done');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dropping (not done) an error-derived duty needs no evidence', () => {
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', { class: 'x', title: 'boom' }).entry;
    const duty = memory.logEntry(root, 'duty', { title: 'guard', error_ids: [err.id] }).entry;
    const { entry: closed } = memory.closeDuty(root, duty.id, { state: 'dropped' });
    assert.equal(closed.state, 'dropped');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a correction cannot walk around the same check by writing closes_id itself', () => {
  const root = fresh();
  try {
    const err = memory.logEntry(root, 'error', { class: 'x', title: 'boom' }).entry;
    const duty = memory.logEntry(root, 'duty', { title: 'guard', error_ids: [err.id] }).entry;
    assert.throws(
      () => memory.correctionEntry(root, 'duty', duty.id, {
        title: 'guard', error_ids: [err.id], closes_id: duty.id, state: 'done',
      }),
      /has no evidence/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
