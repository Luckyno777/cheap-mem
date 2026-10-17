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
 * that working: a BOM is never content, and neither is the whitespace before the
 * first character of a JSON document.
 *
 * Nothing in here knows which hook it serves. It reads bytes, not strings, so a
 * multi-byte character cut by a chunk boundary is not torn into two U+FFFD.
 */
import fs from 'node:fs';

/** `raw` without the byte order marks and whitespace in front of it. Never throws; anything not a string reads as ''. */
export function hookText(raw) {
  return typeof raw === 'string' ? raw.replace(/^[\uFEFF\s]+/, '') : '';
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
