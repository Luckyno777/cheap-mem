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
import path from 'node:path';
import { appendLine, AppendError } from '../src/append.mjs';
import { tempDir } from './temp-dir.mjs';

function tempFile(t, name = 'journal.jsonl') {
  const dir = tempDir('cm-append-enospc-', t);
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

test('POSITIVE CONTROL: a normal append is still exactly one writeSync call', (t) => {
  const p = tempFile(t);
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

test('short write with no throw: the fragment stays (never truncated), torn:true and written name it (audit F01)', (t) => {
  const p = tempFile(t);
  const before = '{"a":1}\n{"a":2}\n';
  fs.writeFileSync(p, before, 'utf8');

  const line = `${JSON.stringify({ a: 3, text: 'x'.repeat(200) })}\n`;
  const restore = stubShortWrite({ upToBytes: 47 });
  const realTruncate = fs.ftruncateSync;
  let truncates = 0;
  fs.ftruncateSync = (...x) => { truncates += 1; return realTruncate(...x); };
  let error;
  try {
    try { appendLine(p, line); } catch (e) { error = e; }
  } finally {
    restore();
    fs.ftruncateSync = realTruncate;
  }

  assert.ok(error instanceof AppendError, 'a failed append must throw, never fail silently');
  assert.equal(error.torn, true, 'a fragment stands: no clean-rollback acquittal');
  assert.equal(error.written, 47);
  assert.equal(error.filePath, p);
  assert.equal(truncates, 0, 'never ftruncate');
  assert.equal(fs.readFileSync(p, 'utf8'), before + line.slice(0, 47));
  // The next append does not glue onto the fragment.
  appendLine(p, '{"a":4}\n');
  assert.ok(fs.readFileSync(p, 'utf8').endsWith(`${line.slice(0, 47)}\n{"a":4}\n`));
});

// ---------------------------------------------------------------
// RED -> GREEN: throw AFTER a partial write landed
// ---------------------------------------------------------------

test('throw after a partial write: never truncated (a throw cannot be told apart from a foreign line), reported as a tear', (t) => {
  const p = tempFile(t);
  const before = '{"a":1}\n';
  fs.writeFileSync(p, before, 'utf8');

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
  assert.equal(error.torn, true, 'growth after a throw is ambiguous: named as a tear, never cut');
  assert.equal(fs.readFileSync(p, 'utf8'), before + line.slice(0, 47));
});

// y0 (2026-09-30): a THROW wrote nothing (POSIX). A foreign line that lands
// between the size reading and our failing write must survive.
test('y0 REGRESSION: foreign line between size reading and a failing own write survives', (t) => {
  const p = tempFile(t);
  fs.writeFileSync(p, 'original\n', 'utf8');
  const real = fs.writeSync;
  let n = 0;
  fs.writeSync = function () {
    if (n++ === 0) fs.appendFileSync(p, 'FREMD\n');
    const e = new Error('ENOSPC: no space left'); e.code = 'ENOSPC'; throw e;
  };
  let error;
  try { try { appendLine(p, 'mine\n'); } catch (e) { error = e; } } finally { fs.writeSync = real; }
  assert.ok(error instanceof AppendError);
  assert.equal(fs.readFileSync(p, 'utf8'), 'original\nFREMD\n', 'the foreign line must still be there');
});

// ---------------------------------------------------------------
// Full failure, not a single byte written: nothing to truncate, still an error
// ---------------------------------------------------------------

test('total failure with zero bytes written: file unchanged, still throws', (t) => {
  const p = tempFile(t);
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

test('CONCURRENCY: a confirmed foreign line right behind our short write survives (the old truncate cut it)', (t) => {
  const p = tempFile(t);
  fs.writeFileSync(p, '{"a":1}\n', 'utf8');
  const line = `${JSON.stringify({ a: 2, text: 'z'.repeat(300) })}\n`;
  const foreignLine = `${JSON.stringify({ a: 'FOREIGN', by: 'another-process' })}\n`;

  // Our short write lands 30 bytes; right after it (the window the old
  // fstat + ftruncate pair was exposed to) an independent writer appends a
  // full, confirmed line. Nothing may remove it.
  const real = fs.writeSync;
  let first = true;
  fs.writeSync = (fd, buffer, offset, length, ...rest) => {
    if (!first) return real(fd, buffer, offset, length, ...rest);
    first = false;
    const n = real(fd, buffer, offset, 30);
    const foreignFd = fs.openSync(p, 'a');
    try { real(foreignFd, Buffer.from(foreignLine, 'utf8')); } finally { fs.closeSync(foreignFd); }
    return n;
  };
  let error;
  try {
    try { appendLine(p, line, { checkNewline: false }); } catch (e) { error = e; }
  } finally {
    fs.writeSync = real;
  }

  assert.ok(error instanceof AppendError, 'the tear case must still throw');
  assert.equal(error.torn, true);
  const content = fs.readFileSync(p, 'utf8');
  assert.equal(content, `{"a":1}\n${line.slice(0, 30)}${foreignLine}`, 'fragment and the foreign line both stand');
});

// ---------------------------------------------------------------
// The normal healing path (leading-newline repair) is unaffected
// ---------------------------------------------------------------

test('the missing-newline repair still works when the append itself succeeds', (t) => {
  const p = tempFile(t);
  fs.writeFileSync(p, '{"a":1}', 'utf8'); // deliberately no trailing \n
  const { healed } = appendLine(p, '{"a":2}\n');
  assert.equal(healed, true);
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}\n{"a":2}\n');
});
