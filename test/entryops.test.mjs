// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/entryops.test.mjs — restore and merge as APPEND-ONLY operations
// (Bauplan P3, src/entryops.mjs). Every action must leave each drawer a
// byte-prefix of its earlier self: the sibling's abort criterion "the
// draft deletes and overwrites" is pinned on the bytes.
// Red proof pinned to a fixed commit (rule 12), never a moving merge-base.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as entryops from '../src/entryops.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
// Branch start of agent/p-gaps (cm-p-gaps) — before restore/merge existed.
const PRE_P_GAPS_COMMIT = 'e00c3fb176bc6735c06f4aebc14fe98810e14528';

function fresh() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-entryops-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'opstest', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const log = (r, type, data, project = null) => memory.logEntry(r, type, data, { project }).entry;
const bytesOf = (r, type, project = null) => {
  try { return fs.readFileSync(memory.logPath(r, type, project), 'utf8'); } catch { return ''; }
};
const lines = (r, type, project = null) => [...memory.iterLog(r, type, { project })];
const holdsNow = (r, type, id, project = null) => {
  const all = lines(r, type, project);
  return memory.holds(all.find((e) => e.id === id), memory.retiredMap(all));
};

test('RED PROOF (pinned commit): restore and merge did not exist before cm-p-gaps', () => {
  assert.throws(() => execFileSync('git', ['show', `${PRE_P_GAPS_COMMIT}:src/entryops.mjs`], { cwd: REPO, stdio: 'pipe' }), /Command failed/);
  const old = execFileSync('git', ['show', `${PRE_P_GAPS_COMMIT}:src/dashboard-data.mjs`], { cwd: REPO, encoding: 'utf8' });
  assert.match(old, /restore: \{\s*title: 'Restore',\s*reason: 'Not available in cheap-mem: no command lifts a tombstone/);
  assert.match(old, /merge: \{\s*title: 'Merge',\s*reason: 'Not available in cheap-mem: there is no merge command/);
});

test('restore: a closed entry comes back as a NEW line; the original and its tombstone stay byte-for-byte', () => {
  const r = fresh();
  try {
    const a = log(r, 'thought', { title: 'Keep the index warm', text: 'warm the index before the first recall' });
    memory.retireEntry(r, 'thought', a.id, { state: 'discarded', why: 'too early' });
    assert.equal(holdsNow(r, 'thought', a.id), false, 'setup: the entry is closed');
    const before = bytesOf(r, 'thought');
    const res = entryops.restore(r, a.id, { why: 'needed after all' });
    const after = bytesOf(r, 'thought');
    assert.ok(after.startsWith(before), 'append-only: the old bytes are a prefix of the new ones');
    assert.equal(after.split('\n').filter(Boolean).length, before.split('\n').filter(Boolean).length + 1, 'exactly ONE line was appended');
    const neu = lines(r, 'thought').find((e) => e.id === res.created);
    assert.equal(neu.restored_from, a.id);
    assert.equal(neu.restored_why, 'needed after all');
    assert.equal(neu.text, 'warm the index before the first recall');
    assert.equal(neu.retires_id, undefined);
    assert.equal(neu.replaces_id, undefined, 'a restore is standalone, not a correction chain');
    assert.equal(holdsNow(r, 'thought', res.created), true, 'the restored line holds');
    assert.equal(holdsNow(r, 'thought', a.id), false, 'the original stays closed: the history is kept');
    assert.equal(res.was, 'discarded');
  } finally { away(r); }
});

test('POSITIVE CONTROL: restore refuses what is not closed, superseded, doubled or empty', () => {
  const r = fresh();
  try {
    const open = log(r, 'thought', { title: 'Open', text: 'still holds' });
    assert.throws(() => entryops.restore(r, open.id), (e) => e.code === 'STILL_HOLDS');

    const old = log(r, 'thought', { title: 'Old', text: 'first version' });
    const corr = memory.correctionEntry(r, 'thought', old.id, { title: 'Old', text: 'second version' }).entry;
    assert.throws(() => entryops.restore(r, old.id), (e) => e.code === 'SUPERSEDED' && e.by === corr.id);

    const gone = log(r, 'thought', { title: 'Gone', text: 'closed once' });
    memory.retireEntry(r, 'thought', gone.id, { state: 'done' });
    const first = entryops.restore(r, gone.id);
    assert.throws(() => entryops.restore(r, gone.id), (e) => e.code === 'ALREADY_RESTORED' && e.by === first.created);

    assert.throws(() => entryops.restore(r, 'zzzzzz-nope'), (e) => e.code === 'NOT_FOUND');
    assert.throws(() => entryops.restore(r, 'a b'), (e) => e.code === 'INVALID_ID');
  } finally { away(r); }
});

test('restore: a closed entry whose restored copy was closed again can be restored again', () => {
  const r = fresh();
  try {
    const a = log(r, 'thought', { title: 'Twice', text: 'comes and goes' });
    memory.retireEntry(r, 'thought', a.id, { state: 'done' });
    const one = entryops.restore(r, a.id);
    memory.retireEntry(r, 'thought', one.created, { state: 'discarded' });
    const two = entryops.restore(r, a.id);
    assert.notEqual(two.created, one.created);
    assert.equal(holdsNow(r, 'thought', two.created), true);
  } finally { away(r); }
});

test('merge: a correction of the first entry plus obsolete tombstones; nothing is rewritten', () => {
  const r = fresh();
  try {
    const a = log(r, 'thought', { title: 'Cache idea', text: 'cache the index on disk' });
    const b = log(r, 'thought', { title: 'Cache idea again', text: 'keep the index on disk between runs' });
    const c = log(r, 'thought', { title: 'Third', text: 'reuse the index' });
    const before = bytesOf(r, 'thought');
    const res = entryops.merge(r, [a.id, b.id, c.id], { why: 'one idea, three wordings' });
    const after = bytesOf(r, 'thought');
    assert.ok(after.startsWith(before), 'append-only: the old bytes are a prefix of the new ones');
    assert.equal(after.split('\n').filter(Boolean).length, before.split('\n').filter(Boolean).length + 3, 'one correction and two tombstones');
    const all = lines(r, 'thought');
    const merged = all.find((e) => e.id === res.created);
    assert.deepEqual(merged.merged_from, [a.id, b.id, c.id]);
    assert.equal(merged.replaces_id, a.id);
    assert.equal(merged.merged_why, 'one idea, three wordings');
    for (const id of [a.id, b.id, c.id]) assert.match(merged.text, new RegExp(`\\[${id}\\]`), 'the joined text names each source');
    const retired = memory.retiredMap(all);
    assert.equal(retired.get(a.id).state, 'superseded');
    assert.equal(retired.get(b.id).state, 'obsolete');
    assert.match(retired.get(b.id).why, new RegExp(`merged into ${res.created}`));
    assert.equal(retired.get(c.id).state, 'obsolete');
    assert.equal(memory.holds(merged, retired), true, 'exactly the merged entry still holds');
    assert.equal(res.tombstones.length, 2);
  } finally { away(r); }
});

test('POSITIVE CONTROL: merge refuses too few, across drawers, closed entries — and writes nothing then', () => {
  const r = fresh();
  try {
    const a = log(r, 'thought', { title: 'A', text: 'one' });
    const b = log(r, 'thought', { title: 'B', text: 'two' });
    const other = log(r, 'learning', { title: 'L', text: 'a learning' });
    const closed = log(r, 'thought', { title: 'C', text: 'closed' });
    memory.retireEntry(r, 'thought', closed.id, { state: 'done' });
    const snapshot = () => ['thought', 'learning'].map((t) => bytesOf(r, t)).join('|');
    const before = snapshot();
    assert.throws(() => entryops.merge(r, [a.id]), (e) => e.code === 'TOO_FEW');
    assert.throws(() => entryops.merge(r, [a.id, a.id]), (e) => e.code === 'TOO_FEW', 'the same id twice is one id');
    assert.throws(() => entryops.merge(r, [a.id, other.id]), (e) => e.code === 'DIFFERENT_DRAWERS');
    assert.throws(() => entryops.merge(r, [a.id, closed.id]), (e) => e.code === 'NOT_HOLDING');
    assert.throws(() => entryops.merge(r, [a.id, 'zzzzzz-nope']), (e) => e.code === 'NOT_FOUND');
    assert.equal(snapshot(), before, 'a refused merge leaves every byte alone');
    assert.ok(entryops.merge(r, [a.id, b.id]).created, 'the same two ids DO merge when nothing is wrong (probe sees something)');
  } finally { away(r); }
});

test('merge: works inside a project drawer and keeps the project', () => {
  const r = fresh();
  try {
    memory.projectInit(r, 'alpha');
    const a = log(r, 'thought', { title: 'P1', text: 'in alpha' }, 'alpha');
    const b = log(r, 'thought', { title: 'P2', text: 'also in alpha' }, 'alpha');
    const res = entryops.merge(r, [a.id, b.id]);
    assert.equal(res.project, 'alpha');
    assert.ok(lines(r, 'thought', 'alpha').some((e) => e.id === res.created));
    assert.equal(lines(r, 'thought').some((e) => e.id === res.created), false, 'not written into the global drawer');
  } finally { away(r); }
});

test('CLI: mem restore / mem merge run as commands and refuse with a non-zero exit', () => {
  const r = fresh();
  try {
    const run = (...args) => spawnSync(process.execPath, [MEM, ...args, '--root', r], { encoding: 'utf8', cwd: r, env: { ...process.env, CHEAP_MEM_ROOT: '' } });
    const a = log(r, 'thought', { title: 'CLI A', text: 'first' });
    const b = log(r, 'thought', { title: 'CLI B', text: 'second' });
    const bad = run('restore', a.id);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr + bad.stdout, /not closed/);
    const m = run('merge', a.id, b.id, '--why', 'same thing');
    assert.equal(m.status, 0, m.stderr);
    assert.match(m.stdout, /merged: .*->/);
    const rr = run('restore', b.id, '--why', 'oops');
    assert.equal(rr.status, 0, rr.stderr);
    assert.match(rr.stdout, /restored: .* -> .* \(thought, was obsolete\)/);
    assert.notEqual(run('merge', a.id).status, 0, 'one id is refused');
  } finally { away(r); }
});

test('the dashboard says how restore and merge work now, not "not available"', () => {
  const js = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
  assert.doesNotMatch(js, /there is no command that lifts a tombstone/);
  assert.doesNotMatch(js, /there is no merge command/);
  assert.match(js, /mem restore \$\{id\}/);
  assert.match(js, /mem merge \$\{id\}/);
});
