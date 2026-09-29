// test/parity-gate.test.mjs — the gate for BAUPLAN-mem-admin_02.md L5:
// every commit that changes src/ or bin/ must carry
// `Parity: lm=yes|no|open`. The counting and classification logic lives
// in bench/parity.mjs (one truth, not two); this file is the caller plus
// the probes proving the logic does the right thing.
//
// Five parts:
//
//   1. AGAINST THE REAL HISTORY: since the cutoff, no commit touching
//      src/ or bin/ may be missing the line. In a shallow clone (the
//      CI default checkout, effectively `fetch-depth: 1`) the cutoff is
//      unreachable — then the probe is skipped (`t.skip`, "not
//      measurable"), not automatically green. Deliberately NOT fixed by
//      `fetch-depth: 0` in ci.yml: this workflow already runs a 3-OS x
//      2-node matrix (6 jobs) plus a coverage job on every push and PR
//      (no paths filter, by this workflow's own design — see its header
//      comment), and a full checkout in every one of those jobs, only
//      for a line that already gates cleanly locally (this test,
//      `npm test`) and via the counter (`node bench/parity.mjs`), buys
//      nothing this repo's own README-coverage philosophy would call
//      worth its cost ("a figure with no check is a figure with a date
//      on it"; here the inverse — paying Actions minutes for a check
//      that already runs elsewhere). The enforcing run is local and at
//      the agent's full-history clone.
//   2. SABOTAGE: a synthetic repo, a commit touching src/ WITHOUT the
//      trailer -> must count as a violation (red).
//   3. POSITIVE CONTROL: the same commit WITH a valid trailer -> no
//      violation (green).
//   4. EXCEPTION: a pure doc commit without the trailer -> no violation
//      (green), because it never touches src/bin (BAUPLAN L5: "pure
//      doc/log/test commits are excluded"); a merge commit touching
//      src/ without a trailer of its own -> excluded the same way
//      (`--no-merges`).
//   5. SHALLOW: a shallow clone (`git clone --depth 1`, the same
//      technique test/install-hooks.test.mjs and others in this repo
//      already use for git-behaviour probes) -> "not measurable", not
//      red, not green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './temp-dir.mjs';

import { evaluate, CUTOFF, DEFAULT_ROOT } from '../bench/parity.mjs';

function repo(testCtx) {
  const r = tempDir('cm-parity-', testCtx);
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 0;\n');
  fs.writeFileSync(path.join(r, 'README.md'), '# Test repo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  const cutoff = git('rev-parse', 'HEAD').trim();
  return { r, git, cutoff };
}

test('real history: no code commit since the cutoff is missing the parity line', (t) => {
  const r = evaluate(DEFAULT_ROOT, CUTOFF);
  if (!r.measurable) {
    t.skip(`not measurable: ${r.reason}`);
    return;
  }
  assert.deepEqual(
    r.violations,
    [],
    `commits missing the parity line since the cutoff: ${JSON.stringify(r.violations)}`,
  );
});

test('sabotage: a code commit without the trailer counts as a violation (red)', (testCtx) => {
  const { r, git, cutoff } = repo(testCtx);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touch src, no line');
  const result = evaluate(r, cutoff);
  assert.equal(result.measurable, true);
  assert.equal(result.violations.length, 1);
});

test('positive control: the same commit WITH a valid trailer is not a violation (green)', (testCtx) => {
  const { r, git, cutoff } = repo(testCtx);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touch src\n\nParity: lm=open');
  const result = evaluate(r, cutoff);
  assert.equal(result.measurable, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.counts.open, 1);
});

test('positive control: all three trailer values are recognised and counted', (testCtx) => {
  const { r, git, cutoff } = repo(testCtx);
  for (const value of ['yes', 'no', 'open']) {
    fs.appendFileSync(path.join(r, 'src', 'start.mjs'), `export const ${value} = 1;\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `touch src (${value})\n\nParity: lm=${value}`);
  }
  const result = evaluate(r, cutoff);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.counts, { yes: 1, no: 1, open: 1 });
});

test('exception: a pure doc commit without the trailer is not a violation (green)', (testCtx) => {
  const { r, git, cutoff } = repo(testCtx);
  fs.writeFileSync(path.join(r, 'README.md'), '# Test repo\n\nmore text.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'doc only, no line');
  const result = evaluate(r, cutoff);
  assert.equal(result.measurable, true);
  assert.equal(result.codeCommits, 0);
  assert.deepEqual(result.violations, []);
});

test('exception: a merge commit touching src without its own trailer is not a violation (--no-merges)', (testCtx) => {
  const { r, git, cutoff } = repo(testCtx);
  git('checkout', '-q', '-b', 'branch');
  fs.writeFileSync(path.join(r, 'src', 'branch.mjs'), 'export const z = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'branch: new file\n\nParity: lm=open');
  git('checkout', '-q', '-');
  fs.writeFileSync(path.join(r, 'src', 'main.mjs'), 'export const h = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'main: new file\n\nParity: lm=open');
  git('merge', '--no-edit', '-q', 'branch');
  const result = evaluate(r, cutoff);
  // The two real commits both carry the line; the merge itself must not
  // show up as a third, unaccounted-for code commit.
  assert.equal(result.codeCommits, 2);
  assert.deepEqual(result.violations, []);
});

test('shallow: a shallow clone reports "not measurable", not red, not green', (testCtx) => {
  const { r, git, cutoff } = repo(testCtx);
  fs.writeFileSync(path.join(r, 'src', 'second.mjs'), 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'second commit, so there is history at all');

  const shallow = tempDir('cm-parity-shallow-', testCtx);
  fs.rmdirSync(shallow);
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r}`, shallow], { encoding: 'utf8' });

  const result = evaluate(shallow, cutoff);
  assert.equal(result.measurable, false);
  assert.match(result.reason, /shallow|reachable/i);
});

test('merge coverage: a merge WITH the line covers the commits it brings in, without it does not', (testCtx) => {
  for (const [withLine, expected] of [[true, 0], [false, 1]]) {
    const { r, git, cutoff } = repo(testCtx);
    const main = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(r, 'src', 'main.mjs'), 'export const a = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'agent changes src without the line');
    git('checkout', '-q', main);
    fs.writeFileSync(path.join(r, 'README.md'), '# Test repo\ntwo\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'docs on main');
    git('merge', '-q', '--no-ff', 'side', '-m',
      withLine ? 'Merge side\n\nParity: lm=open' : 'Merge side');
    const result = evaluate(r, cutoff);
    assert.equal(result.violations.length, expected, withLine ? 'merge with the line does not cover' : 'merge without the line wrongly covers');
  }
});

test('addendum: a line with trailing text does not count — a later Parity-Addendum covers it (append-only, 2026-09-29)', (testCtx) => {
  const { r, git, cutoff } = repo(testCtx);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touch src\n\nParity: lm=open -- lm needs this later');
  const broken = git('rev-parse', 'HEAD').trim();
  assert.equal(evaluate(r, cutoff).violations.length, 1, 'RED before: trailing text invalidates the line');
  git('commit', '-q', '--allow-empty', '-m', 'wrong addendum\n\nParity-Addendum: 0000000 lm=open');
  assert.equal(evaluate(r, cutoff).violations.length, 1, 'a foreign hash covers nothing');
  git('commit', '-q', '--allow-empty', '-m', `addendum\n\nParity-Addendum: ${broken.slice(0, 12)} lm=open`);
  const result = evaluate(r, cutoff);
  assert.deepEqual(result.violations, [], 'GREEN after: the addendum covers the commit');
  assert.equal(result.counts.open, 1);
});
