// invariant: eintrag-traegt-inhalt
/**
 * B2 — the empty-entry guard.
 *
 * **The finding (2026-09-26, measured on an empty --root).**
 *
 *   `mem log error --tags a,b`   -> {id, ts, v, tags, agent}, exit 0
 *   `mem log error --hilfe`      -> {id, ts, v, hilfe: true, agent}, exit 0
 *
 * Both are real `--field`s (the only check `mem log` had before this),
 * and neither leaves anything a later search could ever find. The
 * sibling project (lucky-mem) found the identical hole the same day:
 * 4 of 2441 real entries carried no text field at all, all four from a
 * help-flag typo. `memory.hasContent()` is the one rule both `mem log`
 * (refuses) and the doctor's `checkEntryForm` (reports what already got
 * past an earlier build) now share.
 *
 * **An open question this file states rather than hides.** The plan
 * this was cut from also names `mem log error --class x` alone as a
 * shape that should be refused. Measured against the actual rule
 * (ported faithfully from lucky-mem's `hatInhalt`/`MASCHINENFELDER`,
 * where `klasse` is deliberately NOT a machine field either): it is
 * NOT refused. `class` is a value the user chose, not one the code
 * stamps, so it counts as content — thin content, but content. See
 * `memory.hasContent`'s doc comment for the reasoning, and the last
 * two tests in this file for what it actually does. Measurement wins
 * over the plan where they disagree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { checkEntryForm, LEVEL, EMPTY_ENTRY_CLASS } from '../src/doctor.mjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MEM = path.join(PKG_ROOT, 'bin', 'mem');

function root() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-content-'));
  spawnSync('node', [MEM, 'init', '--root', w], { encoding: 'utf8' });
  return w;
}
const run = (w, ...a) => spawnSync('node', [MEM, ...a, '--root', w], { encoding: 'utf8' });
const entries = (w, type) => memory.readLog(w, type, { project: null }).entries;

// --- 1. memory.hasContent() itself -------------------------------------

test('POSITIVE CONTROL: an ordinary entry has content', () => {
  assert.equal(memory.hasContent({ id: 'a', ts: '2026-09-26T00:00:00Z', v: 1, agent: 'x', title: 'hello' }), true);
});

test('machine fields alone are not content', () => {
  assert.equal(memory.hasContent({
    id: 'a', ts: '2026-09-26T00:00:00Z', v: 1, agent: 'human:root', project: 'p',
    state: 'done', status: 'open', replaces_id: 'b', closes_id: 'c', retires_id: 'd',
    authority: 'user', authority_clamped_from: 'inferred', guard_at_creation: 'green',
  }), false);
});

test('an array field (tags) is not content, however many entries', () => {
  assert.equal(memory.hasContent({ id: 'a', ts: 't', v: 1, agent: 'x', tags: ['a', 'b', 'c'] }), false);
});

test('a boolean field (the swallowed --hilfe shape) is not content', () => {
  assert.equal(memory.hasContent({ id: 'a', ts: 't', v: 1, agent: 'x', hilfe: true }), false);
});

test('a whitespace-only string is not content', () => {
  assert.equal(memory.hasContent({ id: 'a', ts: 't', v: 1, agent: 'x', title: '   ' }), false);
});

test('REGRESSION: a single non-empty character is content — do not repeat the 3-char draft', () => {
  // lucky-mem's own history: a first draft required 3 characters and
  // rejected ten real probes logging with a one-word --wahl. The rule
  // that shipped there (and is ported here) requires only 1.
  assert.equal(memory.hasContent({ id: 'a', ts: 't', v: 1, agent: 'x', why: 'y' }), true);
});

test('not an object at all is not content', () => {
  assert.equal(memory.hasContent(null), false);
  assert.equal(memory.hasContent(undefined), false);
  assert.equal(memory.hasContent('title'), false);
});

test('DOCUMENTED DISCREPANCY: --class alone counts as content, unlike --tags or --hilfe', () => {
  // `class` is user-chosen (checked against errorclass.mjs's vocabulary),
  // not code-stamped — same reasoning that keeps `klasse` off the
  // sibling project's machine-field list. This is a deliberate, measured
  // answer, not an oversight: see the file-level comment above.
  assert.equal(memory.hasContent({ id: 'a', ts: 't', v: 1, agent: 'x', class: 'mishandling' }), true);
});

// --- 2. `mem log` refuses, writes nothing, exits 1 ---------------------

test('POSITIVE CONTROL: an ordinary log still writes', () => {
  const w = root();
  const r = run(w, 'log', 'error', '--class', 'mishandling', '--title', 't', '--text', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(entries(w, 'error').length, 1);
  fs.rmSync(w, { recursive: true, force: true });
});

test('--tags alone is refused, and nothing is written', () => {
  const w = root();
  const r = run(w, 'log', 'error', '--tags', 'a,b');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no content|never findable/);
  assert.equal(entries(w, 'error').length, 0);
  fs.rmSync(w, { recursive: true, force: true });
});

test('an unknown bare switch that becomes a boolean field (--hilfe) is refused', () => {
  const w = root();
  const r = run(w, 'log', 'error', '--hilfe');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(entries(w, 'error').length, 0);
  fs.rmSync(w, { recursive: true, force: true });
});

test('a single one-word field is enough — the guard is not the 3-char draft', () => {
  const w = root();
  const r = run(w, 'log', 'decision', '--topic', 't', '--choice', 'x', '--why', 'y');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(entries(w, 'decision').length, 1);
  fs.rmSync(w, { recursive: true, force: true });
});

test('--class alone still writes (see the file-level note on the discrepancy)', () => {
  const w = root();
  const r = run(w, 'log', 'error', '--class', 'mishandling');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(entries(w, 'error').length, 1);
  fs.rmSync(w, { recursive: true, force: true });
});

// --- 3. the doctor sees what an earlier build already wrote -----------

test('entry-form: green when every entry has content', () => {
  const w = root();
  memory.logEntry(w, 'learning', { title: 'fine', tags: ['ops'] });
  assert.equal(checkEntryForm(w).level, LEVEL.GOOD);
  fs.rmSync(w, { recursive: true, force: true });
});

test('entry-form: a content-less line is reported, not silently passed', () => {
  const w = root();
  const p = path.join(w, 'global', 'learnings.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    id: 'emptyentry01', ts: '2026-09-17T00:00:00Z', v: 1, agent: 'bibliothekar', hilfe: true,
  })}\n`);
  const f = checkEntryForm(w);
  assert.equal(f.level, LEVEL.WARN);
  assert.match(f.text, /1 malformed/);
  assert.match(f.text, /no content field/);
  fs.rmSync(w, { recursive: true, force: true });
});

test(`entry-form: a ${EMPTY_ENTRY_CLASS} finding naming the id marks it handled`, () => {
  const w = root();
  const p = path.join(w, 'global', 'learnings.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    id: 'emptyentry01', ts: '2026-09-17T00:00:00Z', v: 1, agent: 'bibliothekar', hilfe: true,
  })}\n`);
  memory.logEntry(w, 'error', {
    class: EMPTY_ENTRY_CLASS,
    title: 'empty via --hilfe: emptyentry01',
    text: 'global/learnings.jsonl:1 (id emptyentry01) carries no content field. Nothing to '
      + 'rescue; append-only leaves it standing. This line marks it handled.',
  });
  const f = checkEntryForm(w);
  assert.equal(f.level, LEVEL.GOOD, 'a named-id acknowledgement is not open');
  assert.match(f.text, /1 on the record/, 'and it is still counted, not erased');
  fs.rmSync(w, { recursive: true, force: true });
});

test(`entry-form: a ${EMPTY_ENTRY_CLASS} finding naming a DIFFERENT id leaves this one open`, () => {
  const w = root();
  const p = path.join(w, 'global', 'learnings.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    id: 'emptyentry01', ts: '2026-09-17T00:00:00Z', v: 1, agent: 'bibliothekar', hilfe: true,
  })}\n`);
  memory.logEntry(w, 'error', {
    class: EMPTY_ENTRY_CLASS, title: 'empty via --hilfe: someOtherId12', text: 'not this one',
  });
  assert.equal(checkEntryForm(w).level, LEVEL.WARN, 'naming the wrong id acknowledges nothing');
  fs.rmSync(w, { recursive: true, force: true });
});

test('entry-form: the empty-entry acknowledgement is independent of the entry-form timestamp cap', () => {
  // A correction can rescue a malformed-but-present field; it cannot
  // rescue a field that was never there. So this ack works by id, not
  // by "everything before date X" — and it must work even with NO
  // entry-form cap in place at all.
  const w = root();
  const p = path.join(w, 'global', 'learnings.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    id: 'emptyentry01', ts: '2026-09-25T00:00:00Z', v: 1, agent: 'bibliothekar', hilfe: true,
  })}\n`);
  memory.logEntry(w, 'error', {
    ts: '2026-09-20T00:00:00Z', // BEFORE the empty entry's own timestamp
    class: EMPTY_ENTRY_CLASS, title: 'emptyentry01 named here', text: '.',
  });
  assert.equal(checkEntryForm(w).level, LEVEL.GOOD, 'named by id, not capped by time');
  fs.rmSync(w, { recursive: true, force: true });
});
