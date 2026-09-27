// Guard for `src/append.mjs` — a full disk must never leave a half
// line standing.
//
// **The finding this guards against (lucky-mem, 2026-09-27,
// jpa6hnu3g9o3).** At full disk, an append to a journal drawer broke
// off after 47 of a much longer line's bytes. Nothing on that write
// path had ever checked how much actually reached the drawer, only
// whether the call itself threw — so the fragment sat there, looking
// like the tail of a valid line, until the next commit picked it up.
// cheap-mem's `appendLine` (src/append.mjs) used the same primitive
// (`fs.appendFileSync`, which can split a large buffer into more than
// one `write(2)` call) and was reachable the same way, from any of the
// roughly dozen modules that call it (store, shardarchive, memory,
// console, injection, chain, observations, raw, tasks, board, archive,
// heartbeat).
//
// **How ENOSPC is simulated here.** No real full disk (that would be
// destructive and is out of scope for a guard test) — `fs.writeSync` is
// stubbed for exactly ONE call so it only actually writes a PART of the
// buffer (through the real, underlying `writeSync`) and then either
// returns that short count with no throw (the common POSIX shape at
// ENOSPC: the kernel hands back whatever it could fit) or throws an
// ENOSPC-flavoured error (the rarer shape: nothing at all fit). Both
// reach `writeAtomicAppend` in `src/append.mjs`; see that module's
// header for why it treats them the same way.
//
//     node --test test/append-enospc.test.mjs
//
// invariant: own-fragment-never-foreign-line
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLine, AppendError } from '../src/append.mjs';

function tempFile(name = 'journal.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-append-enospc-'));
  return path.join(dir, name);
}

/**
 * Replaces `fs.writeSync` for the duration of the enclosing test with a
 * version that really writes only `upToBytes` of the given buffer
 * (through the REAL `writeSync`), then either returns that short count
 * (`mode: 'short'`, no throw — the common POSIX shape) or throws an
 * ENOSPC error (`mode: 'throw'`). Only the FIRST call is intercepted;
 * every later call (e.g. from a foreign writer, or a caller retrying)
 * goes through untouched.
 */
function stubShortWrite({ upToBytes, mode = 'short' }) {
  const real = fs.writeSync;
  let called = false;
  fs.writeSync = (fd, buffer, offset, length, ...rest) => {
    if (called) return real(fd, buffer, offset, length, ...rest);
    called = true;
    const partLength = Math.min(upToBytes, length);
    const written = real(fd, buffer, offset, partLength);
    if (mode === 'throw') {
      const e = new Error('ENOSPC: no space left on device, write');
      e.code = 'ENOSPC';
      throw e;
    }
    return written; // short write, NO throw — the common ENOSPC shape.
  };
  return () => { fs.writeSync = real; };
}

// ---------------------------------------------------------------
// Positive control: the normal path is untouched
// ---------------------------------------------------------------

test('POSITIVE CONTROL: a normal append is still exactly one writeSync call', () => {
  const p = tempFile();
  fs.writeFileSync(p, '{"a":1}\n', 'utf8');
  const real = fs.writeSync;
  let calls = 0;
  fs.writeSync = (...a) => { calls += 1; return real(...a); };
  try {
    appendLine(p, '{"a":2}\n');
  } finally {
    fs.writeSync = real;
  }
  assert.equal(calls, 1, 'a normal append must not fall apart into more than one writeSync call');
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}\n{"a":2}\n');
});

// ---------------------------------------------------------------
// RED -> GREEN: short write, no throw (the common ENOSPC shape)
// ---------------------------------------------------------------

test('short write with no throw: the file is rolled back byte-identical to before the call', () => {
  const p = tempFile();
  const before = '{"a":1}\n{"a":2}\n';
  fs.writeFileSync(p, before, 'utf8');
  const beforeBytes = fs.readFileSync(p);

  const line = `${JSON.stringify({ a: 3, text: 'x'.repeat(200) })}\n`;
  const restore = stubShortWrite({ upToBytes: 47 });
  let error;
  try {
    try { appendLine(p, line); } catch (e) { error = e; }
  } finally {
    restore();
  }

  assert.ok(error instanceof AppendError, 'a failed append must throw, never fail silently');
  assert.equal(error.torn, false, 'no foreign writer was involved — this must not be reported as a tear');
  assert.equal(error.filePath, p);
  assert.deepEqual(fs.readFileSync(p), beforeBytes,
    'the file must be BYTE-IDENTICAL to its state before the failed append');
});

// ---------------------------------------------------------------
// RED -> GREEN: throw AFTER a partial write landed
// ---------------------------------------------------------------

test('throw after a partial write: the same rollback, the same byte-identity', () => {
  const p = tempFile();
  const before = '{"a":1}\n';
  fs.writeFileSync(p, before, 'utf8');
  const beforeBytes = fs.readFileSync(p);

  const line = `${JSON.stringify({ a: 2, text: 'y'.repeat(500) })}\n`;
  const restore = stubShortWrite({ upToBytes: 47, mode: 'throw' });
  let error;
  try {
    try { appendLine(p, line); } catch (e) { error = e; }
  } finally {
    restore();
  }

  assert.ok(error instanceof AppendError);
  assert.match(error.message, /ENOSPC/);
  assert.equal(error.torn, false);
  assert.deepEqual(fs.readFileSync(p), beforeBytes,
    'a throw WITH a preceding partial write must still be rolled back');
});

// ---------------------------------------------------------------
// Full failure, not a single byte written: nothing to truncate, still an error
// ---------------------------------------------------------------

test('total failure with zero bytes written: file unchanged, still throws', () => {
  const p = tempFile();
  fs.writeFileSync(p, '{"a":1}\n', 'utf8');
  const beforeBytes = fs.readFileSync(p);
  const restore = stubShortWrite({ upToBytes: 0, mode: 'throw' });
  let error;
  try {
    try { appendLine(p, '{"a":2}\n'); } catch (e) { error = e; }
  } finally {
    restore();
  }
  assert.ok(error instanceof AppendError);
  assert.equal(error.torn, false);
  assert.deepEqual(fs.readFileSync(p), beforeBytes);
});

// ---------------------------------------------------------------
// Concurrency: rolling back our own fragment must NEVER cut a foreign line
// ---------------------------------------------------------------

test('CONCURRENCY: a foreign writer between the short write and the truncate check — no truncation, tear reported, foreign line intact', () => {
  const p = tempFile();
  fs.writeFileSync(p, '{"a":1}\n', 'utf8');
  const beforeSize = fs.statSync(p).size;

  const line = `${JSON.stringify({ a: 2, text: 'z'.repeat(300) })}\n`;
  const foreignLine = `${JSON.stringify({ a: 'FOREIGN', by: 'another-process' })}\n`;

  // `fs.fstatSync` is stubbed so that, between OUR failed write (the
  // measurement of what actually landed) and OUR truncate check (is the
  // file still exactly at our own end position?), a second, independent
  // fd appends a full, unrelated line — the exact window
  // `writeAtomicAppend`'s concurrency rule (src/append.mjs) is about.
  const realFstatSync = fs.fstatSync;
  let fstatCalls = 0;
  let foreignWritten = false;
  fs.fstatSync = (fd) => {
    fstatCalls += 1;
    // 1st call = size-before (inside writeAtomicAppend). The write
    // below is a short write with NO throw, so no extra "measure bytes
    // on disk" fstat call happens in between — the 2nd call is the
    // "is the file still at our own end position" check. That is
    // exactly where the foreign writer must land to exercise the rule.
    if (fstatCalls === 2 && !foreignWritten) {
      foreignWritten = true;
      const foreignFd = fs.openSync(p, 'a');
      try { fs.writeSync(foreignFd, Buffer.from(foreignLine, 'utf8')); }
      finally { fs.closeSync(foreignFd); }
    }
    return realFstatSync(fd);
  };
  const restore = stubShortWrite({ upToBytes: 30, mode: 'short' });
  let error;
  try {
    // checkNewline: false — endsWithoutNewline() would spend its own
    // fstatSync call, and this test counts calls precisely to land the
    // foreign write on the exact one that matters.
    try { appendLine(p, line, { checkNewline: false }); } catch (e) { error = e; }
  } finally {
    restore();
    fs.fstatSync = realFstatSync;
  }

  assert.ok(error instanceof AppendError, 'the tear case must still throw');
  assert.equal(error.torn, true, 'a foreign writer was already ahead of us — this MUST be reported as a tear');

  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.startsWith('{"a":1}\n'), 'the pre-existing line must not be touched');
  // Our own fragment (the first 30 bytes of the new line) is still
  // there — NOT truncated, because truncating would have cut into the
  // foreign line that landed right behind it:
  const ownFragment = line.slice(0, 30);
  assert.ok(content.includes(ownFragment),
    'our own fragment must not disappear — a truncate here would have cut the foreign line');
  // And the foreign line is whole and untouched:
  assert.ok(content.includes(foreignLine), 'the foreign line must survive completely intact');
  assert.equal(content.endsWith(foreignLine), true);
  assert.equal(fs.statSync(p).size, beforeSize + 30 + Buffer.byteLength(foreignLine, 'utf8'));
});

// ---------------------------------------------------------------
// The normal healing path (leading-newline repair) is unaffected
// ---------------------------------------------------------------

test('the missing-newline repair still works when the append itself succeeds', () => {
  const p = tempFile();
  fs.writeFileSync(p, '{"a":1}', 'utf8'); // deliberately no trailing \n
  const { healed } = appendLine(p, '{"a":2}\n');
  assert.equal(healed, true);
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}\n{"a":2}\n');
});
