// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Two doctor findings from the lucky-mem atlas B14 port:
//   1. `entry-form` reports a drawer line WITHOUT an id (it stayed "good").
//   2. `mem doctor` writes nothing raw to stderr in a fresh or shallow clone
//      (the parity cutoff is missing there: not measurable, said properly).
// Red proofs against a FIXED old commit (never a moving merge-base), each with
// a positive control that shows the probe sees something.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkEntryForm } from '../src/doctor.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** cheap-mem main before these two changes. */
const OLD_STATE = '24cd9a95195e4a0b969ea7621ffd430521835817';

const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const mem = (bin, root, args) => spawnSync(process.execPath, [bin, ...args], {
  encoding: 'utf8', timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: root },
});
const append = (root, file, o) => fs.appendFileSync(path.join(root, 'global', file), `${JSON.stringify(o)}\n`);
const withId = (n) => ({ id: `okid${n}abc`, ts: '2026-10-01T00:00:00Z', v: 1, title: `fine ${n}`, text: 'x' });

function memoryWith(t, bin, { idless }) {
  const root = tmp(t, 'cm-idless-');
  assert.equal(mem(bin, root, ['init']).status, 0);
  append(root, 'learnings.jsonl', withId(1));
  if (idless) append(root, 'learnings.jsonl', { ts: '2026-10-01T00:00:00Z', v: 1, title: 'no id here', text: 'x' });
  return root;
}

const form = (bin, root) => /^(\S+)\s+entry-form\s+(.*)$/m.exec(mem(bin, root, ['doctor']).stdout);
const BIN = path.join(REPO, 'bin', 'mem');

test('entry-form: a line without an id is a warning that names the place', (t) => {
  const root = memoryWith(t, BIN, { idless: true });
  const f = checkEntryForm(root);
  assert.equal(f.level, 'warn');
  assert.match(f.text, /global\/learnings\.jsonl:2: no id/);
});

test('entry-form: counter-probe — a memory where every line has an id stays good', (t) => {
  const f = checkEntryForm(memoryWith(t, BIN, { idless: false }));
  assert.equal(f.level, 'good');
});

test('entry-form: handled by a finding line of class idless-line naming <file>:<line>; another place does not count', (t) => {
  const root = memoryWith(t, BIN, { idless: true });
  append(root, 'errors.jsonl', {
    id: 'ack1abcdef', ts: '2026-10-02T00:00:00Z', v: 1, class: 'idless-line', title: 'idless line', text: 'global/learnings.jsonl:9',
  });
  assert.equal(checkEntryForm(root).level, 'warn', 'a finding that names a different line does not cover this one');
  append(root, 'errors.jsonl', {
    id: 'ack2abcdef', ts: '2026-10-02T00:00:01Z', v: 1, class: 'idless-line', title: 'idless line', text: 'global/learnings.jsonl:2',
  });
  const f = checkEntryForm(root);
  assert.equal(f.level, 'good');
  assert.match(f.text, /on the record/);
});

test('RED: on the pinned old state entry-form stays good for a line without an id; the control is green there', (t) => {
  const old = tmp(t, 'cm-idless-old-');
  exportCommit(REPO, OLD_STATE, ['.'], old);
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(old, 'node_modules')); } catch { /* none needed */ }
  const oldBin = path.join(old, 'bin', 'mem');
  const control = form(oldBin, memoryWith(t, oldBin, { idless: false }));
  assert.ok(control && control[1] === 'ok', 'positive control: the old doctor judges a clean memory good');
  const red = form(oldBin, memoryWith(t, oldBin, { idless: true }));
  assert.ok(red && red[1] === 'ok', 'the old doctor calls the id-less line good');
  const now = form(BIN, memoryWith(t, BIN, { idless: true }));
  assert.ok(now && now[1] === 'WARN', 'the new doctor warns');
});

// ---- no raw stderr in a fresh clone ------------------------------------------

/** A git repository with ONE commit: the parity cutoff is not in its history, like a fresh or shallow clone. */
function freshRepo(t) {
  const dir = tmp(t, 'cm-fresh-');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
  return dir;
}

/** Run parity.evaluate for the repo in a child, with the parity module of `srcDir`; returns {stderr, result}. */
function evaluateIn(srcDir, repo) {
  const code = `import(${JSON.stringify(pathToFileURL(path.join(srcDir, 'src', 'parity.mjs')).href)}).then((m) => {`
    + ` process.stdout.write(JSON.stringify(m.evaluate(${JSON.stringify(repo)}, 'a'.repeat(40)))); });`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 60000 });
  return { stderr: r.stderr, result: JSON.parse(r.stdout) };
}

test('parity in a fresh clone: no raw git message on stderr, the reason explains "not measurable, not zero"', (t) => {
  const { stderr, result } = evaluateIn(REPO, freshRepo(t));
  assert.equal(stderr.trim(), '');
  assert.equal(result.measurable, false);
  assert.match(result.reason, /fresh or shallow clone/);
  assert.match(result.reason, /not measurable, not zero/);
});

test('RED: on the pinned old state the same call prints the raw git fatal line; the probe sees the failure', (t) => {
  const old = tmp(t, 'cm-fresh-old-');
  exportCommit(REPO, OLD_STATE, ['.'], old);
  const { stderr, result } = evaluateIn(old, freshRepo(t));
  assert.equal(result.measurable, false, 'positive control: the old state also finds the cutoff missing');
  assert.match(stderr, /fatal:/);
});
