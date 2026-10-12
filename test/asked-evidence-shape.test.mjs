// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Second review of the shape rule (2026-10-12): `asked_evidence` as a number or an object crashed `mem asked-learn` ("not
// iterable", src/askedlearn.mjs#learnedWords and src/missgold.mjs#learnedPlaces). It is a strict list field now - a list of
// records, anything else makes the line BROKEN - and both readers iterate only a real list, so a document that reached them
// anyway (a cache, an import) cannot end the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as askedlearn from '../src/askedlearn.mjs';
import { shapeProblem } from '../src/fieldshape.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const CRASH = /not iterable|TypeError|Cannot read prop|is not a function/;
const cli = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a],
  { encoding: 'utf8', input: '', timeout: 90000, env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_ROOT: root } });
const BAD = [5, true, 'text', { words: 'x' }, ['a'], [null], [[1]]];

test('the shape rule: asked_evidence is a list of records, nothing else', () => {
  for (const v of BAD) assert.ok(shapeProblem({ asked_evidence: v }), `${JSON.stringify(v)} must be broken`);
  assert.equal(shapeProblem({ asked_evidence: [] }), null);
  assert.equal(shapeProblem({ asked_evidence: [{ journal: 'j:1', ts: '2026-10-01T00:00:00Z', words: 'a b', learned: 'miss' }] }), null);
  assert.equal(shapeProblem({ title: 'no evidence' }), null);
});

test('mem asked-learn and mem gold do not crash on a line with a wrong asked_evidence', (t) => {
  const root = tempDir('cm-evidence-', t);
  assert.equal(cli(root, 'init', '--participants', 'lucky,session', '--human', 'lucky').status, 0);
  memory.logEntry(root, 'thought', { title: 'alpha one', text: 'alpha healthy words', agent: 'lucky' });
  let i = 0;
  for (const v of BAD) {
    i += 1;
    fs.appendFileSync(path.join(root, 'global', 'thoughts.jsonl'),
      `${JSON.stringify({ id: `9evid${String(i).padStart(3, '0')}`, ts: '2026-10-11T22:30:00Z', v: 1, agent: 'x', authority: 'agent', title: `alpha evidence ${i}`, text: 'alpha words', asked_evidence: v })}\n`);
  }
  for (const c of [['asked-learn'], ['asked-learn', '--json'], ['asked-learn', '--shown'], ['search-levers'], ['gold', 'miss'], ['find', 'alpha'], ['doctor']]) {
    const r = cli(root, ...c);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, CRASH, `${c.join(' ')} crashed: ${r.stderr}`);
  }
  assert.match(cli(root, 'find', 'alpha').stdout, /alpha one/, 'the healthy entry is found');
});

test('the readers iterate only a real list (a document that got past the shape rule)', () => {
  const doc = (ev) => ({ retired: false, entry: { id: 'x1', asked_evidence: ev } });
  for (const v of [5, true, 'text', { words: 'x' }]) {
    assert.doesNotThrow(() => askedlearn.learnedWords({ documents: [doc(v)] }), `learnedWords threw on ${JSON.stringify(v)}`);
  }
  // positive control: a real list is read
  const m = askedlearn.learnedWords({ documents: [doc([{ words: 'alpha beta' }])] });
  assert.deepEqual([...m.keys()].sort(), ['alpha', 'beta']);
});
