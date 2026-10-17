#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * mem-mask-copy.mjs - a MASKED copy of a session transcript, for the reflector.
 *
 *   node bin/mem-mask-copy.mjs [--root <memory root>] <transcript>   prints the path of the masked copy
 *   node bin/mem-mask-copy.mjs --clean <copy>      removes a copy made by the first form
 *
 * The reflector (bin/mem-reflect, bin/mem-reflect.ps1) hands a model the path of the
 * transcript. The digest reads captures through `mem raw show` and the mail handler reads
 * mail through `mem inbox show`, both masked (`maskEntry`); the reflector alone gave the
 * model the file as it lies on disk, secrets and all. Now it gets this copy instead: every
 * line that is a JSON object goes through `maskEntry` (the very masking of `mem raw show`: the text
 * rules, and a secret's KEY as context for the value under it), every run of other lines through
 * `maskText` as one block (a PEM key spans lines). Keys and the shape of the lines stay, so the model reads the same session.
 *
 * The copy sits in a private directory under the OS temp directory (never under the memory
 * root: the reflector commits with `git add -A`). With --root the script checks it: if the temp
 * directory itself lies inside the memory root (TMPDIR, TEMP or TMP set that way), it fails
 * instead of leaving a secret-bearing file where `git add -A` would pick it up. It is deleted by the caller with --clean
 * as soon as the model has ended.
 *
 * Fails CLOSED: on any error nothing is left behind, nothing is printed, the exit code is 2,
 * and the caller must not start the model on the raw path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { maskEntry, maskText } from '../src/outputguard.mjs';
import { isMain } from '../src/ismain.mjs';

const DIR_PREFIX = 'mem-reflect-';
const FILE_NAME = 'transcript.jsonl';

/** A line that is a JSON object or array: masked as a structure (keys are context). Anything else is text. */
function parseStructured(line) {
  if (!line.trim()) return undefined;
  let parsed;
  try { parsed = JSON.parse(line); } catch { return undefined; }
  return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
}

// Consecutive lines that are no JSON object are masked as ONE block of text, not line by line: a secret that spans
// lines (a PEM private key, a multi-line token in a pasted log) has no shape in any single one of its lines. The block
// has a cost limit: it is cut at BLOCK_MAX_LINES lines or BLOCK_MAX_CHARS characters and the rest starts a new block,
// so the work stays linear in the size of the file (every character is masked once). A cut can split a secret that
// STRADDLES it: a key of a few KB that happens to begin just before the 2 MiB mark. So a cut never gives up an open
// block (a `BEGIN` header with no `END` after it): the header is carried into the next block, which is masked as if the
// header stood in front of it, for as long as no `END` is seen (fail closed: an open block is masked to its end, or to the
// end of the file, rather than left in the clear; small-rest2).
const BLOCK_MAX_LINES = 20000;
const BLOCK_MAX_CHARS = 2 * 1024 * 1024;

/** The header line of the last `BEGIN` in `text` that no `END` follows ('' when there is none or it is closed). */
export function openBlockHeader(text) {
  const at = text.lastIndexOf('-----BEGIN');
  if (at < 0 || text.indexOf('-----END', at) >= 0) return '';
  const m = /^-----BEGIN[^-]{0,40}-----/.exec(text.slice(at, at + 80));
  return m ? m[0] : '';
}

/** True when `inner` is `outer` or lies below it (real paths; case-insensitive where the platform is). */
function isInside(inner, outer) {
  const rel = path.relative(outer, inner);
  // `..x` is a name inside the root, not a step out of it: only `..` itself or `../` leaves
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export async function makeCopy(source, root) {
  // The source is opened BEFORE anything is made: a missing or unreadable transcript then leaves nothing behind on any
  // platform. (CI run 1074, windows node 20: the read error came after the copy's file was open, and Windows does not
  // remove a directory that still holds an open file - one empty mem-reflect-* directory stayed in the temp dir.)
  const sourceFd = fs.openSync(source, 'r');
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX));
  } catch (e) {
    fs.closeSync(sourceFd);
    throw e;
  }
  try {
    if (root && isInside(fs.realpathSync.native(dir), fs.realpathSync.native(root))) throw Object.assign(new Error('temp directory inside the memory root'), { code: 'TMPDIR_IN_ROOT' });
  } catch (e) {
    fs.closeSync(sourceFd);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const target = path.join(dir, FILE_NAME);
  let out = null;
  let input = null;
  try {
    const fd = fs.openSync(target, 'w', 0o600);
    out = fs.createWriteStream(null, { fd });
    input = fs.createReadStream(null, { fd: sourceFd });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let block = [];
    let blockChars = 0;
    let carry = ''; // the header of a block a cut left open
    const put = async (text) => { if (!out.write(`${text}\n`)) await once(out, 'drain'); };
    const flush = async (cut = false) => {
      if (block.length === 0) return;
      const prefix = carry ? `${carry}\n` : '';
      const text = prefix + block.join('\n');
      let masked = maskText(text);
      // a carried header the mask did not take (the block ended before any key material) is not part of the copy
      if (prefix && masked.startsWith(prefix)) masked = masked.slice(prefix.length);
      carry = cut ? openBlockHeader(text) : '';
      block = [];
      blockChars = 0;
      await put(masked);
    };
    for await (const line of rl) {
      const parsed = parseStructured(line);
      if (parsed !== undefined) {
        await flush();
        await put(JSON.stringify(maskEntry(parsed)));
      } else {
        block.push(line);
        blockChars += line.length + 1;
        if (block.length >= BLOCK_MAX_LINES || blockChars >= BLOCK_MAX_CHARS) await flush(true);
      }
    }
    await flush();
    out.end();
    await once(out, 'close');
    return target;
  } catch (e) {
    // Both files closed first: on Windows a directory with an open file in it is not removed.
    await closeStream(out);
    await closeStream(input);
    if (!input) { try { fs.closeSync(sourceFd); } catch { /* already closed */ } }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    throw e;
  }
}

/** Destroys a stream and waits until its file descriptor is closed (a stream that never opened: nothing to wait for). */
async function closeStream(stream) {
  if (!stream || stream.closed) return;
  const closed = once(stream, 'close').catch(() => {});
  stream.destroy();
  await closed;
}

/** Removes the directory of a copy this script made, and nothing else. */
export function cleanCopy(target) {
  if (typeof target !== 'string' || !target) return false;
  const dir = path.dirname(path.resolve(target));
  if (path.basename(target) !== FILE_NAME || !path.basename(dir).startsWith(DIR_PREFIX)) return false;
  let tmp;
  try { tmp = fs.realpathSync(os.tmpdir()); } catch { return false; }
  let real;
  try { real = fs.realpathSync(dir); } catch { return false; }
  if (path.dirname(real) !== tmp) return false;
  fs.rmSync(real, { recursive: true, force: true });
  return true;
}

// Both sides as real paths (src/ismain.mjs): under a symlinked parent (a macOS temp dir) the text comparison was false,
// the script printed nothing, and the reflector, which starts no model without the masked copy, never ran (CI run 1103).
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--clean') {
      cleanCopy(args[1]);
    } else if (args[0] === '--root' && args.length === 3 && args[1] && args[2]) {
      process.stdout.write(`${await makeCopy(args[2], args[1])}\n`);
    } else if (args.length === 1 && args[0]) {
      process.stdout.write(`${await makeCopy(args[0], null)}\n`);
    } else {
      process.stderr.write('usage: mem-mask-copy [--root <memory root>] <transcript> | --clean <copy>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`mem-mask-copy: ${e && e.code ? e.code : 'failed'}\n`);
    process.exitCode = 2;
  }
}
