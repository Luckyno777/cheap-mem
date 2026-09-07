/**
 * The three ways a write used to be destroyed without a word.
 *
 * All three were found in the sibling project lucky-mem, which shares this
 * design and has a real corpus to show the damage in: two entries whose
 * content was eaten by the argument parser, seventeen whose tags became
 * half-parsed JSON, and one duplicate id in 874 entries. cheap-mem had all
 * three shapes and no damage yet, because cheap-mem keeps no corpus of its
 * own — the damage would have landed in the user's memory instead.
 *
 * Each group starts with a positive control. A guard that refuses
 * everything looks identical to a correct one in a test that only ever
 * feeds it bad input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { checkEntryForm, LEVEL } from '../src/doctor.mjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MEM = path.join(PKG_ROOT, 'bin', 'mem');

function root() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-write-'));
  spawnSync('node', [MEM, 'init', '--root', w], { encoding: 'utf8' });
  return w;
}
const run = (w, ...a) => spawnSync('node', [MEM, ...a, '--root', w], { encoding: 'utf8' });
const entries = (w, type) => memory.readLog(w, type, { project: null }).entries;

// --- 1. lists: comma-separated or JSON, never half ---------------------

test('comma-separated tags still work', () => {
  const w = root();
  const r = run(w, 'log', 'learning', '--title', 'x', '--tags', 'ops, deploy ,rollback');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(entries(w, 'learning')[0].tags, ['ops', 'deploy', 'rollback']);
  fs.rmSync(w, { recursive: true, force: true });
});

test('a JSON list is read as a list, not cut at the commas', () => {
  const w = root();
  const r = run(w, 'log', 'learning', '--title', 'x', '--tags', '["ops","deploy"]');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(entries(w, 'learning')[0].tags, ['ops', 'deploy'],
    'this used to become the tags ["ops and "deploy"]');
  fs.rmSync(w, { recursive: true, force: true });
});

test('--asked gets the same treatment as --tags', () => {
  const w = root();
  const r = run(w, 'log', 'learning', '--title', 'x', '--asked', '["how","why"]');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(entries(w, 'learning')[0].asked, ['how', 'why']);
  fs.rmSync(w, { recursive: true, force: true });
});

test('something that looks like JSON but is not is refused, not cut up', () => {
  const w = root();
  const r = run(w, 'log', 'learning', '--title', 'x', '--tags', '["ops","deploy"');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /looks like JSON but is not/);
  assert.equal(entries(w, 'learning').length, 0, 'refused means nothing written');
  fs.rmSync(w, { recursive: true, force: true });
});

test('quotes on the comma path are refused — half JSON does not get through', () => {
  const w = root();
  const r = run(w, 'log', 'learning', '--title', 'x', '--tags', '"ops","deploy"');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /brackets or quotes/);
  fs.rmSync(w, { recursive: true, force: true });
});

test('correction obeys the same rules as log', () => {
  const w = root();
  run(w, 'log', 'learning', '--title', 'old', '--tags', 'ops');
  const id = entries(w, 'learning')[0].id;

  const ok = run(w, 'correction', 'learning', id, '--title', 'new', '--tags', '["ops","deploy"]');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(entries(w, 'learning')[1].tags, ['ops', 'deploy']);
  assert.equal(entries(w, 'learning')[1].replaces_id ?? entries(w, 'learning')[1].replaces, id,
    'the correction still points at the entry it replaces');

  const bad = run(w, 'correction', 'learning', id, '--title', 'new', '--tags', '"ops","deploy"');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /^correction: /m, 'the message names the command that raised it');
  fs.rmSync(w, { recursive: true, force: true });
});

// --- 2. the swallowed value -------------------------------------------

test('a value beginning with -- is refused instead of destroying the entry', () => {
  const w = root();
  const r = run(w, 'log', 'error', '--title', '--dangerously-skip-permissions under root: watcher failed');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /field names have no whitespace|arrived without a value/);
  assert.equal(entries(w, 'error').length, 0);
  fs.rmSync(w, { recursive: true, force: true });
});

test('the documented escape hatch works (positive control)', () => {
  const w = root();
  const r = run(w, 'log', 'error', '--title=--dangerously-skip-permissions under root');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(entries(w, 'error')[0].title, '--dangerously-skip-permissions under root');
  fs.rmSync(w, { recursive: true, force: true });
});

// --- 3. ids -----------------------------------------------------------

test('a generated id is 12 chars and does not repeat', () => {
  const w = root();
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { entry } = memory.logEntry(w, 'learning', { title: `n${i}` });
    assert.equal(entry.id.length, memory.ID_LENGTH, `id ${entry.id} has the wrong length`);
    assert.ok(!seen.has(entry.id), `id ${entry.id} appeared twice`);
    seen.add(entry.id);
  }
  fs.rmSync(w, { recursive: true, force: true });
});

test('a supplied id that is already taken is refused', () => {
  const w = root();
  const { entry } = memory.logEntry(w, 'learning', { title: 'first' });
  assert.throws(() => memory.logEntry(w, 'error', { id: entry.id, title: 'second' }),
    /already taken/, 'across types, not just within one');
  fs.rmSync(w, { recursive: true, force: true });
});

test('a supplied id that is free still works (positive control)', () => {
  const w = root();
  const { entry } = memory.logEntry(w, 'learning', { id: 'my-own-id', title: 'x' });
  assert.equal(entry.id, 'my-own-id');
  fs.rmSync(w, { recursive: true, force: true });
});

// --- 4. the doctor sees what is already written -----------------------

test('entry-form: green on a clean memory', () => {
  const w = root();
  memory.logEntry(w, 'learning', { title: 'fine', tags: ['ops'] });
  assert.equal(checkEntryForm(w).level, LEVEL.GOOD);
  fs.rmSync(w, { recursive: true, force: true });
});

test('entry-form: finds both damage shapes and names the place', () => {
  const w = root();
  const p = path.join(w, 'global', 'learnings.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [
    JSON.stringify({ id: 'a', ts: '2026-09-01T00:00:00Z', title: 'ok', tags: ['ops'] }),
    JSON.stringify({ id: 'b', ts: '2026-09-01T00:00:01Z', title: true, 'eaten value here': true }),
    JSON.stringify({ id: 'c', ts: '2026-09-01T00:00:02Z', title: 'x', tags: ['["ops"'] }),
  ].join('\n') + '\n');
  const f = checkEntryForm(w);
  assert.equal(f.level, LEVEL.WARN);
  assert.match(f.text, /2 malformed/);
  assert.match(f.text, /learnings\.jsonl:2/);
  assert.match(f.advice, /backwards redaction/);
  fs.rmSync(w, { recursive: true, force: true });
});

test('entry-form: a note of class entry-form caps what came before it', () => {
  const w = root();
  const p = path.join(w, 'global', 'learnings.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p,
    `${JSON.stringify({ id: 'c', ts: '2026-09-01T00:00:00Z', title: 'x', tags: ['["ops"'] })}\n`);
  memory.logEntry(w, 'error', {
    ts: '2026-09-02T00:00:00Z', class: 'entry-form', title: 'one line, stays', text: '.',
  });
  const f = checkEntryForm(w);
  assert.equal(f.level, LEVEL.GOOD, 'on the record is not open');
  assert.match(f.text, /1 on the record/, 'and it is still counted');
  fs.rmSync(w, { recursive: true, force: true });
});

test('entry-form: the cap does not cover what comes after it', () => {
  const w = root();
  memory.logEntry(w, 'error', {
    ts: '2026-09-01T00:00:00Z', class: 'entry-form', title: 'old cap', text: '.',
  });
  const p = path.join(w, 'global', 'learnings.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p,
    `${JSON.stringify({ id: 'c', ts: '2026-09-03T00:00:00Z', title: 'x', tags: ['["ops"'] })}\n`);
  assert.equal(checkEntryForm(w).level, LEVEL.WARN);
  fs.rmSync(w, { recursive: true, force: true });
});
