// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// startblock-cm - the session start asks the memory ONCE for the alarm and the day line (`mem today --start`), and what
// it prints is byte for byte what the two commands it replaces printed.
//
// Three things are held here:
//   (1) GOLDEN: on several worlds (empty, a scale corpus, duties with due dates, a red finding, no config) the text of
//       `today --start` equals the hook's old composition of `doctor --alarm` and `today --line` (still in the CLI, so the
//       reference cannot rot). Each world is built twice, one copy per way, so neither run sees what the other changed.
//   (2) THE TWO DERIVED FINDINGS: `doctor.dayResultFrom` takes the environment findings and `rollback` the way a second
//       `mem today` process saw them (probe on, mark already ticked) - everything else is the alarm run's reading.
//   (3) RATCHET: the start block reads the entry logs at most N times. Measured 2026-10-18 on the synthetic corpus: the old
//       pair read 2.01 + 1.09 = 3.10 passes warm, `today --start` 1.01. The bound is 1.25; a mutant that takes the shared
//       drawer memo away reads 4.09 (bench/mutation.mjs, "startblock-cm").
// Windows: no /tmp, no POSIX tools; the hook run (bash) is its own test and says so where bash is not there.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as doctor from '../src/doctor.mjs';
import * as startblock from '../src/startblock.mjs';
import { buildCorpus } from '../bench/atlas/core.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const COUNTER = pathToFileURL(path.join(REPO, 'bench', 'atlas', 'io-counter.mjs')).href;
const RECORD = path.join('.pipeline', 'append-atomicity.json');

/** `mem --root <root> <args>`; stdout, with the root's own path hidden (it can show in a message). */
function mem(root, args, extra = {}) {
  const r = spawnSync(process.execPath, [MEM, '--root', root, ...args], {
    encoding: 'utf8', env: { ...process.env, CHEAP_MEM_GOLD_FILE: path.join(root, 'no-gold.jsonl'), ...extra },
  });
  return { status: r.status, stdout: r.stdout.split(root).join('<ROOT>'), stderr: r.stderr };
}
const init = (root) => { const r = mem(root, ['init']); assert.equal(r.status, 0, r.stderr); };

/** What the hook printed from the two commands: the alarm block, a blank line, the day line - `$(...)` strips the ends. */
function legacyText(root) {
  const alarm = mem(root, ['doctor', '--alarm']).stdout.replace(/\n+$/, '');
  const line = mem(root, ['today', '--line']).stdout.replace(/\n+$/, '');
  const parts = [];
  if (alarm) parts.push(`${startblock.ALARM_HEADING}\n${alarm}`);
  if (line) parts.push(line);
  return parts.join('\n\n');
}
const startText = (root) => mem(root, ['today', '--start']).stdout.replace(/\n+$/, '');

const tornRecord = (root) => {
  const dev = String(fs.statSync(root).dev);
  const p = path.join(root, RECORD);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    v: 1, ok: false, measuredAt: '2026-10-01T08:30:00.000Z', dev, fsType: null, node: process.version,
    workers: 6, perWorker: 8, torn: 3, missing: 2, duplicates: 0,
  })}\n`);
};

const WORLDS = {
  empty: (root) => init(root),
  scale: (root) => { init(root); buildCorpus(root, 400, { anchors: 1, seed: 42 }); },
  duties: (root) => {
    init(root);
    for (const due of ['2026-01-02T09:00:00Z', '2099-01-01T09:00:00Z']) {
      const r = mem(root, ['log', 'duty', '--title', `answer the question ${due}`, '--owner', 'human', '--due', due]);
      assert.equal(r.status, 0, r.stderr);
    }
  },
  'red finding': (root) => {
    init(root);
    tornRecord(root);
    const r = mem(root, ['log', 'duty', '--title', 'a late one', '--owner', 'human', '--due', '2026-01-02T09:00:00Z']);
    assert.equal(r.status, 0, r.stderr);
  },
  'no config': (root) => { fs.mkdirSync(path.join(root, '.mem'), { recursive: true }); },
};

for (const [name, build] of Object.entries(WORLDS)) {
  test(`golden: today --start prints what doctor --alarm + today --line printed (${name})`, (t) => {
    const a = tempDir('cm-startblock-a-', t);
    const b = tempDir('cm-startblock-b-', t);
    build(a); build(b);
    const was = legacyText(a);
    const now = startText(b);
    assert.equal(now, was);
    if (name === 'red finding') assert.match(now, /^=== DOWN RIGHT NOW \(mem doctor --alarm\) ===\nFAIL {2}env\/append-atomicity/, 'the world must really be red');
    if (name === 'no config') assert.match(now, /FAIL {2}config/, 'no config: the alarm part still answers');
    if (name === 'duties') assert.match(now, /^Today: /, 'the day line is there');
  });
}

test('the world check bites: a red world differs from a calm one, so equal texts are not equal for lack of content', (t) => {
  const red = tempDir('cm-startblock-r-', t);
  const calm = tempDir('cm-startblock-c-', t);
  WORLDS['red finding'](red); WORLDS.empty(calm);
  assert.notEqual(startText(red), startText(calm));
});

test('doctor.dayResultFrom: environment and rollback read the way a second process saw them', (t) => {
  const root = tempDir('cm-startblock-d-', t);
  init(root);
  // A mark from before a rules change: the alarm run sees the warning, ticks the mark, and the next reader sees none.
  const rec = mem(root, ['epoch', 'record']);
  assert.equal(rec.status, 0, rec.stderr);
  const markPath = path.join(root, '.mem', 'epoch.json');
  const mark = JSON.parse(fs.readFileSync(markPath, 'utf8'));
  mark.semantics = 0;
  fs.writeFileSync(markPath, JSON.stringify(mark));

  const find = (res, name) => res.findings.find((f) => f.name === name);
  const result = doctor.withRunMemo(() => {
    const r = doctor.checkAll(root, { full: false, record: true });
    doctor.tickEpoch(root, r);
    return { alarm: r, day: doctor.dayResultFrom(root, r) };
  });
  assert.equal(find(result.alarm, 'rollback').level, doctor.LEVEL.WARN, 'the alarm run saw the old mark');
  assert.equal(find(result.day, 'rollback').level, doctor.LEVEL.GOOD, 'a later reader sees the ticked mark');

  // The rest: the same names in the same places and levels as a second, complete run (probe on) after the tick.
  const second = doctor.checkAll(root);
  const shape = (res) => res.findings.map((f) => `${f.name}=${f.level}`);
  assert.deepEqual(shape(result.day), shape(second));
  assert.equal(result.day.worst, second.worst);
  assert.deepEqual(result.day.summary, second.summary);
  assert.equal(find(result.alarm, 'env/append-atomicity').level, doctor.LEVEL.UNKNOWN, 'control: the alarm run never measured the probe');
});

// --- the ratchet ---------------------------------------------------------------------------------------------------------

/** Passes over the entry logs one `mem` call makes (bytes read of `global/` and `projects/` over their size). */
function passes(root, args, bytes, t) {
  const out = path.join(tempDir('cm-startblock-io-', t), 'io.jsonl');
  const r = spawnSync(process.execPath, [MEM, '--root', root, ...args], {
    encoding: 'utf8', env: { ...process.env, CHEAP_MEM_GOLD_FILE: path.join(root, 'no-gold.jsonl'),
      NODE_OPTIONS: `--import=${COUNTER}?root=${encodeURIComponent(root)}&out=${encodeURIComponent(out)}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const mine = rows.find((x) => x.corpusFiles > 0) ?? rows[rows.length - 1];
  return mine.corpusBytesRead / bytes;
}
const logBytes = (root) => {
  let sum = 0;
  for (const dir of ['global', 'projects']) {
    const walk = (d) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.jsonl')) sum += fs.statSync(p).size;
    } };
    walk(path.join(root, dir));
  }
  return sum;
};

const MAX_PASSES_WARM = 1.25; // measured 1.01 (5 000 entries); the old pair read 3.10
const MAX_PASSES_COLD = 3.3;  // measured 2.92: the first call also builds the search index (1.9 passes), once

test('ratchet: the start block reads the entry logs at most 1.25 times (warm), 3.3 (cold); the old pair does not stay under it', (t) => {
  const root = tempDir('cm-startblock-p-', t);
  init(root);
  buildCorpus(root, 1500, { anchors: 1, seed: 42 });
  const bytes = logBytes(root);
  assert.ok(bytes > 100000, 'the corpus is there');
  const cold = passes(root, ['today', '--start'], bytes, t);
  const warm = passes(root, ['today', '--start'], bytes, t);
  assert.ok(warm <= MAX_PASSES_WARM, `today --start read the logs ${warm.toFixed(2)} times (bound ${MAX_PASSES_WARM})`);
  assert.ok(cold <= MAX_PASSES_COLD, `the first call read the logs ${cold.toFixed(2)} times (bound ${MAX_PASSES_COLD})`);
  // Control: the counter and the bound do bite - the pair the hook used to run is over it.
  const pair = passes(root, ['doctor', '--alarm'], bytes, t) + passes(root, ['today', '--line'], bytes, t);
  assert.ok(pair > MAX_PASSES_WARM * 2, `control: the old pair read only ${pair.toFixed(2)} times - the counter lost its teeth`);
});

test('startBlock is a plain function of the root: text = alarm block + blank line + day line', (t) => {
  const root = tempDir('cm-startblock-f-', t);
  WORLDS['red finding'](root);
  const b = startblock.startBlock(root, { env: { ...process.env, CHEAP_MEM_GOLD_FILE: path.join(root, 'no-gold.jsonl') } });
  assert.ok(b.alarm.length > 0 && b.line, 'both parts');
  assert.equal(b.text, `${startblock.ALARM_HEADING}\n${b.alarm.join('\n')}\n\n${b.line}`);
  assert.equal(os.EOL.length > 0, true);
});
