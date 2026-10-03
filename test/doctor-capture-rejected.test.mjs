// test/doctor-capture-rejected.test.mjs — finding `capture-rejected`
// (error 1rmp6w45nul6, mirrored from lucky-mem's `rohfang-abgewiesen`).
// A raw capture the pre-commit rejected stays staged in the index, and
// nobody saw it. Probes: good (nothing staged), warning (capture staged,
// not committed), and a staged foreign path does not count.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as doctor from '../src/doctor.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const findingFor = (r) => doctor.checkAll(r).findings.find((f) => f.name === 'capture-rejected');
const made = [];
process.on('exit', () => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-caprejd-'));
  made.push(r);
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t');
  git(r, 'config', 'user.name', 't');
  git(r, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(r, 'file.txt'), 'base\n');
  git(r, 'add', 'file.txt');
  git(r, 'commit', '-q', '-m', 'base');
  return r;
}

test('GOOD: nothing staged', () => {
  const f = findingFor(repo());
  assert.ok(f, 'finding missing');
  assert.equal(f.level, doctor.LEVEL.GOOD);
});

test('WARNING: raw capture staged and not committed', () => {
  const r = repo();
  fs.mkdirSync(path.join(r, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(r, 'raw', 'capture.jsonl'), 'line\n');
  fs.writeFileSync(path.join(r, 'raw-record.jsonl'), 'line\n');
  git(r, 'add', 'raw', 'raw-record.jsonl');
  const f = findingFor(r);
  assert.equal(f.level, doctor.LEVEL.WARN);
  assert.match(f.text, /2 raw-capture path/);
  assert.match(f.text, /rejected/);
});

test('GOOD: a staged foreign path is no capture backlog; after the commit the capture is gone from the count', () => {
  const r = repo();
  fs.writeFileSync(path.join(r, 'other.txt'), 'x\n');
  git(r, 'add', 'other.txt');
  assert.equal(findingFor(r).level, doctor.LEVEL.GOOD);
  fs.mkdirSync(path.join(r, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(r, 'raw', 'capture.jsonl'), 'z\n');
  git(r, 'add', 'raw');
  assert.equal(findingFor(r).level, doctor.LEVEL.WARN);
  git(r, 'commit', '-q', '-m', 'capture: probe');
  assert.equal(findingFor(r).level, doctor.LEVEL.GOOD);
});
