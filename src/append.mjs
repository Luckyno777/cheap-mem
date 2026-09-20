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
 */

import fs from 'node:fs';

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
 */
export function appendLine(filePath, text, { checkNewline = true } = {}) {
  const prefix = (checkNewline && endsWithoutNewline(filePath)) ? '\n' : '';
  fs.appendFileSync(filePath, prefix + text, 'utf8');
  return { healed: prefix.length > 0 };
}
