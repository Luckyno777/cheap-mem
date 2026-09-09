// The procedure that was written for exactly this failure, offered at
// the moment somebody is filing it.
//
// **Why a rule needs a trigger at all.** A procedure that only surfaces
// when somebody remembers to run `mem procedures` applies when it is
// least needed. The moment it is actually wanted is the moment somebody
// is recording the failure it was written against — and at that moment
// they have just typed the class name.
//
// **Why this is cheap here and expensive elsewhere.** Matching a rule to
// a situation by keyword is guessing. Matching against twelve fixed
// names is a lookup. The closed error vocabulary, built for counting,
// pays a second time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as procedure from '../src/procedure.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function memory() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-trig-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
const run = (r, ...a) =>
  spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8' });

const RULE = ['log', 'procedure',
  '--title', 'Falsify, do not confirm',
  '--rule', 'Ask what would be visible if it did NOT work, then build that probe.',
  '--issued-by', 'owner'];

test('THE CASE: filing an error offers the procedure armed for its class', () => {
  const r = memory();
  try {
    run(r, ...RULE, '--on-class', 'looks-right-does-nothing');
    const out = run(r, 'log', 'error', '--title', 'the hook ran and did nothing',
      '--class', 'looks-right-does-nothing').stdout;
    assert.match(out, /1 procedure in force for this class/);
    assert.match(out, /Falsify, do not confirm/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('COUNTER-PROBE: a different class offers nothing', () => {
  // Without this, a rule shown for every error would pass the probe
  // above and mean nothing.
  const r = memory();
  try {
    run(r, ...RULE, '--on-class', 'looks-right-does-nothing');
    const out = run(r, 'log', 'error', '--title', 'a race', '--class', 'concurrency').stdout;
    assert.ok(!/procedure in force/.test(out), `offered anyway:\n${out}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the hyphenated flag is stored as the underscore field', () => {
  // The trap `issued-by` already fell into once. Written as `on-class`,
  // read as `on_class`, the rule never fires — a procedure that exists
  // and does nothing, which is the class it was probably written
  // against.
  const r = memory();
  try {
    run(r, ...RULE, '--on-class', 'two-truths');
    const line = JSON.parse(
      fs.readFileSync(path.join(r, 'global', 'procedures.jsonl'), 'utf8').trim());
    assert.equal(line.on_class, 'two-truths');
    assert.equal(line['on-class'], undefined, 'the hyphenated key survived');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('an unknown trigger class is REFUSED at write time', () => {
  // Everywhere else `mem log` writes and warns, because a refused write
  // loses content. Here there is no content to lose: a trigger on a
  // class that does not exist never fires, and the rule sits in the log
  // looking armed.
  const r = memory();
  try {
    const res = run(r, ...RULE, '--on-class', 'no-such-class');
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /does not exist/);
    assert.match(res.stderr, /never fires/);
    assert.equal(fs.existsSync(path.join(r, 'global', 'procedures.jsonl')), false,
      'the rule was written anyway');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('an old alias in the flag still arms the rule', () => {
  // `silent-failure` is a documented old name for
  // `looks-right-does-nothing`. Refusing it would punish somebody for
  // knowing the history; storing it raw would mean it never matches.
  // So it is normalised on the way in.
  const r = memory();
  try {
    run(r, ...RULE, '--on-class', 'silent-failure');
    const line = JSON.parse(
      fs.readFileSync(path.join(r, 'global', 'procedures.jsonl'), 'utf8').trim());
    assert.equal(line.on_class, 'looks-right-does-nothing');
    const out = run(r, 'log', 'error', '--title', 'silent again',
      '--class', 'looks-right-does-nothing').stdout;
    assert.match(out, /procedure in force/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('several classes on one rule, and each one arms it', () => {
  const r = memory();
  try {
    run(r, ...RULE, '--on-class', 'looks-right-does-nothing,check-tests-the-wrong-thing');
    for (const c of ['looks-right-does-nothing', 'check-tests-the-wrong-thing']) {
      assert.match(run(r, 'log', 'error', '--title', 'x', '--class', c).stdout,
        /procedure in force/, `${c} did not arm it`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a retired procedure is not offered', () => {
  // One reading of "in force", not two: the same exclusion
  // `mem procedures` applies.
  const r = memory();
  try {
    run(r, ...RULE, '--on-class', 'two-truths');
    const line = JSON.parse(
      fs.readFileSync(path.join(r, 'global', 'procedures.jsonl'), 'utf8').trim());
    run(r, 'done', line.id, '--why', 'superseded by a better rule');
    assert.equal(procedure.forClass(r, 'two-truths').length, 0,
      'a retired rule is still offered');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('triggersOf drops what it cannot map, and never guesses', () => {
  assert.deepEqual(procedure.triggersOf({ on_class: 'looks-right-does-nothing' }),
    ['looks-right-does-nothing']);
  assert.deepEqual(procedure.triggersOf({ on_class: 'silent-failure, nonsense' }),
    ['looks-right-does-nothing']);
  assert.deepEqual(procedure.triggersOf({}), []);
  assert.deepEqual(procedure.triggersOf({ on_class: 'a, a, looks-right-does-nothing' }),
    ['looks-right-does-nothing'], 'duplicates or junk got through');
});

test('a rule with no trigger keeps working as before', () => {
  // The feature is additive. A procedure without `on_class` must not
  // start failing to be written, or start being offered everywhere.
  const r = memory();
  try {
    const res = run(r, ...RULE);
    assert.equal(res.status, 0, res.stderr);
    const out = run(r, 'log', 'error', '--title', 'x', '--class', 'concurrency').stdout;
    assert.ok(!/procedure in force/.test(out));
    assert.match(run(r, 'procedures').stdout, /Falsify, do not confirm/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
