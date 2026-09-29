// test/w9-parity-debt.test.mjs — W9: the parity debt list.
// bench/parity.mjs: openItems(), readDoneLines(), debtList(). Two
// fixture repos (cm-shaped + lm-shaped), linked via `sibling` (the
// sibling-clone lookup is not in the way here since the test passes
// the override directly).
//
// Cases: open item listed; closed by a Done line in the OTHER repo;
// unrelated hash does not close it; sibling missing -> not measurable
// (never "0 open"); a merge-covered open item still counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './temp-dir.mjs';

import { debtList, W9_BASELINE } from '../bench/parity.mjs';
import { checkParityDebt, LEVEL } from '../src/doctor.mjs';

function repo(prefix, t) {
  const r = tempDir(prefix, t);
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 0;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  const cutoff = git('rev-parse', 'HEAD').trim();
  return { r, git, cutoff };
}

// A commit that touches src/ (so it needs the line) whose COMMITTER date
// (what `%cI`/debtList reads) is BEFORE W9_BASELINE — simulates a legacy
// item independent of the real clock.
function legacyCommit(r, message) {
  const beforeBaseline = new Date(Date.parse(W9_BASELINE) - 5 * 24 * 60 * 60 * 1000).toISOString();
  fs.appendFileSync(path.join(r, 'src', 'start.mjs'), `// ${message}\n`);
  execFileSync('git', ['add', '-A'], { cwd: r, encoding: 'utf8' });
  execFileSync('git', ['commit', '-q', '-m', message, '--date', beforeBaseline], {
    cwd: r,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: beforeBaseline, GIT_COMMITTER_DATE: beforeBaseline },
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).trim();
}

test('W9 open item: an lm=open commit shows up in the list', (t) => {
  const { r, git, cutoff } = repo('cm-debt-', t);
  const lm = repo('lm-debt-empty-', t);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touches src\n\nParity: lm=open');
  const hash = git('rev-parse', 'HEAD').trim();

  const r2 = debtList(r, cutoff, { sibling: lm.r });
  assert.equal(r2.measurable, true);
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].cm_hash, hash);
});

test('W9 closing: a Paritaet-Erledigt line in the OTHER repo closes the item', (t) => {
  const { r, git, cutoff } = repo('cm-debt-close-', t);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touches src\n\nParity: lm=open');
  const hash = git('rev-parse', 'HEAD').trim();

  const lm = repo('lm-debt-close-', t);
  lm.git('commit', '-q', '--allow-empty', '-m', `closes cm item\n\nParitaet-Erledigt: ${hash.slice(0, 12)}`);

  const r2 = debtList(r, cutoff, { sibling: lm.r });
  assert.equal(r2.measurable, true);
  assert.deepEqual(r2.items, [], 'the Erledigt line closes the item');
});

test('W9 counter-check: an UNRELATED hash in Paritaet-Erledigt closes nothing', (t) => {
  const { r, git, cutoff } = repo('cm-debt-unrelated-', t);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touches src\n\nParity: lm=open');

  const lm = repo('lm-debt-unrelated-', t);
  lm.git('commit', '-q', '--allow-empty', '-m', 'closes nothing\n\nParitaet-Erledigt: 0000000unrelated');

  const r2 = debtList(r, cutoff, { sibling: lm.r });
  assert.equal(r2.measurable, true);
  assert.equal(r2.items.length, 1, 'unrelated hash closes nothing');
});

test('W9 sibling missing: "not measurable: sibling not readable", never 0 open', (t) => {
  const { r, git, cutoff } = repo('cm-debt-no-sibling-', t);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touches src\n\nParity: lm=open');

  const r2 = debtList(r, cutoff, { sibling: path.join(r, 'does-not-exist') });
  assert.equal(r2.measurable, false);
  assert.match(r2.reason, /not measurable: sibling not readable/);
});

test('W9 merge coverage: a merge-covered open item still counts as an open item', (t) => {
  const { r, git, cutoff } = repo('cm-debt-merge-', t);
  const main = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  git('checkout', '-q', '-b', 'branch');
  fs.writeFileSync(path.join(r, 'src', 'branch.mjs'), 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'agent touches src without its own line');
  const agentHash = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', main);
  git('merge', '-q', '--no-ff', 'branch', '-m', 'Merge branch\n\nParity: lm=open');

  const lm = repo('lm-debt-merge-empty-', t);
  const r2 = debtList(r, cutoff, { sibling: lm.r });
  assert.equal(r2.measurable, true);
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].cm_hash, agentHash, 'the merge-covered commit itself is the open item, not the merge');
});

test('W9 doctor finding: GOOD with no items', (t) => {
  const { r, cutoff } = repo('cm-debt-finding-good-', t);
  const lm = repo('lm-debt-finding-good-empty-', t);
  const f = checkParityDebt(r, { cutoff, sibling: lm.r });
  assert.equal(f.level, LEVEL.GOOD);
});

test('W9 doctor finding: WARN once a NEW item exceeds the threshold', (t) => {
  const { r, git, cutoff } = repo('cm-debt-finding-warn-', t);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touches src\n\nParity: lm=open');
  const lm = repo('lm-debt-finding-warn-empty-', t);
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000; // measured 30 days "in the future"
  const f = checkParityDebt(r, { cutoff, sibling: lm.r, now: future, warnDays: 14 });
  assert.equal(f.level, LEVEL.WARN);
  assert.match(f.text, /1 new open, of which 1 over 14 days; legacy 0/);
});

test('W9 doctor finding: legacy-only is GOOD, with the legacy count in the text (never a forever-warning)', (t) => {
  const { r, cutoff } = repo('cm-debt-finding-legacy-', t);
  const hash = legacyCommit(r, 'old src change\n\nParity: lm=open');
  const lm = repo('lm-debt-finding-legacy-empty-', t);
  // Measured far in the future: if the item were NEW, this would warn.
  const farFuture = Date.parse(W9_BASELINE) + 400 * 24 * 60 * 60 * 1000;
  const r2 = debtList(r, cutoff, { sibling: lm.r, now: farFuture });
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].cm_hash, hash);
  assert.equal(r2.items[0].legacy, true);
  const f = checkParityDebt(r, { cutoff, sibling: lm.r, now: farFuture, warnDays: 14 });
  assert.equal(f.level, LEVEL.GOOD, 'legacy items must never warn, however old');
  assert.match(f.text, /0 new open, of which 0 over 14 days; legacy 1/);
});

test('W9 doctor finding: UNKNOWN with no sibling (never guessing GOOD/0 open)', (t) => {
  const { r, git, cutoff } = repo('cm-debt-finding-unknown-', t);
  fs.writeFileSync(path.join(r, 'src', 'start.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touches src\n\nParity: lm=open');
  const f = checkParityDebt(r, { cutoff, sibling: path.join(r, 'does-not-exist') });
  assert.equal(f.level, LEVEL.UNKNOWN);
});
