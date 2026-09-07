// The error class, asked at the moment of logging.
//
// On 2026-09-07 a first-time install on Windows produced four defects
// in an hour. Three fell into classes the memory already held — one
// with the same root cause, six days old, written down in the sibling
// repository as a lesson. The knowledge was there every time; nobody
// asked, because asking is a separate act.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cls-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  return r;
}
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });
const log = (r, d, project) => memory.logEntry(r, 'error',
  { author: 'lucky', authority: 'user', ...d }, { project: project ?? null });

test('THE CASE: the third repeat of a class is visible', () => {
  const r = build();
  try {
    for (const t of ['first', 'second', 'third']) log(r, { class: 'silent-failure', title: `${t} case`, text: 'x' });
    const seen = memory.sameClass(r, 'silent-failure');
    assert.equal(seen.count, 3);
    assert.equal(seen.latest.length, 3);
  } finally { gone(r); }
});

test('an entry does not count as a repeat of itself', () => {
  const r = build();
  try {
    const { entry } = log(r, { class: 'once', title: 'the only one', text: 'x' });
    assert.equal(memory.sameClass(r, 'once', { except: entry.id }).count, 0);
  } finally { gone(r); }
});

test('the class is found across project boundaries', () => {
  // Exactly the 2026-09-07 case: the lesson lived somewhere else.
  const r = build();
  try {
    log(r, { class: 'across', title: 'global', text: 'x' });
    execFileSync('node', [MEM, '--root', r, 'project', 'init', 'thing'], { stdio: 'ignore' });
    log(r, { class: 'across', title: 'in a project', text: 'x' }, 'thing');
    assert.equal(memory.sameClass(r, 'across').count, 2);
  } finally { gone(r); }
});

test('an unknown class says nothing', () => {
  const r = build();
  try { assert.equal(memory.sameClass(r, 'never-seen').count, 0); } finally { gone(r); }
});

test('the CLI prints the warning when logging a repeat', () => {
  const r = build();
  try {
    log(r, { class: 'repeat-me', title: 'the earlier one', text: 'x' });
    const out = execFileSync('node', [MEM, '--root', r, 'log', 'error',
      '--class', 'repeat-me', '--title', 'the later one', '--text', 'y'], { encoding: 'utf8' });
    assert.match(out, /Class 'repeat-me': this is number 2/);
    assert.match(out, /the earlier one/);
  } finally { gone(r); }
});

test('a first-of-its-kind prints no warning', () => {
  // A warning that always fires is not a warning.
  const r = build();
  try {
    const out = execFileSync('node', [MEM, '--root', r, 'log', 'error',
      '--class', 'brand-new', '--title', 'first', '--text', 'y'], { encoding: 'utf8' });
    assert.ok(!/this is number/.test(out), out);
  } finally { gone(r); }
});
