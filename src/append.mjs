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
 * **NEVER truncated (audit F01, 2026-10-06).** Earlier, after a short
 * write the append measured the file (`fstat`: still at my own end?) and
 * then `ftruncate`d back to the size before. The two steps are not
 * atomic: another process could append successfully between the `fstat`
 * and the `ftruncate`, and the truncate cut off its CONFIRMED line — with
 * the error saying `torn: false`. The old claim "a full foreign append can
 * never be lost" was disproved (reproduced with two processes); a second
 * `fstat` does not close the window.
 *
 * A truncate is safe only with guaranteed exclusive write rights, and
 * those cannot be had here: (a) many writers in this house append
 * directly (`fs.appendFileSync`, hooks, scripts, `git`), a lock inside
 * `appendLine` does not bind them; (b) `withLock` is a leaf lock — a
 * caller that already holds one would get `NestedLockError`; (c) every
 * append would pay lock create, bar and release instead of one `write()`.
 *
 * **Chosen (append-only, as the house holds it elsewhere): never cut.** A
 * short write leaves its fragment standing and throws `AppendError` with
 * `torn: true` and `written` (bytes on disk); nothing is reported as
 * committed. That the NEXT writer never glues its line to the fragment is
 * already ensured BEFORE writing (`endsWithoutNewline` -> a leading `\n`
 * in the same `write()`); the fragment becomes a broken line of its own,
 * which readers count as broken (never silently dropped). Only a write of
 * 0 bytes without a throw leaves nothing behind: `torn: false`.
 *
 * Consequence for multi-line blocks: if the break falls behind an inner
 * `\n`, the WHOLE lines before it stand valid in the file although the
 * call reports "not committed"; a retry books them twice. Twice is the
 * smaller evil than lost, and `torn: true` names it.
 *
 * **A throw never cuts either (y0, 2026-09-30).** A `writeSync` that throws
 * wrote nothing (POSIX); size growth measured afterwards may be a foreign
 * line that landed in the gap. Growth after a throw is reported as
 * `torn: true` and left alone.
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
 * `torn: false` — nothing of this attempt is in the file (a throw without
 * growth, or 0 bytes written): nothing committed, nothing damaged.
 *
 * `torn: true` — a fragment of this attempt (`written` > 0) or an
 * ambiguous growth stands in the file. It is NEVER truncated (audit F01:
 * a truncate could cut off a foreign, confirmed line); the caller learns
 * about it through this field and can name it (e.g. a `*-tears.jsonl`
 * record). The next `appendLine` puts a newline in front, readers count
 * the fragment as a broken line.
 */
export class AppendError extends Error {
  constructor(message, { filePath, torn, cause, written } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AppendError';
    this.filePath = filePath;
    this.torn = !!torn;
    this.written = written ?? 0; // bytes of this attempt that are on disk
  }
}

/**
 * Append `buffer` (finished bytes, including any leading-newline repair)
 * to `filePath` in EXACTLY ONE `fs.writeSync` call. On error or short
 * write: never truncate (audit F01), throw `AppendError` with `torn` and
 * `written` — see the "ENOSPC-safe" and "NEVER truncated" sections in the
 * module docstring above.
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

    // A THROW means, per POSIX, that nothing was written (write() failed
    // with -1). Any growth we see afterwards cannot be told apart from a
    // foreign writer's line: name it, never cut it. A SHORT write leaves its
    // fragment standing (never `ftruncate`, see the header, audit F01).
    const bytesOnDisk = writeError ? 0 : written;
    let torn;
    if (writeError) {
      let grew = 0;
      try { grew = Math.max(0, fs.fstatSync(fd).size - sizeBefore); } catch { grew = 0; }
      torn = grew > 0; // ambiguous growth: name it, never cut it
    } else {
      torn = bytesOnDisk > 0; // 0 bytes without a throw: nothing stands there
    }

    const reason = writeError
      ? writeError.message
      : `only ${bytesOnDisk} of ${buffer.length} bytes were written`;
    throw new AppendError(
      torn
        ? `appendLine: write to '${filePath}' aborted (${reason}) — a fragment or growth `
          + 'stands in the file and is NEVER truncated (a truncate could cut off a foreign, '
          + 'confirmed line). Nothing was committed; the next append puts a line break in front, '
          + 'readers count the fragment as a broken line.'
        : `appendLine: write to '${filePath}' failed (${reason}) — no byte arrived, the file `
          + 'is untouched. Nothing was committed.',
      { filePath, torn, cause: writeError, written: bytesOnDisk },
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
 * `writeAtomicAppend()` above — a single low-level write; on error or
 * short write it never truncates (audit F01): the fragment stays and the
 * thrown `AppendError` carries `.torn` and `.written`, so it is never
 * left behind unannounced; every caller already let the previous
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
