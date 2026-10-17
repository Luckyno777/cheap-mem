// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The hook JSON a hook core reads on stdin, as the text it was meant to be.
 *
 * **The finding (CI run 1141, Windows PowerShell 5.1).** Every PowerShell twin
 * hands the hook JSON to node through a pipe (`$In | & node <core>`). Under
 * Windows PowerShell 5.1 the bytes node received began with a UTF-8 byte order
 * mark: the twin read 103 characters, the core counted 108 bytes (EF BB BF in
 * front, CR LF behind), `JSON.parse` stopped at the first character, and the
 * hook answered with nothing, exit 0 - before-edit, recall, catch-fail,
 * after-failure and subagent-start alike. The mark comes from .NET Framework,
 * not from `$OutputEncoding`: `Process.Start` opens the child's stdin with a
 * writer in `[Console]::InputEncoding` and flushes that encoding's preamble at
 * once, so under code page 65001 the BOM is on the pipe before PowerShell writes
 * a byte (.NET Core strips the preamble there; Windows PowerShell 5.1 runs on
 * .NET Framework). The twins now give the console a preamble-free UTF-8 encoding
 * before they pipe; this module is the other half, so the cores never depend on
 * that working: a BOM is never content.
 *
 * **Only the mark goes, not the blanks behind it** (kept short on purpose). The first cut stripped every Unicode
 * blank in front as well (`/^[\uFEFF\s]+/`). A JSON document does not need that: `JSON.parse` takes leading space,
 * tab, CR and LF as they come. But four of the cores read PLAIN TEXT - the prompt on stdin (`recallhook.mjs`
 * signal / machine / workflow, started by `bin/mem-retrieve.ps1`) - and there the leading blanks are the user's:
 * the sh twin hands them over untouched, `signal` judges the length with them, and the journal keeps the question
 * as typed. Trimming them made the two twins disagree and cut the kept question text.
 *
 * Nothing in here knows which hook it serves. It reads bytes, not strings, so a
 * multi-byte character cut by a chunk boundary is not torn into two U+FFFD.
 */
import fs from 'node:fs';

/** `raw` without the byte order marks in front of it, and nothing else. Never throws; anything not a string reads as ''. */
export function hookText(raw) {
  return typeof raw === 'string' ? raw.replace(/^\uFEFF+/, '') : '';
}

/**
 * What arrived, by size and shape, never by content: the raw byte count and whether it began with a UTF-8 byte order
 * mark (EF BB BF). For the diagnosis of a hook that answers nothing - `hookText` has already taken the mark off by then,
 * so the trimmed text can no longer tell a mangled stdin from an empty one.
 * @param {Buffer|string} raw  the bytes as read (a string counts as its UTF-8 bytes)
 * @returns {{bytes: number, bom: boolean}}
 */
export function hookShape(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : '', 'utf8');
  return { bytes: buf.length, bom: buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF };
}

/** All of stdin (or `stream`), decoded once as UTF-8, through `hookText`. A read error ends the read with what came. */
export function readHookStdin(stream = process.stdin) {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(hookText(Buffer.concat(chunks).toString('utf8')));
    stream.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')); })
      .on('end', done).on('error', done);
  });
}

/** The same, synchronously (file descriptor 0): for the before-edit core, which reads before it does anything else. */
export function readHookStdinSync() {
  try { return hookText(fs.readFileSync(0).toString('utf8')); } catch { return ''; }
}

/**
 * The raw bytes of stdin, synchronously, for a core that wants the SHAPE too: `{ text, shape }` where `text` is the
 * decoded input with the mark STILL in front (the consumer runs it through `hookText`) and `shape` is `hookShape` of the
 * bytes as they came. A read error reads as empty.
 */
export function readHookStdinRawSync() {
  let buf;
  try { buf = fs.readFileSync(0); } catch { buf = Buffer.alloc(0); }
  return { text: buf.toString('utf8'), shape: hookShape(buf) };
}
