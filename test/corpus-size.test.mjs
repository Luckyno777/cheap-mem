// The sharding warning (external audit, 2026-09-19): docs/scale.md has
// said "split at ~50,000" since 2026-09-05, but nothing ever counted
// against it. `checkCorpusSize` does — with the audit's own measured
// consequence (400k entries: 1237 MB heap, 746 ms search) in the text,
// not an estimate, and the count named even when it is nowhere near
// the line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as doctor from '../src/doctor.mjs';
import * as memory from '../src/memory.mjs';
import * as cfg from '../src/config.mjs';

function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-corpus-'));
  cfg.writeConfig(r, cfg.DEFAULT_CONFIG);
  return r;
}

test('under the line: GOOD, and the count is still named', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'decision', { topic: 't', choice: 'x' });
  memory.logEntry(root, 'error', { class: 'c', title: 't' });
  const f = doctor.checkCorpusSize(root);
  assert.equal(f.level, doctor.LEVEL.GOOD);
  // The number appears even in the GOOD case — "watched growing towards
  // a line" is the whole point, not just "silent until it is a problem".
  assert.match(f.text, /\b2\b.*entries/);
  assert.match(f.text, new RegExp(String(doctor.CORPUS_WARN_THRESHOLD)));
});

test('POSITIVE CONTROL: over a (lowered, for the test) line: WARN with the MEASURED consequence', () => {
  const root = tmpRoot();
  const c = cfg.readConfig(root);
  cfg.writeConfig(root, { ...c, corpusWarnThreshold: 2 });
  memory.logEntry(root, 'decision', { topic: 't', choice: 'x' });
  memory.logEntry(root, 'decision', { topic: 't2', choice: 'y' });
  memory.logEntry(root, 'error', { class: 'c', title: 't' });

  const f = doctor.checkCorpusSize(root);
  assert.equal(f.level, doctor.LEVEL.WARN, 'over the line must warn, not silently pass');
  assert.notEqual(f.level, doctor.LEVEL.ERROR, 'a large corpus is not broken — WARN, never ERROR');
  // The measured numbers from the audit, verbatim — not a projection off
  // docs/scale.md's own 20k-200k table.
  assert.match(f.text, /400,000/);
  assert.match(f.text, /1237 MB/);
  assert.match(f.text, /746 ms/);
  assert.ok(f.advice, 'a WARN without a next step just makes people feel bad');
  assert.match(f.advice, /docs\/scale\.md/);
});

test('the threshold is configurable via .mem/config.json "corpusWarnThreshold"', () => {
  const root = tmpRoot();
  const c = cfg.readConfig(root);
  // Raise it so what would ordinarily warn does not.
  cfg.writeConfig(root, { ...c, corpusWarnThreshold: 100000 });
  for (let i = 0; i < 5; i += 1) memory.logEntry(root, 'event', { title: `e${i}` });
  const f = doctor.checkCorpusSize(root);
  assert.equal(f.level, doctor.LEVEL.GOOD);
  assert.match(f.text, /100000/);
});

test('checkCorpusSize is wired into checkAll()', () => {
  const root = tmpRoot();
  const result = doctor.checkAll(root);
  assert.ok(result.findings.some((x) => x.name === 'corpus-size'),
    'corpus-size is not part of mem doctor at all');
});

// Note: `integrity.scanIntegrity` is deliberately defensive all the way
// down (missing files, unreadable lines, missing projects/ — every one
// of them is caught locally and turned into a count of zero or a
// per-line "broken" entry, never a thrown error), and this test suite
// runs as root, where a permission-denied simulation is not even
// possible. So `checkCorpusSize`'s own UNKNOWN branch is a defensive
// backstop for a failure mode that could not be reproduced here rather
// than a path this suite can drive — same shape as the try/catch around
// `cfgmod.readConfig` two lines above it.
