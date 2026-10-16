#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * mem-mask-copy.mjs - a MASKED copy of a session transcript, for the reflector.
 *
 *   node bin/mem-mask-copy.mjs <transcript>        prints the path of the masked copy
 *   node bin/mem-mask-copy.mjs --clean <copy>      removes a copy made by the first form
 *
 * The reflector (bin/mem-reflect, bin/mem-reflect.ps1) hands a model the path of the
 * transcript. The digest reads captures through `mem raw show` and the mail handler reads
 * mail through `mem inbox show`, both masked (`maskEntry`); the reflector alone gave the
 * model the file as it lies on disk, secrets and all. Now it gets this copy instead: every
 * line that is JSON goes through `maskEntry` (the very masking of `mem raw show`: the text
 * rules, and a secret's KEY as context for the value under it), every other line through
 * `maskText`. Keys and the shape of the lines stay, so the model reads the same session.
 *
 * The copy sits in a private directory under the OS temp directory (never under the memory
 * root: the reflector commits with `git add -A`). It is deleted by the caller with --clean
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

function maskLine(line) {
  if (!line.trim()) return line;
  let parsed;
  try { parsed = JSON.parse(line); } catch { return maskText(line); }
  return JSON.stringify(maskEntry(parsed));
}

async function makeCopy(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX));
  const target = path.join(dir, FILE_NAME);
  try {
    const fd = fs.openSync(target, 'w', 0o600);
    const out = fs.createWriteStream(null, { fd });
    const rl = readline.createInterface({ input: fs.createReadStream(source), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!out.write(`${maskLine(line)}\n`)) await once(out, 'drain');
    }
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
    } else if (args.length === 1 && args[0]) {
      process.stdout.write(`${await makeCopy(args[0])}\n`);
    } else {
      process.stderr.write('usage: mem-mask-copy <transcript> | --clean <copy>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`mem-mask-copy: ${e && e.code ? e.code : 'failed'}\n`);
    process.exitCode = 2;
  }
}
