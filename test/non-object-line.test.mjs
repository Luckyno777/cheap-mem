// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Second review of the shape rule (2026-10-12), L2: a drawer line that is literally `null` crashed 43 of 85 read commands
// ("Cannot read properties of null"). `shapeProblem` answered `null` ("fine") for everything that is not an object, and
// `parseLine` handed the parsed `null` through as an entry. Any top-level non-object - null, a number, a text, a boolean, a list
// - is a BROKEN line now, with a reason, in `parseLine`, in the drawer memo and in `shapeProblem` itself; `mem status` (the
// `content` step) does not count it as an entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as setup from '../src/setup.mjs';
import { shapeProblem } from '../src/fieldshape.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const FORMS = ['null', '5', '"just a text"', 'true', 'false', '[]', '[1,2]', '[{"title":"x"}]', '0', '""'];
const CRASH = /Cannot read prop|TypeError|is not iterable|is not a function|Cannot convert|RangeError/;

const cli = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a],
  { encoding: 'utf8', input: '', timeout: 90000, env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_ROOT: root } });

function world(t, withHealthy = true) {
  const root = tempDir('cm-nonobj-', t);
  assert.equal(cli(root, 'init', '--participants', 'lucky,session', '--human', 'lucky').status, 0);
  if (withHealthy) {
    memory.logEntry(root, 'thought', { title: 'alpha one', text: 'alpha healthy words', agent: 'lucky' });
    memory.logEntry(root, 'decision', { title: 'alpha dec', choice: 'a', why: 'w', agent: 'lucky' });
    memory.logEntry(root, 'duty', { title: 'alpha duty', duty: 'd', owner: 'lucky', agent: 'lucky' });
  }
  return root;
}

test('shapeProblem and parseLine: every top-level non-object is broken, with a reason', () => {
  for (const form of FORMS) {
    const value = JSON.parse(form);
    assert.ok(shapeProblem(value), `shapeProblem(${form}) found nothing wrong`);
    const e = memory.parseLine(form);
    assert.equal(e.__broken, true, `parseLine(${form}) delivered an entry: ${JSON.stringify(e)}`);
    assert.ok(e.reason, `parseLine(${form}) has no reason`);
    assert.equal(e.raw, form);
  }
  // positive controls: an object (also an empty one) stays an entry
  assert.equal(shapeProblem({}), null);
  assert.equal(shapeProblem({ title: 'x' }), null);
  assert.equal(memory.parseLine('{"id":"a1","title":"x"}').title, 'x');
});

test('a line of any non-object form does not crash the read commands, and the doctor names it', (t) => {
  const root = world(t);
  const file = path.join(root, 'global', 'thoughts.jsonl');
  fs.appendFileSync(file, `${FORMS.join('\n')}\n`);
  const READ = [['context'], ['core'], ['facts'], ['find', 'alpha'], ['find', 'alpha', '--literal'], ['retrieve', 'alpha'], ['duties', '--all'],
    ['topics'], ['today'], ['experiences', '--all'], ['browse'], ['show', 'abc'], ['digest'], ['board'], ['questions'], ['procedures'],
    ['links'], ['workflow'], ['snippet'], ['error-fixes'], ['when', 'alpha'], ['explain', 'alpha']];
  const crashed = [];
  for (const c of READ) {
    const r = cli(root, ...c);
    if (CRASH.test(`${r.stdout}${r.stderr}`)) crashed.push(c.join(' '));
  }
  assert.deepEqual(crashed, [], `these commands crash on a non-object line: ${crashed.join(', ')}`);
  const found = cli(root, 'find', 'alpha');
  assert.match(found.stdout, /alpha one/, 'the healthy entry is still found');
  const doc = cli(root, 'doctor');
  assert.doesNotMatch(`${doc.stdout}${doc.stderr}`, CRASH);
  assert.match(doc.stdout, /thoughts\.jsonl:\d+/, 'the doctor does not name the broken line');
  assert.match(doc.stdout, /drawers/);
});

test('mem status: a drawer of non-object lines only holds nothing readable, one with a real entry counts it', (t) => {
  const root = world(t, false);
  const file = path.join(root, 'global', 'thoughts.jsonl');
  fs.writeFileSync(file, `${FORMS.join('\n')}\n`);
  const step = () => setup.check(root, { env: {}, home: root }).steps.find((s) => s.id === 'content');
  const s1 = step();
  assert.ok(s1, 'no content step');
  assert.match(s1.detail, /no readable entries/, `the content step counted a non-object line: ${s1.detail}`);
  memory.logEntry(root, 'thought', { title: 'real', text: 'a real one', agent: 'lucky' });
  const s2 = step();
  assert.match(s2.detail, new RegExp(`^1 entries \\(\\+ ${FORMS.length} unreadable`), s2.detail);
});
