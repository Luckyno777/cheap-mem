// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// ci-history: the history check before the suite (bench/ci-history-check.mjs).
// Shallow clone -> red; missing baseline -> red with its name; complete -> green;
// a blind search (nothing found) is exit 2 and does not count as passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SCRIPT = path.join(HERE, 'bench', 'ci-history-check.mjs');
const childEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.NODE_TEST_CONTEXT; return e; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a],
  { env: childEnv(), stdio: 'pipe', encoding: 'utf8' }).trim();
const check = (root, min = 1) => spawnSync(process.execPath, [SCRIPT, root],
  { encoding: 'utf8', env: childEnv({ CI_HISTORY_MINIMUM: String(min) }) });
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };

/** Repo with two commits; the probe names the FIRST (the parent) by constant. */
function repoWithBaseline(content) {
  const r = tmp('cm-hist-');
  git(r, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(r, 'test'), { recursive: true });
  fs.writeFileSync(path.join(r, 'a.txt'), 'one\n');
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'one');
  const first = git(r, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(r, 'test', 'probe.test.mjs'), content(first));
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'two');
  return { r, first };
}
// A hash that exists nowhere - built at run time so THIS file does not show up as a baseline itself.
const MISSING = ['0a1b2c3d4e5f6071', '8293a4b5c6d7e8f901234567'].join('');
const probe = (h) => `const OLD_STATE = '${h}';\nexport const x = \`git show \${OLD_STATE}:a.txt\`;\n`;

test('green: complete clone, baseline present', () => {
  const { r } = repoWithBaseline(probe);
  const p = check(r);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /history complete, 1 probe baselines/);
});

test('red (positive control): shallow clone -> exit 1, names fetch-depth', () => {
  const { r } = repoWithBaseline(probe);
  const shallow = tmp('cm-hist-shallow-');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r}`, path.join(shallow, 'k')], { env: childEnv(), stdio: 'pipe' });
  const p = check(path.join(shallow, 'k'));
  assert.equal(p.status, 1);
  assert.match(p.stdout, /fetch-depth: 0/);
});

test('red: a baseline missing from the clone is named with hash and location', () => {
  const { r } = repoWithBaseline(() => probe(MISSING));
  const p = check(r);
  assert.equal(p.status, 1);
  assert.match(p.stdout, /baselines not in the clone/);
  assert.ok(p.stdout.includes(`${MISSING}  test/probe.test.mjs (OLD_STATE)`), p.stdout);
});

test('red: the revision form (hash^) without a constant is found too', () => {
  const { r } = repoWithBaseline(() => `const x = 'git show ${MISSING}^';\n`);
  const p = check(r);
  assert.equal(p.status, 1);
  assert.match(p.stdout, /test\/probe\.test\.mjs:1/);
});

test('exit 2: a search that finds nothing is blind and does not pass', () => {
  const { r } = repoWithBaseline(() => 'export const nothing = 1;\n');
  const p = check(r, 1);
  assert.equal(p.status, 2);
  assert.match(p.stdout, /the search is blind/);
});

test('decoys: repeated digits (aaaa..., 1111...) do not count as a baseline', () => {
  const { r } = repoWithBaseline(() => "const OLD_STATE = 'aaaaaaaaaaaa';\nconst Z = '1111111111111111111111111111111111111111';\n");
  const p = check(r, 1);
  assert.equal(p.status, 2, 'nothing usable found -> blind, not red because of a decoy');
});

test('the real tree: the search finds the real baselines and all resolve (when the clone is complete)', () => {
  const shallow = execFileSync('git', ['-C', HERE, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
  if (shallow !== 'false') return; // shallow: the CI step itself is the proof (and aborts there).
  const p = spawnSync(process.execPath, [SCRIPT, HERE], { encoding: 'utf8', env: childEnv() });
  assert.equal(p.status, 0, p.stdout + p.stderr);
});
