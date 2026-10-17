// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/gap-records.mjs — the small shared parts of the gap groups of the phases `bridge` and `silent-errors`
// (bench/atlas/bridge-gaps.mjs, bench/atlas/silent-errors-gaps.mjs).
//
// **What they have in common.** Every group builds its own throwaway root, asks a real door (a stdio bridge, an HTTP
// process, a child that imports the tree's own module), and writes records through ONE function, so the four fields
// are never missing. A group has a positive control; when the control does not hold, the records behind it read
// `not-measured` and name the control, instead of reporting a refusal that might be the harness's.
//
// **The code tree is a parameter.** `tree` is the directory whose `bin/` and `src/` are asked (default: this
// repository). That is what makes a record provable: test/atlas-gaps-cm.test.mjs copies the tree, removes ONE
// guarantee at the shared source (bench/atlas/gap-mutants.mjs) and asks the same group again.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { VERDICT, SEVERITY } from './core.mjs';

export { VERDICT, SEVERITY };

/** One line of at most `n` characters. */
export const short = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** Write a record; returns whether it passed. */
export function emit(atlas, {
  id, title, ok, expected, actual, evidence, measured = null, severity = SEVERITY.MAJOR,
}) {
  atlas.record({
    id, title, verdict: ok ? VERDICT.PASS : VERDICT.FAIL, expected, actual: String(actual), evidence: String(evidence || '(no further evidence)'), measured, severity,
  });
  return Boolean(ok);
}

/** A record that could not be measured, with the reason. Never a pass. */
export function notMeasured(atlas, { id, title, expected, reason }) {
  atlas.record({ id, title, verdict: VERDICT.NOT_MEASURED, expected, actual: 'not asked', evidence: reason });
}

/** Every `items` entry (`{id,title,expected}`) as not measured, with one reason. */
export function skipAll(atlas, items, reason) {
  for (const it of items) notMeasured(atlas, { ...it, reason });
}

/** Run a group; if it throws, the ids it has not written yet become `not-measured` with the throw as the reason. */
export async function guard(atlas, ids, fn) {
  try { await fn(); } catch (e) {
    const there = new Set(atlas.current.records.map((r) => r.id));
    for (const id of ids.filter((x) => !there.has(x))) {
      notMeasured(atlas, { id, title: `group record ${id}`, expected: 'see the group', reason: `the group stopped before it: ${short(e && e.message, 300)}` });
    }
  }
}

/**
 * Run a piece of module code in a CHILD process, against the tree's own `src/` (a fresh process per ask, so a
 * scratch tree that was changed between two asks is never answered from the module cache of this process).
 * The script runs as an ES module; `tree(rel)` imports a file of the tree; it prints one JSON line.
 * @returns {{ ok: boolean, value: any, status: number|null, stderr: string }}
 */
export function askTree(tree, cwd, script, env = {}) {
  const base = pathToFileURL(`${tree}${path.sep}`).href;
  const body = `const tree = (rel) => import(${JSON.stringify(base)} + rel);\n${script}`;
  const childEnv = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE']) if (process.env[k]) childEnv[k] = process.env[k];
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', body], {
    cwd, encoding: 'utf8', timeout: 120000, env: { ...childEnv, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  let value;
  let ok = false;
  try {
    const last = String(r.stdout).trim().split('\n').pop();
    value = JSON.parse(last);
    ok = r.status === 0;
  } catch { value = undefined; }
  return { ok, value, status: r.status, stderr: short(r.stderr, 400) };
}

/** Put `file` into one of the five states (`good` is the content of the ok state, a JSON value). */
export function setState(file, state, good) {
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (state === 'ok') fs.writeFileSync(file, `${JSON.stringify(good)}\n`);
  else if (state === 'empty') fs.writeFileSync(file, '');
  else if (state === 'broken') fs.writeFileSync(file, `this line is not json at all\n${JSON.stringify(good)}\n`);
  else if (state === 'unreadable') fs.mkdirSync(file);
  // missing: nothing is left at the path
}
