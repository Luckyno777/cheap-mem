// Content-hash deduplication (`mem maintenance dedupe`).
//
// The kernel this keeps from the outside proposal: entries whose
// CONTENT is provably identical merge, the highest-authority one stays
// active. What was cut: ranking or hiding by a telemetry "use count",
// which breaks "identical data, identical prompt" (a per-machine ledger
// answers differently on two machines; a committed one turns every read
// into a write). Nothing here reads or writes any such counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dedupe-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
const run = (r, ...a) => spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8' });
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

const logPath = (r, type) => memory.logPath(r, type, null);
const readRaw = (r, type) => fs.readFileSync(logPath(r, type), 'utf8');

test('identical entries merge: the highest-authority one stays, the loser is retired', () => {
  const r = world();
  try {
    // Same exact learning, written twice by two different authorities.
    run(r, 'log', 'learning', '--topic', 't', '--title', 'watch the fd leak',
      '--text', 'close the handle in finally', '--authority', 'agent');
    run(r, 'log', 'learning', '--topic', 't', '--title', 'watch the fd leak',
      '--text', 'close the handle in finally', '--authority', 'user');

    const before = readRaw(r, 'learning');
    const out = run(r, 'maintenance', 'dedupe').stdout;
    assert.match(out, /1 entry.*superseded/s);

    const { entries } = memory.readLog(r, 'learning', { project: null });
    const retired = memory.retiredMap(entries);
    const active = entries.filter((e) => e.id && memory.holds(e, retired));
    assert.equal(active.length, 1, 'exactly one of the two duplicates must remain active');
    assert.equal(active[0].authority, 'user', 'the higher-authority entry must be the survivor');

    // Append-only: every original byte is still there, in order.
    const after = readRaw(r, 'learning');
    assert.ok(after.startsWith(before), 'existing lines were not appended-to unchanged');
    const appended = after.slice(before.length);
    assert.match(appended, /"retires_id"/, 'the merge must be a tombstone line, not an edit');
  } finally { away(r); }
});

test('near-identical entries do NOT merge', () => {
  const r = world();
  try {
    run(r, 'log', 'learning', '--topic', 't', '--title', 'watch the fd leak',
      '--text', 'close the handle in finally');
    run(r, 'log', 'learning', '--topic', 't', '--title', 'watch the fd leak',
      '--text', 'close the handle in a finally block'); // different wording, different hash

    const out = run(r, 'maintenance', 'dedupe').stdout;
    assert.match(out, /No exact duplicates found/);

    const { entries } = memory.readLog(r, 'learning', { project: null });
    const retired = memory.retiredMap(entries);
    const active = entries.filter((e) => e.id && memory.holds(e, retired));
    assert.equal(active.length, 2, 'near-duplicates must both stay active');
  } finally { away(r); }
});

test('running it twice changes nothing the second time (idempotent)', () => {
  const r = world();
  try {
    run(r, 'log', 'learning', '--topic', 't', '--title', 'x', '--text', 'y');
    run(r, 'log', 'learning', '--topic', 't', '--title', 'x', '--text', 'y');
    run(r, 'maintenance', 'dedupe');
    const afterFirst = readRaw(r, 'learning');
    const secondOut = run(r, 'maintenance', 'dedupe').stdout;
    assert.match(secondOut, /No exact duplicates found/);
    const afterSecond = readRaw(r, 'learning');
    assert.equal(afterSecond, afterFirst, 'a second run must append nothing at all');
  } finally { away(r); }
});

test('--dry-run reports the plan and writes nothing', () => {
  const r = world();
  try {
    run(r, 'log', 'learning', '--topic', 't', '--title', 'x', '--text', 'y');
    run(r, 'log', 'learning', '--topic', 't', '--title', 'x', '--text', 'y');
    const before = readRaw(r, 'learning');
    const out = run(r, 'maintenance', 'dedupe', '--dry-run').stdout;
    assert.match(out, /would merge/);
    const after = readRaw(r, 'learning');
    assert.equal(after, before, '--dry-run must not write anything');
  } finally { away(r); }
});

test('file sources with byte-identical content merge on the store hash, not the excerpt', () => {
  const r = world();
  try {
    const f1 = path.join(r, 'a.txt');
    const f2 = path.join(r, 'b.txt'); // different filename, same bytes
    fs.writeFileSync(f1, 'the exact same file content\n');
    fs.writeFileSync(f2, 'the exact same file content\n');
    run(r, 'sources', 'add', f1, '--title', 'copy one');
    run(r, 'sources', 'add', f2, '--title', 'copy two');

    const out = run(r, 'maintenance', 'dedupe').stdout;
    assert.match(out, /1 entry.*superseded/s);

    const { entries } = memory.readLog(r, 'source', { project: null });
    const retired = memory.retiredMap(entries);
    const active = entries.filter((e) => e.id && memory.holds(e, retired));
    assert.equal(active.length, 1, 'two files with identical bytes must merge to one active source');
  } finally { away(r); }
});

test('file sources with the SAME excerpt but DIFFERENT bytes do not merge', () => {
  // The excerpt is capped (source.MAX_EXCERPT) and redacted, so two
  // different files can legitimately share one. If dedupe compared
  // excerpts instead of the store's own sha256 for file sources, this
  // pair would wrongly merge. It must not.
  const r = world();
  try {
    // Longer than source.MAX_EXCERPT (4000 chars) so the excerpt is only
    // the shared head; the tail differs past the cap and never enters it.
    const head = 'shared opening text repeated so it clears the excerpt cap. '.repeat(80);
    fs.writeFileSync(path.join(r, 'a.txt'), `${head}\nTAIL-A\n`);
    fs.writeFileSync(path.join(r, 'b.txt'), `${head}\nTAIL-B\n`);
    run(r, 'sources', 'add', path.join(r, 'a.txt'));
    run(r, 'sources', 'add', path.join(r, 'b.txt'));

    const out = run(r, 'maintenance', 'dedupe').stdout;
    assert.match(out, /No exact duplicates found/);

    const { entries } = memory.readLog(r, 'source', { project: null });
    const retired = memory.retiredMap(entries);
    const active = entries.filter((e) => e.id && memory.holds(e, retired));
    assert.equal(active.length, 2, 'different files must stay two entries even with equal excerpts');
  } finally { away(r); }
});
