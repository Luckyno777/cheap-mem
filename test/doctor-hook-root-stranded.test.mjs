// test/doctor-hook-root-stranded.test.mjs — finding `hook-root-stranded`
// (L12, mirrored from lucky-mem's `haken-wurzel-stau`): has this clone's
// root diverged from origin in the way that hides unpushed captures?
//
// **The incident this mirrors (error `1968v6itl823`, 2026-09-27, on the
// lucky-mem side).** A clone sat 365 commits behind origin AND 62
// commits ahead on its own side (capture commits). `git pull --ff-only`
// then failed on every session start, visible only as one overlooked
// warning line ("pull failed — working with the local state"); the Stop
// hook kept committing captures locally forever, because it never
// checked whether a push had ever actually succeeded. Read while
// building this finding, and confirmed true: cheap-mem's bin/mem-stop
// carries the identical auto-commit mechanism for raw/ +
// raw-record.jsonl (pull --ff-only, on failure pull --rebase + retry),
// so this half of the lucky-mem finding is buildable here too — only
// the third, journal-specific path is not, because cheap-mem has no
// display journal at all.
//
// Four states, four probes: unknown (no origin known), ok (nothing
// ahead, nothing dirty), warning (something is ahead/dirty, but
// fast-forwardable — a push is enough) and error (diverged AND
// captures/record are stuck — exactly the incident above).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as doctor from '../src/doctor.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function findingFor(root) {
  return doctor.checkAll(root).findings.find((f) => f.name === 'hook-root-stranded');
}

/** A bare `origin` with one first commit on `main`. */
function newOrigin() {
  const base = tempDir('cm-hrs-');
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(base, 'seed');
  git(base, 'clone', '-q', origin, seed);
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'file.txt'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  return { base, origin };
}

function clone(origin, base, name) {
  const dest = path.join(base, name);
  git(base, 'clone', '-q', origin, dest);
  git(dest, 'config', 'user.email', 't@t');
  git(dest, 'config', 'user.name', 't');
  return dest;
}

function commitFile(cwd, file, content, message) {
  const abs = path.join(cwd, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

test('ok: a fresh clone level with origin, nothing stuck', () => {
  const { base, origin } = newOrigin();
  const k = clone(origin, base, 'clone-ok');
  const f = findingFor(k);
  assert.ok(f, 'finding hook-root-stranded is missing');
  assert.equal(f.level, doctor.LEVEL.GOOD);
});

test('warning: ahead locally (captures), but fast-forwardable — a push would be enough', () => {
  const { base, origin } = newOrigin();
  const k = clone(origin, base, 'clone-warning');
  commitFile(k, 'raw/f1.jsonl', 'line1\n', 'capture: 2026-09-27T00-00-00Z');
  commitFile(k, 'raw/f2.jsonl', 'line2\n', 'capture: 2026-09-27T00-10-00Z');
  const f = findingFor(k);
  assert.equal(f.level, doctor.LEVEL.WARN);
  assert.match(f.text, /2 commits ahead of origin\/main/);
  assert.match(f.text, /2 of them captures/);
  assert.match(f.text, /fast-forwardable/);
  assert.match(f.advice, /push origin HEAD:main/);
});

test('warning: no commits ahead, but unstaged changes in raw-record.jsonl sit stuck', () => {
  // The second half of the incident (an unstaged tracked file), independent
  // of any capture commit: plain "something is stuck" without HEAD even
  // being ahead.
  const { base, origin } = newOrigin();
  const k = clone(origin, base, 'clone-record-dirty');
  fs.writeFileSync(path.join(k, 'raw-record.jsonl'), '{"z":1}\n');
  git(k, 'add', 'raw-record.jsonl');
  git(k, 'commit', '-q', '-m', 'record file tracked');
  git(k, 'push', '-q', 'origin', 'main');
  fs.appendFileSync(path.join(k, 'raw-record.jsonl'), '{"z":2}\n');
  const f = findingFor(k);
  assert.equal(f.level, doctor.LEVEL.WARN);
  assert.match(f.text, /unstaged changes/);
});

test('error: diverged AND capture commits are stuck locally — the incident itself', () => {
  const { base, origin } = newOrigin();
  const k = clone(origin, base, 'clone-error');
  // origin keeps moving WITHOUT k ever pulling successfully.
  const secondWriter = clone(origin, base, 'second-writer');
  commitFile(secondWriter, 'elsewhere.txt', 'x\n', 'foreign-commit');
  git(secondWriter, 'push', '-q', 'origin', 'main');
  // k keeps capturing locally (Stop-hook capture) while origin has moved on.
  commitFile(k, 'raw/f1.jsonl', 'line1\n', 'capture: 2026-09-27T00-00-00Z');
  // The hook DOES fetch origin (fetch usually succeeds; only the
  // ff-only pull fails) — a real fetch here, no network access inside
  // the finding itself.
  git(k, 'fetch', '-q', 'origin', 'main');
  const f = findingFor(k);
  assert.equal(f.level, doctor.LEVEL.ERROR);
  assert.match(f.text, /1 commits ahead of origin\/main/);
  assert.match(f.text, /NOT fast-forwardable/);
  assert.match(f.advice, /worktree add --detach/);
});

test('unknown: no origin known — not measurable is not good', () => {
  const w = tempDir('cm-hrs-no-origin-');
  git(w, 'init', '-q', '-b', 'main');
  git(w, 'config', 'user.email', 't@t');
  git(w, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(w, 'file.txt'), 'x\n');
  git(w, 'add', '-A');
  git(w, 'commit', '-q', '-m', 'init');
  const f = findingFor(w);
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
});

test('unknown: not a git clone at all', () => {
  const w = tempDir('cm-hrs-no-git-');
  const f = findingFor(w);
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
});
