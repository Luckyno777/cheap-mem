// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// W11 (parity with the sibling's 9847a03): from the THIRD repetition of an
// error class or normalised title, a draft for a procedure. Red on the old
// stand (8a24c64): src/repetitionhint.mjs, the doctor finding and
// `mem suggest procedure` do not exist there. Writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as hint from '../src/repetitionhint.mjs';
import * as doctor from '../src/doctor.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rephint-'));
  assert.equal(spawnSync('node', [MEM, '--root', r, 'init'], { encoding: 'utf8' }).status, 0);
  return r;
}
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });
const errors = (r, rows) => fs.writeFileSync(path.join(r, 'global', 'errors.jsonl'),
  rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
const cli = (r, a) => spawnSync('node', [MEM, '--root', r, ...a], { encoding: 'utf8' });
const row = (id, ts, over = {}) => ({ id, ts, class: 'mishandling', title: 'Same wrong flag', text: 'It broke.', ...over });

test('no errors: not measurable (unknown), never good', () => {
  const r = build();
  try {
    assert.equal(doctor.checkRepetitionHint(r).level, 'unknown');
  } finally { gone(r); }
});

test('two repetitions are quiet (good), the THIRD of a class warns — whole log, no window (positive control)', () => {
  const r = build();
  try {
    errors(r, [row('e1', '2026-01-01T00:00:00Z'), row('e2', '2026-03-01T00:00:00Z')]);
    assert.equal(doctor.checkRepetitionHint(r).level, 'good');
    errors(r, [row('e1', '2026-01-01T00:00:00Z'), row('e2', '2026-03-01T00:00:00Z'), row('e3', '2026-09-01T00:00:00Z')]);
    const f = doctor.checkRepetitionHint(r);
    assert.equal(f.level, 'warn');
    assert.match(f.text, /3x mishandling/);
  } finally { gone(r); }
});

test('the same normalised title with DIFFERENT classes is caught as a title pattern', () => {
  const r = build();
  try {
    errors(r, [
      row('t1', '2026-09-01T00:00:00Z', { class: 'mishandling', title: 'Port already in use!' }),
      row('t2', '2026-09-02T00:00:00Z', { class: 'concurrency', title: 'port  already in use' }),
      row('t3', '2026-09-03T00:00:00Z', { class: 'environment', title: 'PORT already in use.' }),
    ]);
    const f = doctor.checkRepetitionHint(r);
    assert.equal(f.level, 'warn');
    assert.match(f.text, /3x "port already in use"/);
  } finally { gone(r); }
});

test('draft text only from the newest error: remedy field wins, then a marked sentence, then an unchecked first sentence', () => {
  assert.equal(hint.correctPathText({ remedy: ' Quote it. ', text: 'x' }), 'Quote it.');
  assert.equal(hint.correctPathText({ text: 'It broke badly. Fixed by quoting the value. Later again.' }), 'Fixed by quoting the value.');
  assert.match(hint.correctPathText({ text: 'It broke badly. Nothing else.' }), /^\(no correction marker found, first sentence\) It broke badly\./);
  assert.match(hint.correctPathText({}), /no text/);
});

test('a class with a procedure in force is skipped; mem suggest procedure prints and writes nothing', () => {
  const r = build();
  try {
    errors(r, [row('e1', '2026-09-01T00:00:00Z'), row('e2', '2026-09-02T00:00:00Z', { text: 'Old.' }),
      row('e3', '2026-09-03T00:00:00Z', { text: 'It broke. Fixed by quoting the value.' })]);
    const before = fs.readFileSync(path.join(r, 'global', 'errors.jsonl'));
    const s = cli(r, ['suggest', 'procedure', 'mishandling']);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, /mem log procedure --title "mishandling: Same wrong flag" --rule "Fixed by quoting the value\." --on-class mishandling --issued-by owner/);
    assert.ok(fs.readFileSync(path.join(r, 'global', 'errors.jsonl')).equals(before), 'nothing written');
    assert.equal(cli(r, ['suggest', 'procedure', 'nonsense']).status, 1);
    assert.equal(cli(r, ['suggest', 'procedure', 'concurrency']).status, 1, 'no errors of that class');
    // Put a procedure in force for the class: skipped now.
    const p = cli(r, ['log', 'procedure', '--title', 'quote flags', '--rule', 'Always quote.', '--issued-by', 'owner', '--on-class', 'mishandling']);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.equal(doctor.checkRepetitionHint(r).level, 'good');
    const again = cli(r, ['suggest', 'procedure', 'mishandling']);
    assert.equal(again.status, 1);
    assert.match(again.stderr + again.stdout, /already has a procedure in force/);
  } finally { gone(r); }
});
