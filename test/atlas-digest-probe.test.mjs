// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-digest-probe.test.mjs — the `digest` atlas phase (atlas-neue-phasen-cm): one tick of
// bin/mem-digest, counted with a stand-in for the model.
//
// What it proves. The phase returns its five records (idle, due-once, cap, drain, starts), each
// with the four fields; on this tree they all read `pass`; and the controls that keep the phase
// honest hold:
//   - the stand-in IS what is counted: a due tick with no stand-in file makes no counted call
//     (so "0 calls" on the idle tick is not just a broken counter);
//   - the same store is idle without the threshold and due with it (the pile exists in both);
//   - the size of a capture the store does not know counts as too large, never as zero.
// A platform without bash (or a scratch path with a space) gets five `not-measured` rows that name
// the reason: asserted, not skipped.
//
// Red proof (bench/mutation.mjs, "ATLAS-DIGEST ..."): the dueness answer ignored (the idle tick
// calls the model: `idle` red), a run that digested nothing exiting 0 (`due-once` red), a selection
// that ignores the budget (`cap` red), an extra node start before the dueness answer (`starts`
// red), and a start counter that writes nothing (`starts` red). Against the base commit of this
// change the phase is a stub: one `digest.not-built` row, `not-measured`, exit code 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Atlas, VERDICT, tempRoot } from '../bench/atlas/core.mjs';
import * as phase from '../bench/atlas/phase-digest.mjs';

const VERDICTS = Object.values(VERDICT);
const IDS = ['digest.idle', 'digest.due-once', 'digest.cap', 'digest.drain', 'digest.starts'];

let cached = null;
async function runOnce() {
  if (!cached) {
    cached = (async () => {
      const atlas = new Atlas({ label: 'digest-probe' });
      await phase.run(atlas, { quick: true });
      return atlas;
    })();
  }
  return cached;
}
const records = (atlas) => atlas.phases.find((p) => p.id === 'digest').records;

test('the phase records its five rows, each with the four fields, and a blind spot for what it cannot see', async () => {
  const atlas = await runOnce();
  const rs = records(atlas);
  assert.deepEqual(rs.map((r) => r.id), IDS);
  for (const r of rs) {
    assert.ok(VERDICTS.includes(r.verdict), `${r.id}: ${r.verdict}`);
    assert.ok(r.expected && r.actual && r.evidence, `${r.id}: a field is empty`);
  }
  assert.ok(atlas.blindSpots.length >= 1);
  assert.ok(atlas.blindSpots.every((b) => b.what && b.why));
});

test('no bash, or a scratch path with a space: five not-measured rows that name why. Otherwise the five rows pass', async () => {
  const atlas = await runOnce();
  const rs = records(atlas);
  const problem = phase.platformProblem();
  if (problem) {
    assert.ok(rs.every((r) => r.verdict === VERDICT.NOT_MEASURED && r.evidence.includes(problem.slice(0, 20))), JSON.stringify(rs.map((r) => r.verdict)));
    return;
  }
  assert.deepEqual(rs.map((r) => `${r.id}:${r.verdict}`), IDS.map((id) => `${id}:pass`), rs.map((r) => `${r.id} ${r.actual}`).join('\n'));
});

test('the measured values: idle makes no call, due makes one and fails loudly, the cap holds with the oldest capture in, the backlog drains', async () => {
  if (phase.platformProblem()) return;
  const m = Object.fromEntries(records(await runOnce()).map((r) => [r.id, r.measured]));
  assert.equal(m['digest.idle'].modelCalls, 0);
  assert.equal(m['digest.idle'].pending, phase.NEW_COUNT + 1, 'the pile exists, it is only not ripe');
  assert.equal(m['digest.due-once'].modelCalls, 1);
  assert.equal(m['digest.due-once'].status, 1, 'a model that digested nothing is exit 1, not a silent 0');
  assert.equal(m['digest.due-once'].saidNothingDigested, true);
  assert.ok(m['digest.cap'].listed >= 1 && m['digest.cap'].listed < phase.NEW_COUNT + 1);
  assert.ok(m['digest.cap'].rawBytes <= phase.MAX_BYTES);
  assert.equal(m['digest.cap'].oldListed, true);
  assert.equal(m['digest.drain'].left, 0);
  assert.equal(m['digest.drain'].afterCalls, 0);
  assert.ok(m['digest.drain'].ticks >= 2 && m['digest.drain'].ticks <= m['digest.drain'].bound);
  assert.ok(m['digest.starts'].idle >= 1, 'the counter sees the idle tick run');
  assert.ok(m['digest.starts'].due >= m['digest.starts'].idle);
});

test('POSITIVE CONTROL: the counted call is the stand-in\'s — a due tick with no stand-in file makes no counted call', () => {
  if (phase.platformProblem()) return;
  const root = phase.buildStore();
  const empty = tempRoot('atlas-digest-probe-empty-');
  const t = phase.tick(root, empty, { env: { MEM_DIGEST_VOLUME_NOW_KB: '0' } });
  assert.deepEqual(t.calls, [], 'with no stand-in there is no line to count');
  assert.notEqual(t.status, 0, 'the script said the model call failed');
  assert.ok(t.starts !== null && t.starts.length >= 1, 'the start counter still ran');
});

test('listedBytes: an unknown size counts as too large, a known one as its raw size', () => {
  if (phase.platformProblem()) return;
  const root = phase.buildStore();
  assert.equal(phase.listedBytes([phase.OLD], root), phase.OLD_BYTES);
  assert.equal(phase.listedBytes([phase.OLD, phase.fresh(0)], root), phase.OLD_BYTES + phase.NEW_BYTES);
  assert.equal(phase.listedBytes(['raw/2026/01/never-recorded.jsonl.gz'], root), Infinity);
  assert.equal(phase.listedBytes([], root), 0);
});

test('ownStarts leaves out the stand-in model and keeps everything else', () => {
  const rows = [{ script: 'mem' }, { script: 'fake-model.mjs' }, { script: '' }];
  assert.deepEqual(phase.ownStarts(rows).map((r) => r.script), ['mem', '']);
  assert.deepEqual(phase.ownStarts(null), []);
});

test('the ratchets are the measured numbers, written down with their reason', () => {
  assert.deepEqual(phase.START_LIMIT, { idle: 3, due: 14 });
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'atlas', 'phase-digest.mjs'), 'utf8');
  assert.match(src, /measured 2026-10-17/);
});
