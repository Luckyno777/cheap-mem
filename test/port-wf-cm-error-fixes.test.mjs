// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/port-wf-cm-error-fixes.test.mjs — errors linked to their fixes
// and lessons WITHOUT a new graph, ported from lucky-mem's L2a
// (b707200e / f498d74b, twins).
//
//   - commit trailer `Fixes: <error-id>` -> `mem error-fixes backfill`
//     writes ONE `resolves` link per known id (evidence `commit:<hash>`),
//     idempotent; an unknown id is a warning, never a link;
//   - `mem log learning --from <error-id>` -> `generalizes` links; an
//     unknown id aborts before the write; without --from a note;
//   - `mem log error` names learnings/fixes for the same class/file;
//   - a `commit:<hash>` link end is evidence, not a dangling edge;
//   - doctor finding `error-linked`.
//
// Red on the base commit 2bf94e4: `mem error-fixes` is unknown, `--from`
// is stored as a plain field, `commit:` ends read as dangling, and the
// finding does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as doctor from '../src/doctor.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fixes-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', timeout: 30000 });
  const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q');
  return root;
}
const done = (root) => fs.rmSync(root, { recursive: true, force: true });
const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const run = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a],
  { encoding: 'utf8', timeout: 30000, env: { ...process.env, MEM_BROADCAST_OFF: '1' } });
function commit(root, message) {
  fs.appendFileSync(path.join(root, 'work.txt'), `${message}\n`);
  spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8' });
  const r = spawnSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-qm', message], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
}
function logError(root, title, extra = []) {
  const r = run(root, 'log', 'error', '--title', title, '--without-scaffold', ...extra);
  assert.equal(r.status, 0, r.stderr);
  return /id: (\S+)/.exec(r.stdout)[1];
}
function linksOfKind(root, kind) {
  const out = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    try { for (const l of memory.readLog(root, 'link', { project }).entries) if (l.kind === kind) out.push(l); } catch { /* none */ }
  }
  return out;
}

test('POSITIVE CONTROL: the trailer reader finds ids, stops at a remark, ignores other lines', async () => {
  const ef = await import('../src/errorfixes.mjs');
  assert.deepEqual(ef.fixesIds('subject\n\nFixes: aaaaaaaaaaaa, bbbbbbbbbbbb (both)\nfixes: cccccccccccc\nNot Fixes: x'),
    ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']);
  assert.deepEqual(ef.fixesIds('no trailer here, it fixes nothing'), []);
});

test('backfill: a Fixes: trailer -> one resolves link per known id with commit evidence; unknown id = warning, no link', () => {
  const root = world();
  try {
    const e = logError(root, 'Hook exits silently on windows');
    const hash = commit(root, `repair the hook\n\nFixes: ${e}, zzzzzzzzzzz9`);
    const r = run(root, 'error-fixes', 'backfill');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /WARNING: commit \S+ says "Fixes: zzzzzzzzzzz9"/);
    const links = linksOfKind(root, 'resolves');
    assert.equal(links.length, 1, JSON.stringify(links));
    assert.equal(links[0].to, e);
    assert.equal(links[0].evidence, `commit:${hash.slice(0, 12)}`);
    assert.equal(links[0].from, links[0].evidence);
  } finally { done(root); }
});

test('backfill: no trailer -> no link (POSITIVE CONTROL of the one above)', () => {
  const root = world();
  try {
    logError(root, 'Something broke');
    commit(root, 'an unrelated change');
    run(root, 'error-fixes', 'backfill');
    assert.equal(linksOfKind(root, 'resolves').length, 0);
  } finally { done(root); }
});

test('backfill --check-only counts without writing; a second real run is idempotent', () => {
  const root = world();
  try {
    const e = logError(root, 'Index rebuild loops');
    commit(root, `stop the loop\n\nFixes: ${e}`);
    const c = run(root, 'error-fixes', 'backfill', '--check-only');
    assert.match(c.stdout, /would write 1/);
    assert.equal(linksOfKind(root, 'resolves').length, 0);
    run(root, 'error-fixes', 'backfill');
    run(root, 'error-fixes', 'backfill');
    assert.equal(linksOfKind(root, 'resolves').length, 1);
  } finally { done(root); }
});

test('backfill: "fixes <id>" in the text counts (narrow); a fix word elsewhere on the line does not', () => {
  const root = world();
  try {
    const a = logError(root, 'First defect');
    const b = logError(root, 'Second defect');
    commit(root, `this fixes ${a} for good`);
    commit(root, `not fixed yet, see ${b}`);
    const r = run(root, 'error-fixes', 'backfill');
    assert.match(r.stdout, /another 1 mention/);
    const to = linksOfKind(root, 'resolves').map((l) => l.to);
    assert.deepEqual(to, [a]);
  } finally { done(root); }
});

test('a commit: link end is evidence outside the memory, not dangling (links and orphans)', () => {
  const root = world();
  try {
    const e = logError(root, 'Edge case');
    commit(root, `fix\n\nFixes: ${e}`);
    run(root, 'error-fixes', 'backfill');
    const g = memory.linksOf(root, e);
    assert.equal(g.dangling.length, 0, JSON.stringify(g.dangling));
    assert.equal(g.incoming.length, 1);
    assert.match(run(root, 'links', e).stdout, /evidence outside the memory/);
    assert.notEqual(doctor.checkOrphans(root).level, doctor.LEVEL.WARN);
    // POSITIVE CONTROL: a link into a truly missing id still dangles.
    memory.logEntry(root, 'link', { from: e, to: 'nosuchid0000', kind: 'causes' });
    assert.equal(doctor.checkOrphans(root).level, doctor.LEVEL.WARN);
  } finally { done(root); }
});

test('mem log learning --from: generalizes links; an unknown id aborts BEFORE the write', () => {
  const root = world();
  try {
    const e = logError(root, 'Paths with backslashes break the hook');
    const before = size(memory.logPath(root, 'learning'));
    const bad = run(root, 'log', 'learning', '--title', 'nope', '--from', 'nosuchid0000');
    assert.equal(bad.status, 1);
    assert.equal(size(memory.logPath(root, 'learning')), before);
    const ok = run(root, 'log', 'learning', '--title', 'Convert backslashes first', '--from', e);
    assert.equal(ok.status, 0, ok.stderr);
    const id = /id: (\S+)/.exec(ok.stdout)[1];
    const links = linksOfKind(root, 'generalizes');
    assert.deepEqual(links.map((l) => [l.from, l.to]), [[id, e]]);
    assert.equal(memory.getEntry(root, id).from, undefined, '--from must not land as a field');
  } finally { done(root); }
});

test('mem log learning without --from: a note names a fitting error with the ready command, links nothing', () => {
  const root = world();
  try {
    const e = logError(root, 'Windows hook paths silently ignored', ['--class', 'assumed-not-measured']);
    const r = run(root, 'log', 'learning', '--title', 'Hook paths need slashes', '--class', 'assumed-not-measured',
      '--text', 'mention assumed-not-measured');
    assert.match(r.stdout, /Fitting errors/);
    assert.match(r.stdout, new RegExp(`--to ${e} --kind generalizes`));
    assert.equal(linksOfKind(root, 'generalizes').length, 0);
  } finally { done(root); }
});

test('mem log error: names an existing learning and fix for the same class, writes only the error', () => {
  const root = world();
  try {
    const e = logError(root, 'Release script forgot the tag', ['--class', 'gate-without-proof']);
    run(root, 'log', 'learning', '--title', 'Tag before you publish', '--from', e);
    commit(root, `tag it\n\nFixes: ${e}`);
    run(root, 'error-fixes', 'backfill');
    const linksBefore = linksOfKind(root, 'resolves').length + linksOfKind(root, 'generalizes').length;
    const r = run(root, 'log', 'error', '--title', 'Release script forgot the tag again',
      '--class', 'gate-without-proof', '--without-scaffold');
    assert.match(r.stdout, /Already there for this/);
    assert.match(r.stdout, /learning .*Tag before you publish/);
    assert.match(r.stdout, /fix +commit:\S+ fixed /);
    assert.equal(linksOfKind(root, 'resolves').length + linksOfKind(root, 'generalizes').length, linksBefore);
  } finally { done(root); }
});

test('doctor error-linked: unknown below 5 errors, warn without links, good with enough; writes nothing', () => {
  const root = world();
  try {
    assert.equal(doctor.checkErrorLinked(root).level, doctor.LEVEL.UNKNOWN);
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(logError(root, `defect number ${i} in a distinct place ${i}`));
    const sizeBefore = size(memory.logPath(root, 'link'));
    assert.equal(doctor.checkErrorLinked(root).level, doctor.LEVEL.WARN);
    assert.equal(size(memory.logPath(root, 'link')), sizeBefore);
    commit(root, `fix two\n\nFixes: ${ids[0]}, ${ids[1]}`);
    run(root, 'error-fixes', 'backfill');
    run(root, 'log', 'learning', '--title', 'one lesson', '--from', ids[2]);
    // POSITIVE CONTROL: 2 of 5 resolves (40 %) and 1 of 5 generalizes (20 %) clear both targets.
    const f = doctor.checkErrorLinked(root);
    assert.equal(f.level, doctor.LEVEL.GOOD, f.text);
  } finally { done(root); }
});
