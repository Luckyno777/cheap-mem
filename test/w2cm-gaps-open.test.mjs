// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Open knowledge gaps and the weekly rate (parity with the sibling's R1,
// 2b19ffd6). Red on the old stand (8a24c64): gap.gaps / gap.ratePerWeek /
// `mem gaps` do not exist there; the existing sweep() treats EVERY
// unclosed miss as open, which is exactly the noise this refines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as gap from '../src/gap.mjs';
import * as injection from '../src/injection.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gaps-open-'));
const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const CAP = 'raw/2026/09/2026-09-29T100000Z--s1.jsonl.gz';
const QUESTION = 'how do I configure the frobnicator widget';
const messages = [{ path: CAP, line: 1, ts: '2026-09-29T10:00:02Z', text: QUESTION }];

function miss(root, ts = '2026-09-29T10:00:00Z') {
  assert.equal(injection.book(root, { ts, session: 's1', occasion: injection.OCCASION.QUESTION, reason: 'empty', hits: 0 }), true);
}
const assistant = (ts, text) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });
const reader = (lines) => () => ({ header: null, lines });

test('a miss the session then worked out is an OPEN gap with evidence; question text and stems never leave', () => {
  const root = tmp();
  try {
    miss(root);
    const read = reader([
      { type: 'user', timestamp: '2026-09-29T10:00:02Z', message: { content: QUESTION } },
      assistant('2026-09-29T10:05:00Z', 'The frobnicator widget is configured through its settings panel.'),
    ]);
    const g = gap.gaps(root, { entries: new Map(), messages, read });
    assert.equal(g.open.length, 1);
    assert.deepEqual(g.open[0].evidence, ['worked-out']);
    assert.ok(!JSON.stringify(g).includes('frobnicator'), 'privacy: no question text or stem in the result');
    assert.equal(g.noise, 0);
  } finally { away(root); }
});

test('a miss followed by an unproven answer is open; a miss with no follow-up is noise, not a gap (positive control)', () => {
  const root = tmp();
  try {
    miss(root);
    const unproven = reader([assistant('2026-09-29T10:05:00Z', 'This is TBD, nothing recorded about it.')]);
    let g = gap.gaps(root, { entries: new Map(), messages, read: unproven });
    assert.deepEqual(g.open.map((x) => x.evidence), [['marked-unproven']]);
    const nothing = reader([assistant('2026-09-29T10:05:00Z', 'Unrelated weekend plans.')]);
    g = gap.gaps(root, { entries: new Map(), messages, read: nothing });
    assert.equal(g.open.length, 0);
    assert.equal(g.noise, 1);
  } finally { away(root); }
});

test('the question message itself is not its own evidence; an unreadable capture is unknown, not noise', () => {
  const root = tmp();
  try {
    miss(root);
    const onlyQuestion = reader([{ type: 'user', timestamp: '2026-09-29T10:00:03Z', message: { content: QUESTION } }]);
    let g = gap.gaps(root, { entries: new Map(), messages, read: onlyQuestion });
    assert.equal(g.open.length, 0);
    assert.equal(g.noise, 1);
    g = gap.gaps(root, { entries: new Map(), messages, read: () => { throw new Error('archive not mounted'); } });
    assert.equal(g.unknown, 1);
    assert.equal(g.noise, 0);
  } finally { away(root); }
});

test('a later entry with the same stems closes the gap with its id', () => {
  const root = tmp();
  try {
    miss(root);
    const entries = new Map([['e1', { id: 'e1', ts: '2026-09-29T11:00:00Z', title: 'frobnicator widget configuration guide' }]]);
    const g = gap.gaps(root, { entries, messages, read: reader([]) });
    assert.equal(g.closed.length, 1);
    assert.equal(g.closed[0].entryId, 'e1');
    assert.equal(g.open.length, 0);
  } finally { away(root); }
});

test('ratePerWeek: open/closed per ISO week, null for a week without any gap, ISO year edge', () => {
  assert.equal(gap.weekKey('2026-09-29T10:00:00Z'), '2026-W40');
  assert.equal(gap.weekKey('2026-01-01T00:00:00Z'), '2026-W01');
  assert.equal(gap.weekKey('2027-01-01T00:00:00Z'), '2026-W53');
  assert.equal(gap.weekKey('not a date'), null);
  const w = gap.ratePerWeek({
    open: [{ ts: '2026-09-29T10:00:00Z' }, { ts: '2026-09-30T10:00:00Z' }, { ts: 'garbage' }],
    closed: [{ ts: '2026-09-29T11:00:00Z' }, { ts: '2026-10-07T11:00:00Z' }],
  });
  assert.deepEqual(w, [
    { week: '2026-W40', open: 2, closed: 1, rate: 2 / 3 },
    { week: '2026-W41', open: 0, closed: 1, rate: 0 },
  ]);
  assert.deepEqual(gap.ratePerWeek({}), []);
});

test('CLI: mem gaps and mem gaps rate say "not measurable" without a journal, never 0', () => {
  const root = tmp();
  try {
    assert.equal(spawnSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8' }).status, 0);
    let r = spawnSync('node', [MEM, '--root', root, 'gaps'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not measurable/);
    r = spawnSync('node', [MEM, '--root', root, 'gaps', 'rate', '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(r.stdout).readable, false);
    r = spawnSync('node', [MEM, '--root', root, 'gaps', '--help'], { encoding: 'utf8' });
    assert.match(r.stdout, /mem gaps rate/);
  } finally { away(root); }
});
