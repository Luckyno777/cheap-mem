// The keyword lane for procedures — a SECOND lane beside the existing
// error-class lane (see test/procedure-trigger.test.mjs), not a
// replacement for it.
//
// The kernel kept from the outside proposal: literal keyword matching,
// no model call, no score. What is cut: ranking matches by a use
// count. Ordering here is authority then recency only, and that order
// must be the SAME on two runs against the same files — a per-machine
// telemetry counter cannot make that promise, which is the whole
// finding this rewrite is built on.
import test from 'node:test';
import assert from 'node:assert/strict';
// Imported explicitly rather than used as a global: a global it has been in
// node for years, but this repo's eslint environment does not declare it — and
// a lint error in CI is a red run like any other.
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as memory from '../src/memory.mjs';
import * as procedure from '../src/procedure.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-kw-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
const run = (r, ...a) => spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8' });
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

const logProcedure = (r, title, rule, triggers, extra = []) => run(r, 'log', 'procedure',
  '--title', title, '--rule', rule, '--issued-by', 'owner', '--triggers', triggers, ...extra);

test('a matching keyword offers the procedure', () => {
  const r = world();
  try {
    logProcedure(r, 'Ask before prod', 'Always ask first.', 'prod,production,deploy');
    const out = run(r, 'procedures', '--match', 'we should deploy tonight').stdout;
    assert.match(out, /1 procedure\(s\) triggered/);
    assert.match(out, /Ask before prod/);
  } finally { away(r); }
});

test('COUNTER-PROBE: a non-matching keyword offers nothing', () => {
  const r = world();
  try {
    logProcedure(r, 'Ask before prod', 'Always ask first.', 'prod,production,deploy');
    const out = run(r, 'procedures', '--match', 'completely unrelated text').stdout;
    assert.match(out, /No procedure triggers/);
  } finally { away(r); }
});

test('two matching procedures are ordered by authority, then recency', () => {
  const r = world();
  try {
    // Written in an order that would be WRONG if age alone decided:
    // the older one has lower authority, so it must rank second.
    logProcedure(r, 'Older, lower authority', 'Rule A.', 'widget', ['--authority', 'agent']);
    logProcedure(r, 'Newer, higher authority', 'Rule B.', 'widget', ['--authority', 'user']);
    const out = run(r, 'procedures', '--match', 'the widget broke again').stdout;
    const posA = out.indexOf('Older, lower authority');
    const posB = out.indexOf('Newer, higher authority');
    assert.ok(posA > -1 && posB > -1, 'both procedures must appear');
    assert.ok(posB < posA, 'the higher-authority procedure must be listed first');
  } finally { away(r); }
});

test('the order is identical on two independent runs from the same files', () => {
  const r = world();
  try {
    logProcedure(r, 'Rule A', 'text A', 'widget', ['--authority', 'agent']);
    logProcedure(r, 'Rule B', 'text B', 'widget', ['--authority', 'agent']);
    logProcedure(r, 'Rule C', 'text C', 'widget', ['--authority', 'user']);
    const first = run(r, 'procedures', '--match', 'widget issue').stdout;
    const second = run(r, 'procedures', '--match', 'widget issue').stdout;
    assert.equal(second, first, 'two runs over the same files must produce the same order');

    // Same claim, checked at the library level directly against the
    // parsed entries (not just "the CLI printed the same text twice"),
    // and in the REVERSE file-read order — the determinism this proves
    // is about the DATA, not about iteration order happening to agree.
    const { entries } = memory.readLog(r, procedure.TYPE, { project: null });
    const forward = procedure.forKeywords(r, 'widget issue', {});
    const reversed = procedure.orderByAuthorityThenRecency(
      [...forward].reverse().filter((e) => procedure.matchesKeywords(e, 'widget issue')));
    assert.deepEqual(reversed.map((e) => e.id), forward.map((e) => e.id),
      'sorting must not depend on the input order — same set, same result');
    assert.ok(entries.length >= 3, 'fixture too small to have measured anything');
  } finally { away(r); }
});

test('keywordTriggersOf reads a JSON array field the same as a comma string', () => {
  assert.deepEqual(procedure.keywordTriggersOf({ triggers: ['A', ' b ', 'a'] }), ['a', 'b']);
  assert.deepEqual(procedure.keywordTriggersOf({ triggers: 'A, b ,a' }), ['a', 'b']);
});

test('matchesKeywords is a literal, case-insensitive substring check', () => {
  const e = { triggers: 'Rollback' };
  assert.equal(procedure.matchesKeywords(e, 'time to ROLLBACK now'), true);
  assert.equal(procedure.matchesKeywords(e, 'roll back now'), false); // not literal
});

/**
 * Cost, measured with a real number of procedures — not asserted from
 * memory. 500 procedures, each carrying three triggers, one match
 * against all of them: read + filter + sort.
 */
test('MEASURED: forKeywords over 500 procedures', () => {
  const r = world();
  try {
    // Written directly with memory.logEntry (not through 500 CLI
    // process spawns) — this measures forKeywords itself, not
    // Node's process-startup cost 500 times over.
    for (let i = 0; i < 500; i += 1) {
      memory.logEntry(r, procedure.TYPE, {
        title: `rule-${i}`, rule: `text ${i}`, issued_by: 'owner',
        triggers: `kw${i},shared,another${i}`,
      });
    }
    const t0 = performance.now();
    const hits = procedure.forKeywords(r, 'this mentions shared plainly', {});
    const ms = performance.now() - t0;
    assert.equal(hits.length, 500, 'the shared keyword must hit every procedure');
    // Not a hard pass/fail gate — a real number, printed, is the point.
    console.log(`    forKeywords over 500 procedures: ${ms.toFixed(2)} ms`);
    assert.ok(ms < 2000, `500 procedures took ${ms.toFixed(2)} ms — investigate before it grows`);
  } finally { away(r); }
});
