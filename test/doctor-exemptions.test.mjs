// The doctor's own declaration of where `ok` over zero is honest.
//
// **Why this file exists.** Three places ask the same question — the
// guarantee in `test/no-empty-green.test.mjs`, the `doctor.ok-on-empty`
// record in the atlas, and anyone reading a doctor run. Until
// 2026-09-20 each answered it separately, and the atlas answered it with
// a word list: `/(0|no|nothing|empty)/` over the finding's text. That is
// a rule about spelling. It flagged `corpus-size` — "0 entries, under
// the 50000-entry sharding line" — as a check that measured nothing. It
// measured; the answer was zero.
//
// `OK_OVER_ZERO` in src/doctor.mjs is now the single declaration. This
// file holds the properties that make a declaration different from a
// place to make failures go away.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as doctor from '../src/doctor.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

test('CONTROL: the declaration exists and is not empty', () => {
  // Without this every assertion below could be passing over {}.
  assert.equal(typeof doctor.OK_OVER_ZERO, 'object');
  assert.ok(Object.keys(doctor.OK_OVER_ZERO).length >= 4,
    'the declaration has shrunk to almost nothing — that is not a carve-out, it is a hole');
});

test('every exempted name is a finding the doctor actually produces', () => {
  // A name that matches nothing is worse than no name: it looks like a
  // considered decision and excuses nobody. It also survives a rename
  // silently, which is how the exemption quietly stops covering the
  // finding it was written for.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-exempt-'));
  try {
    execFileSync(process.execPath, [MEM, 'init'],
      { env: { ...process.env, CHEAP_MEM_ROOT: root }, stdio: 'ignore' });
    const names = new Set(doctor.checkAll(root).findings.map((f) => f.name));
    const stale = Object.keys(doctor.OK_OVER_ZERO).filter((n) => !names.has(n));
    assert.deepEqual(stale, [],
      `exempted names that no finding uses: ${stale.join(', ')}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every exemption argues, it does not label', () => {
  // The load-bearing property. "checks the environment" is a category;
  // "inspected the folder and found it empty, which answers the question"
  // is an argument someone can disagree with. A list of categories is a
  // list of excuses.
  for (const [name, why] of Object.entries(doctor.OK_OVER_ZERO)) {
    assert.ok(typeof why === 'string' && why.length >= 40,
      `the exemption for '${name}' has no real reason: ${JSON.stringify(why)}`);
    assert.match(why, /which|because|and |—/,
      `the exemption for '${name}' states a category, not an argument: ${why}`);
  }
});

test('SABOTAGE CONTROL: a made-up name would be caught', () => {
  // The probe above can only be trusted if it can fail. Run the same
  // check against a declaration carrying a finding that does not exist.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-exempt2-'));
  try {
    execFileSync(process.execPath, [MEM, 'init'],
      { env: { ...process.env, CHEAP_MEM_ROOT: root }, stdio: 'ignore' });
    const names = new Set(doctor.checkAll(root).findings.map((f) => f.name));
    const fake = { ...doctor.OK_OVER_ZERO, 'a-finding-that-does-not-exist': 'x' };
    const stale = Object.keys(fake).filter((n) => !names.has(n));
    assert.deepEqual(stale, ['a-finding-that-does-not-exist'],
      'the staleness check cannot see a name that matches no finding');
    // And the reason check, sabotaged the same way.
    assert.equal('x'.length >= 40, false, 'the reason floor would accept anything');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
