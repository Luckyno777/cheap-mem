// G1b (A): a correction must not appear, under `--as-of`, before it existed.
//
// **The finding (G1 diagnosis, 2026-09-30).** `validAt` read an entry's
// start of validity from `valid_from` alone; an entry without it held
// "since the beginning of time". For an ordinary entry that is right —
// nobody said when it started, and a note written today about last year
// must stay visible for last year (as-of-every-lane.test.mjs). For a
// CORRECTION it is wrong: the predecessor's end is derived from the
// successor's `valid_from ?? ts` (memory.retiredMap -> supersededAt), so
// the same moment was read by two different rules. Result: as of a date
// before the correction was written, BOTH the old claim and its
// correction came back — the correction had overtaken itself.
//
// One moment, one rule: a correction with no `valid_from` starts at its
// own `ts`, exactly the moment the predecessor stops. Entries without a
// correction edge keep the open start (positive control below).
//
// The probes run every door: `find` (ranked), `find --literal`, and the
// gateway `retrieve` — which goes through `toClaim`, so `toClaim` must
// carry `replaces_id` or the rule silently does not apply there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validAt } from '../src/retrieval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');

function mem(root, ...argv) {
  try {
    return { code: 0, out: execFileSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const PAST = '2020-01-01'; // before anything in the fixture was written

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-g1b-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const old = mem(r, 'log', 'decision', '--topic', 'queue', '--choice', 'redis queue zebracorn',
    '--why', 'fast enough').out;
  const id = /id: (\S+)/.exec(old)?.[1];
  assert.ok(id, `fixture broken: no id in\n${old}`);
  mem(r, 'correction', 'decision', id, '--choice', 'postgres queue zebracorn', '--why', 'one store less');
  // Control: no correction edge, no valid_from — open start.
  mem(r, 'log', 'decision', '--topic', 'cache', '--choice', 'local cache zebracorn', '--why', 'simple');
  return r;
}

test('UNIT: a correction without valid_from starts at its own ts', () => {
  const corr = { id: 'b', replaces_id: 'a', ts: '2026-05-01T00:00:00Z' };
  assert.equal(validAt(corr, '2026-04-30'), false, 'correction held before it was written');
  assert.equal(validAt(corr, '2026-05-02'), true);
  // Stated valid_from still wins over ts.
  assert.equal(validAt({ ...corr, valid_from: '2026-01-01' }, '2026-02-01'), true);
  // Positive control: no correction edge, no valid_from -> open start.
  assert.equal(validAt({ id: 'c', ts: '2026-05-01T00:00:00Z' }, '2020-01-01'), true);
});

test('EVERY DOOR: as of a date before the correction, only the old claim holds', () => {
  const r = build();
  try {
    // The fixture is alive: all three are findable now.
    const now = mem(r, 'find', 'zebracorn', '--top', '10').out;
    for (const w of ['postgres queue', 'local cache']) assert.ok(now.includes(w), `fixture broken: '${w}' missing\n${now}`);

    const ranked = mem(r, 'find', 'zebracorn', '--as-of', PAST, '--top', '10').out;
    const literal = mem(r, 'find', 'zebracorn', '--literal', '--as-of', PAST).out;
    const gateway = mem(r, 'retrieve', 'zebracorn', '--as-of', PAST, '--json').out;
    for (const [door, out] of [['find', ranked], ['find --literal', literal], ['retrieve', gateway]]) {
      assert.ok(!out.includes('postgres queue'),
        `${door}: the correction came back as of ${PAST}, before it existed\n${out}`);
      assert.ok(out.includes('redis queue'), `${door}: the old claim did not hold as of ${PAST}\n${out}`);
      assert.ok(out.includes('local cache'),
        `${door}: an entry without correction edge lost its open start — the rule is too broad\n${out}`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
