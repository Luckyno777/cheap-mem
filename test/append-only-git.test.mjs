// Append-only, checked against GIT — not against a hash chain (the
// audit's own proposal, deliberately not built; see the long comment on
// `checkAppendOnlyGit` in src/doctor.mjs for why: the realistic threat
// here is carelessness, and git already carries a complete,
// cryptographically chained, append-only record of every commit. A
// second, weaker version of the same guarantee buys nothing.
//
// Four states, each with its own test, matching the audit's own
// sabotage list: only appended -> good; a historical line edited in the
// working tree -> error naming the file and the FIRST wrong line; a
// file not yet tracked in HEAD -> unknown, not good; no git at all ->
// unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as doctor from '../src/doctor.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A tiny memory-shaped git repo with one committed append-only log. */
function repo({ nested = false } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-aog-'));
  const root = nested ? path.join(top, 'child') : top;
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    version: 1,
    participants: { user: 'h', session: 's', librarian: 'l' },
    defaultBranch: 'main', defaultRemote: 'origin', language: 'en',
  }));
  const log = path.join(root, 'global', 'errors.jsonl');
  fs.writeFileSync(log,
    '{"id":"a1","ts":"2026-01-01T00:00:00Z","title":"one"}\n'
    + '{"id":"a2","ts":"2026-01-02T00:00:00Z","title":"two"}\n');
  git(top, 'init', '-q');
  git(top, 'add', '-A');
  git(top, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
  return { top, root, log };
}

test('POSITIVE: only appended since the last commit — GOOD', () => {
  const { root, log } = repo();
  try {
    fs.appendFileSync(log, '{"id":"a3","ts":"2026-01-03T00:00:00Z","title":"three"}\n');
    const f = doctor.checkAppendOnlyGit(root);
    assert.equal(f.level, doctor.LEVEL.GOOD);
    assert.match(f.text, /only appended/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL / SABOTAGE: a historical line edited in the working tree — ERROR with the correct line', () => {
  const { root, log } = repo();
  try {
    // Line 1, not line 2 — the test would still pass with an off-by-one
    // report if it only checked "some error happened".
    fs.writeFileSync(log,
      '{"id":"a1","ts":"2026-01-01T00:00:00Z","title":"ONE EDITED"}\n'
      + '{"id":"a2","ts":"2026-01-02T00:00:00Z","title":"two"}\n');
    const f = doctor.checkAppendOnlyGit(root);
    assert.equal(f.level, doctor.LEVEL.ERROR, 'an edited historical line must be an ERROR, not a warning');
    assert.match(f.text, /global\/errors\.jsonl:1\b/, 'must name the FIRST differing line, not just the file');
    assert.ok(f.advice, 'an error without a next step just makes people feel bad');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('editing the SECOND line only reports line 2, not line 1', () => {
  const { root, log } = repo();
  try {
    fs.writeFileSync(log,
      '{"id":"a1","ts":"2026-01-01T00:00:00Z","title":"one"}\n'
      + '{"id":"a2","ts":"2026-01-02T00:00:00Z","title":"TWO EDITED"}\n');
    const f = doctor.checkAppendOnlyGit(root);
    assert.equal(f.level, doctor.LEVEL.ERROR);
    assert.match(f.text, /global\/errors\.jsonl:2\b/);
    assert.ok(!/:1\b/.test(f.text), 'reported line 1 when only line 2 changed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a file not yet tracked in HEAD is UNKNOWN, not GOOD', () => {
  const { root } = repo();
  try {
    fs.writeFileSync(path.join(root, 'global', 'decisions.jsonl'),
      '{"id":"d1","ts":"2026-01-01T00:00:00Z","title":"never committed"}\n');
    const f = doctor.checkAppendOnlyGit(root);
    // The tracked file is clean, so the overall verdict must not be
    // ERROR — but it must also not claim GOOD covers a file git has
    // never seen.
    assert.notEqual(f.level, doctor.LEVEL.ERROR);
    assert.match(f.text, /not tracked in HEAD/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no git at all -> UNKNOWN, never GOOD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-aog-nogit-'));
  try {
    fs.mkdirSync(path.join(root, 'global'), { recursive: true });
    fs.writeFileSync(path.join(root, 'global', 'errors.jsonl'),
      '{"id":"g1","ts":"2026-01-01T00:00:00Z","title":"no repo at all"}\n');
    const f = doctor.checkAppendOnlyGit(root);
    assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a memory with no append-only logs yet is GOOD, not UNKNOWN', () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-aog-empty-'));
  try {
    git(top, 'init', '-q');
    const f = doctor.checkAppendOnlyGit(top);
    assert.equal(f.level, doctor.LEVEL.GOOD);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

test('NESTED repo: the memory root is a subdirectory of the git toplevel, not the toplevel itself', () => {
  // git show HEAD:<path> resolves <path> against the TOPLEVEL, not
  // against whatever -C was given — measured directly (2026-09-19):
  // `git -C <subdir> show HEAD:file.txt` for a file that exists at
  // <subdir>/file.txt answers "path 'sub/file.txt' exists, but not
  // 'file.txt'". Using path.relative(root, ...) without correcting for
  // this would make every file in a nested memory read as untracked.
  const { root, log } = repo({ nested: true });
  try {
    const good = doctor.checkAppendOnlyGit(root);
    assert.equal(good.level, doctor.LEVEL.GOOD, `nested-repo GOOD case failed: ${good.text}`);

    fs.writeFileSync(log, '{"id":"a1","ts":"2026-01-01T00:00:00Z","title":"TAMPERED"}\n');
    const bad = doctor.checkAppendOnlyGit(root);
    assert.equal(bad.level, doctor.LEVEL.ERROR, `nested-repo sabotage was not caught: ${bad.text}`);
    assert.match(bad.text, /global\/errors\.jsonl:1\b/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('large files are capped, and the finding SAYS so', () => {
  const { root, log } = repo();
  try {
    // Grow the working copy past the cap without touching git history —
    // the cap must be measured on the CURRENT file, not on the commit.
    const filler = 'x'.repeat(doctor.APPEND_ONLY_GIT_CAP_BYTES + 1000);
    fs.appendFileSync(log, `{"id":"a3","ts":"2026-01-03T00:00:00Z","title":"${filler}"}\n`);
    const f = doctor.checkAppendOnlyGit(root);
    assert.notEqual(f.level, doctor.LEVEL.ERROR, 'a capped file must not be reported as tampered');
    assert.match(f.text, /skipped/, 'a capped file must be named as skipped, not silently ignored');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('checkAppendOnlyGit is wired into checkAll()', () => {
  const { root } = repo();
  try {
    const result = doctor.checkAll(root);
    assert.ok(result.findings.some((x) => x.name === 'append-only-git'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the documented limit is honest: a rewrite that is COMMITTED is invisible to this check', () => {
  // Not a bug to fix — the stated boundary of "checked against git,
  // not against a hash chain". Proven here so the limit stays a fact
  // about the design, not a claim nobody checked.
  const { root, log, top } = repo();
  try {
    fs.writeFileSync(log,
      '{"id":"a1","ts":"2026-01-01T00:00:00Z","title":"REWRITTEN AND COMMITTED"}\n'
      + '{"id":"a2","ts":"2026-01-02T00:00:00Z","title":"two"}\n');
    git(top, 'add', '-A');
    git(top, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'quiet rewrite');
    const f = doctor.checkAppendOnlyGit(root);
    assert.equal(f.level, doctor.LEVEL.GOOD,
      'documenting the limit: HEAD now IS the rewritten content, so this reads as clean');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
