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
import { fileURLToPath } from 'node:url';
import { maskEntry, maskText } from '../src/outputguard.mjs';

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
// so the work stays linear in the size of the file (every character is masked once). A secret longer than the limit
// is the only thing a cut can split; a key is a few KB, the limit is 2 MiB.
const BLOCK_MAX_LINES = 20000;
const BLOCK_MAX_CHARS = 2 * 1024 * 1024;

/** True when `inner` is `outer` or lies below it (real paths; case-insensitive where the platform is). */
function isInside(inner, outer) {
  const rel = path.relative(outer, inner);
  // `..x` is a name inside the root, not a step out of it: only `..` itself or `../` leaves
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function makeCopy(source, root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX));
  try {
    if (root && isInside(fs.realpathSync.native(dir), fs.realpathSync.native(root))) throw Object.assign(new Error('temp directory inside the memory root'), { code: 'TMPDIR_IN_ROOT' });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const target = path.join(dir, FILE_NAME);
  try {
    const fd = fs.openSync(target, 'w', 0o600);
    const out = fs.createWriteStream(null, { fd });
    const rl = readline.createInterface({ input: fs.createReadStream(source), crlfDelay: Infinity });
    let block = [];
    let blockChars = 0;
    const put = async (text) => { if (!out.write(`${text}\n`)) await once(out, 'drain'); };
    const flush = async () => {
      if (block.length === 0) return;
      const text = maskText(block.join('\n'));
      block = [];
      blockChars = 0;
      await put(text);
    };
    for await (const line of rl) {
      const parsed = parseStructured(line);
      if (parsed !== undefined) {
        await flush();
        await put(JSON.stringify(maskEntry(parsed)));
      } else {
        block.push(line);
        blockChars += line.length + 1;
        if (block.length >= BLOCK_MAX_LINES || blockChars >= BLOCK_MAX_CHARS) await flush();
      }
    }
    await flush();
    out.end();
    await once(out, 'close');
    return target;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
