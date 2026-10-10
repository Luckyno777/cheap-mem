// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Shared by test/tie-cut.test.mjs and test/request-frame.test.mjs: the old
// state for the red proofs, a fixture memory, the recall hook's own call.
//
// The OLD state is a PINNED commit (rule 15: never `git merge-base HEAD
// origin/main` -- it moves with the merge and turns the proof itself red):
// origin/main when the two levers were built.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../../src/memory.mjs';
import { removeTree } from './cleanup.mjs';

export const OLD_STATE = 'b5959ed38a2d859a762df7da893f6ce17b0ee0cb';
export const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MEM = path.join(CODE, 'bin', 'mem');
export const HOOK = path.join(CODE, 'bin', 'mem-retrieve');
export const DAY = 86400000;

const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

export function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
export const drop = (d) => removeTree(d);

/** Why the old state is missing, or '' when it is there (never a silent skip). */
export function oldStateMissing() {
  const r = spawnSync('git', ['cat-file', '-e', `${OLD_STATE}^{commit}`], { cwd: CODE, encoding: 'utf8' });
  const why = r.error?.message ?? (String(r.stderr).trim() || 'no message');
  return r.status === 0 ? '' : `old state ${OLD_STATE} not in this clone (exit ${r.status}, signal ${r.signal}, ${why})`;
}

/** `bin/`, `src/` and package.json of the OLD state in a fresh directory (git archive, no checkout). */
export function oldTree() {
  const dir = tmp('cm-old-');
  const tar = execFileSync('git', ['-C', CODE, 'archive', OLD_STATE, 'bin', 'src', 'package.json'], { maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return dir;
}

/** An empty memory (`mem init`) in a fresh directory. */
export function emptyMemory(prefix = 'cm-recall-') {
  const root = tmp(prefix);
  execFileSync(process.execPath, [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  return root;
}

/** One decision per entry of `ages` (days old), all with the same words: scores within a hair of each other. */
export function tiedMemory(ages, { title = 'Payment retry policy', choice = 'retry payments three times' } = {}) {
  const root = emptyMemory('cm-tie-');
  ages.forEach((age, i) => {
    memory.logEntry(root, 'decision', { id: `tie-${i}`, title, choice, why: 'flaky provider', tags: ['payments'] },
      { now: new Date(Date.now() - age * DAY) });
  });
  return root;
}

/** `mem find` of a tree, the way the recall hook calls it (`recall` true) or by hand. */
export function find(tree, root, query, { top = 3, recall = false, weak = false, env = {} } = {}) {
  const argv = [path.join(tree, 'bin', 'mem'), '--root', root, 'find', query, '--top', String(top)];
  if (recall) argv.push('--recall');
  if (weak) argv.push('--weak');
  argv.push('--json');
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: '', ...env } });
  if (r.status !== 0) return { status: r.status, stderr: String(r.stderr), ids: [], scores: [] };
  const hits = JSON.parse(r.stdout).hits;
  return { status: 0, stderr: '', ids: hits.map((h) => h.entry.id), scores: hits.map((h) => h.score) };
}

/** The real hook script of a tree on a prompt; the ids of the entries it put into the context. */
export function hookIds(tree, root, prompt, { session = 'recall-parity', env = {} } = {}) {
  const r = spawnSync('bash', [path.join(tree, 'bin', 'mem-retrieve')], {
    input: JSON.stringify({ session_id: session, prompt }), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_RETRIEVE_NO_PULL: '1', MEM_RECALL_SERVER: '0',
      MEM_RETRIEVE_MIN: '0', MEM_RETRIEVE_TURNS: path.join(root, '.mem', `turns-${session}`), MEM_HOOK_OFF: '', MEM_RETRIEVE_OFF: '',
      ...env },
  });
  let text = String(r.stdout ?? '');
  try { text = JSON.parse(text).hookSpecificOutput.additionalContext; } catch { /* nothing was said */ }
  return { text, ids: [...new Set(text.match(/\btie-\d+|\bfr-(?:\d+|gold)/g) ?? [])], status: r.status };
}
