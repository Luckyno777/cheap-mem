/**
 * A broken shrink baseline is UNKNOWN, and a run never overwrites it.
 *
 * **The finding, audit 2026-09-30, B7.** readBaseline() answered `null`
 * for "absent" and for "does not parse" alike; run() read that as
 * FIRST_RUN and saved the current sizes over the broken file.
 * STATE.UNKNOWN existed in the list and in asText() but nothing ever
 * produced it. Measured on 241a8aa: with a truncated baseline and a
 * book shrunk from 500 to 5 bytes, run() said 'first-run' and the new
 * baseline recorded 5 — the shrink was laundered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, STATE, BASELINE_FILE, readBaseline } from '../src/shrink.mjs';

function memWith(bytes, t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'f1cm-shrink-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, 'global'), { recursive: true });
  fs.writeFileSync(path.join(d, 'global', 'errors.jsonl'), 'x'.repeat(bytes));
  return d;
}

test('a baseline that does not parse gives UNKNOWN and stays on disk as it was', (t) => {
  const d = memWith(5, t);
  const where = path.join(d, BASELINE_FILE);
  fs.mkdirSync(path.dirname(where), { recursive: true });
  const broken = '{"version":1,"books":{"global/errors.jsonl":500';
  fs.writeFileSync(where, broken);
  const f = run(d);
  assert.equal(f.state, STATE.UNKNOWN);
  assert.equal(fs.readFileSync(where, 'utf8'), broken, 'the run overwrote the broken baseline');
});

test('positive control: a missing baseline is still a first run, and a real shrink still alarms', (t) => {
  const d = memWith(500, t);
  assert.equal(run(d).state, STATE.FIRST_RUN);
  assert.equal(readBaseline(d).books['global/errors.jsonl'], 500);
  fs.writeFileSync(path.join(d, 'global', 'errors.jsonl'), 'x'.repeat(5));
  assert.equal(run(d).state, STATE.ALARM);
});
