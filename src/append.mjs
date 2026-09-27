// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * append.mjs — the ONE place a JSONL drawer is appended to.
 *
 * ## The finding (measured 2026-09-20)
 *
 * Every append path in this house wrote
 * `fs.appendFileSync(p, `${line}\n`, 'utf8')` directly and assumed the
 * file already ended on a newline. When it does not — a file written
 * from outside, a write cut short, a full disk — the new line FUSES
 * with the last one into a single broken JSONL line.
 *
 * Measured with a drawer holding exactly one entry and no trailing
 * newline, one `mem log error` over it, then `readLog()`:
 *
 *     valid: 0   broken: 1   total: 1
 *
 * Two entries in, zero readable out. It is not the new entry that is
 * lost but BOTH — and the old one was fine before. That is the
 * expensive part: a write makes existing corpus unreadable.
 *
 * ## The LAST BYTE only, never the whole file
 *
 * The check is `fs.openSync` + `fs.readSync` at `size - 1` — one byte,
 * however large the drawer has grown. The obvious version
 * (`fs.readFileSync(p).endsWith('\n')`) would be exactly the quadratic
 * mistake this house has already fixed in three other places: every
 * write reading the whole corpus.
 *
 * **What it costs, measured 2026-09-20** (5000 appends onto a drawer
 * that grows to 1.06 MB in the process, median of four runs): bare
 * append 0.0045 ms, with the check 0.0116 ms — 0.0071 ms added per
 * write. The surcharge is CONSTANT: exactly one byte is read, however
 * large the drawer is. For scale, `memory.logEntry`'s own comment puts
 * an `fsync` on this path at 0.24–0.29 ms.
 *
 * **Why a BYTE is right here, not a character.** In UTF-8 `\n` (0x0A)
 * is never part of a multi-byte sequence: every continuation byte has
 * the high bit set (0x80–0xBF) and every lead byte sits at 0xC2–0xF4.
 * A trailing 0x0A can therefore only be a real line break, and a
 * trailing byte that is not 0x0A can only mean the file does not end
 * on one — even when the last line ends in an emoji or an accented
 * character.
 *
 * ## One single write
 *
 * The repair newline is PREPENDED to the text and everything goes out
 * in ONE `appendFileSync`, not two. Two calls would give up the
 * atomicity `test/concurrent-append.test.mjs` rests on (O_APPEND
 * writes one call below PIPE_BUF in one piece; two calls can be split
 * apart by a foreign writer).
 *
 * ## What a race does
 *
 * Another writer can slip in between the check and the append. The
 * worst case is that BOTH see the missing newline and both prepend one
 * — leaving an EMPTY line in the file. Every reader in this house
 * skips empty lines (`if (!line.trim()) continue`), so no entry is
 * lost. The opposite case — both seeing a newline that is not there —
 * cannot happen, because a missing newline only disappears by someone
 * writing one.
 *
 * Error class of the finding: loss-or-overwrite.
 *
 * ## ENOSPC-safe since 2026-09-27: a torn write is never left standing
 *
 * **The finding this section answers.** cheap-mem's sibling house
 * (lucky-mem) hit a full disk mid-append: `fs.appendFileSync` broke a
 * write into more than one `write(2)` call, the disk filled between
 * them, and the half that landed — a truncated JSONL line — was
 * committed on the next pass, because nothing on that write path had
 * ever checked how much actually reached the drawer, only whether the
 * call itself threw. This module's own `appendLine` used the same
 * primitive, so the same failure was reachable here too, on any of the
 * ~12 modules that call it (see `test/append-enospc.test.mjs`).
 *
 * **What `write(2)` actually does at ENOSPC.** POSIX: if the kernel can
 * fit at least one byte, `write()` returns that count — no error, a
 * SHORT write. Only when it cannot fit anything does it return `-1`/
 * `ENOSPC`. Node's `fs.writeSync` mirrors this exactly: a short write
 * returns the real byte count (no throw), and it only throws when
 * nothing at all went through. So the append below treats both shapes
 * the same way — it never trusts the return value alone, it measures
 * the file afterward (`fstatSync`) instead of assuming a throw means
 * zero bytes landed.
 *
 * **Why this needs its own `write()`, not a second `appendFileSync`.**
 * `fs.appendFileSync` calls `fs.writeFileSync` internally, which can
 * loop over several `write()` calls for a large buffer. Two calls can
 * be torn apart by a foreign writer in between (the same PIPE_BUF
 * reasoning as "One single write" above) — so the safety net has to sit
 * around the SAME single `open` + one `writeSync` + `close` this module
 * already used for the success path; only the handling after a
 * short/failed write is new.
 *
 * **The rollback is not an edit of an existing line.** Design
 * commitment 1 in `CLAUDE.md` ("Append-only. No function may modify an
 * existing JSONL line.") governs a line that a write already handed
 * back as committed — content a reader could already have seen. A
 * short write or a write that threw never reached that point: nothing
 * was returned to the caller, nothing became a readable entry, and the
 * promise this module makes ("a call lands the WHOLE line or none of
 * it") was not kept. `fs.ftruncateSync(fd, sizeBefore)` undoes only the
 * bytes THIS call itself just placed, back to the size the file had the
 * instant before this one `writeSync`. That is the same operation as an
 * editor's undo on its own last, unfinished keystroke — not the
 * backward correction on a landed line that this house forbids and
 * that `memory.correctionEntry()` exists to do properly instead.
 *
 * **The one way that rollback could go wrong, and why it does not.** If
 * another writer appends its own full line in the gap between our
 * short/failed write and the truncate, a truncate to `sizeBefore` would
 * cut off part of THEIR line too — worse than leaving our own fragment
 * in place. So the truncate only fires when the file, measured again
 * right before truncating, is still sitting at EXACTLY this call's own
 * end position (`sizeBefore` + the bytes this call actually placed). If
 * it is higher, a foreign write landed in between; nothing is
 * truncated, the file keeps our fragment, and the thrown error carries
 * `torn: true` so the caller can name the fragment instead of it living
 * unnamed in the corpus (see `test/append-enospc.test.mjs`,
 * "a foreign writer between the short write and the truncate"). A race
 * can therefore never erase a foreign line that fully landed — a
 * truncate only ever removes exactly the bytes this one failed call
 * itself just added, nothing that arrived before or after it.
 *
 * **Considered and dropped: checking free space first
 * (`fs.statfsSync`).** Cheap (single-digit microseconds), but useless as
 * a guard: between the check and this call's own `writeSync`, any other
 * process on the same disk can consume the remaining bytes — the check
 * would read green and the write would still come up short. Only a
 * check AFTER the attempt is independent of exactly when the disk
 * filled.
 *
 * **Never silent.** A failed append always throws `AppendError` — never
 * `undefined`, never a caught-and-swallowed failure that reads as
 * success. "Not written" is a state a caller must be told, not one it
 * has to guess by reading the file back.
 */

import fs from 'node:fs';

/**
 * Thrown by the low-level append below when a SINGLE append attempt did
 * not go through completely — whether the cause was a hard error
 * (`ENOSPC` and kin) or a bare short write. The caller always gets an
 * exception, never a swallowed `undefined`.
 *
 * `torn: false` — the common case. The file is back at EXACTLY the size
 * it had before this call; nothing was committed, nothing was damaged.
 *
 * `torn: true` — the rare, expensive case: a foreign writer appended
 * between our failed write and the attempt to roll it back. Truncating
 * now would cut off part of THEIR line too, which is worse than leaving
 * our own fragment in place. The file is left unchanged (fragment and
 * all); the caller learns about it through this field and can name it
 * (e.g. a `*-tears.jsonl` record), instead of it sitting unnamed in the
 * corpus.
 */
export class AppendError extends Error {
  constructor(message, { filePath, torn, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AppendError';
    this.filePath = filePath;
    this.torn = !!torn;
  }
}

/**
 * Append `buffer` (finished bytes, including any leading-newline repair)
 * to `filePath` in EXACTLY ONE `fs.writeSync` call. On error or short
 * write: roll back to the size the file had immediately before this
 * call, then throw `AppendError` — see the "ENOSPC-safe" section in the
 * module docstring above for the full reasoning (why one write, why the
 * rollback does not break append-only, and the concurrency rule that
 * stops it from ever truncating a foreign line).
 */
function writeAtomicAppend(filePath, buffer) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'a');
  } catch (e) {
    throw new AppendError(`appendLine: could not open '${filePath}' for appending: ${e.message}`,
      { filePath, torn: false, cause: e });
  }
  try {
    let sizeBefore;
    try {
      sizeBefore = fs.fstatSync(fd).size;
    } catch (e) {
      throw new AppendError(
        `appendLine: could not measure the size of '${filePath}' before writing: ${e.message}`,
        { filePath, torn: false, cause: e });
    }

    let written = 0;
    let writeError = null;
    try {
      // EXACTLY one call, this exact buffer — see "One single write" and
      // "Why this needs its own write()" above.
      written = fs.writeSync(fd, buffer, 0, buffer.length);
    } catch (e) {
      writeError = e;
    }

    if (!writeError && written === buffer.length) {
      return; // full success — the common case, one write, done.
    }

    // Short write or hard error: how much actually reached the disk?
    // The return value is not trustworthy after a throw (Node does not
    // hand one back then) — measure instead of guessing.
    let bytesOnDisk = written;
    if (writeError) {
      try { bytesOnDisk = Math.max(0, fs.fstatSync(fd).size - sizeBefore); }
      catch { bytesOnDisk = written; }
    }

    const ownEnd = sizeBefore + bytesOnDisk;
    let sizeNow;
    try { sizeNow = fs.fstatSync(fd).size; } catch { sizeNow = null; }

    let torn = true;
    if (sizeNow === ownEnd) {
      try {
        fs.ftruncateSync(fd, sizeBefore);
        torn = false;
      } catch { /* the truncate itself failed: the tear stands */ }
    }

    const reason = writeError
      ? writeError.message
      : `only ${bytesOnDisk} of ${buffer.length} bytes were written`;
    throw new AppendError(
      torn
        ? `appendLine: write to '${filePath}' aborted (${reason}) — another writer was already `
          + `ahead of us, so our own fragment (${bytesOnDisk} bytes) is left untruncated. Nothing `
          + 'was committed; the fragment must be named as a tear.'
        : `appendLine: write to '${filePath}' aborted (${reason}) — truncated back to ${sizeBefore} `
          + 'bytes, the file is byte-identical to before this call. Nothing was committed.',
      { filePath, torn, cause: writeError },
    );
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Does the file end on bytes but not on `\n`?
 *
 * `false` for: file does not exist, file is empty, file ends on `\n`,
 * or the last byte cannot be read. In all of those NOTHING may be
 * prepended — a leading newline in a new or empty file would be an
 * empty first line, exactly the mess this module exists to prevent.
 */
export function endsWithoutNewline(filePath) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return false; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const probe = Buffer.alloc(1);
    if (fs.readSync(fd, probe, 0, 1, size - 1) !== 1) return false;
    return probe[0] !== 0x0A;
  } catch {
    return false;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Append `text` to `filePath`, healing a missing newline at the end of
 * the file first.
 *
 * `text` brings its own trailing `\n`; this function only decides about
 * the LEADING one. Callers appending a whole block of several lines can
 * therefore use it unchanged.
 *
 * `checkNewline: false` turns the healing off. That is **for probes
 * only**: a promise you cannot break measures nothing.
 * `test/append-newline.test.mjs` uses it to show the loss comes back
 * without the check.
 *
 * **ENOSPC-safe since 2026-09-27:** the write itself goes through
 * `writeAtomicAppend()` above — a single low-level write, rolled back
 * to this call's own pre-write size on error or short write. A failed
 * append throws `AppendError` (with `.torn`) rather than leaving a
 * fragment behind unannounced; every caller already let the previous
 * primitive's failures propagate with no `try`/`catch` of its own (see
 * `src/memory.mjs`, `src/heartbeat.mjs`, `src/board.mjs` and the rest of
 * the ~12 callers), so nothing here changes who catches what — only
 * what the file looks like after a failure.
 */
export function appendLine(filePath, text, { checkNewline = true } = {}) {
  const prefix = (checkNewline && endsWithoutNewline(filePath)) ? '\n' : '';
  writeAtomicAppend(filePath, Buffer.from(prefix + text, 'utf8'));
  return { healed: prefix.length > 0 };
}
