// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/port-l3-cm-experience.test.mjs — lucky-mem's L3 (+ L2b) ported:
// the experience account of a registry entry inside its DECLARED scope,
// the causality gate, the sharpening package (proposal only), versions as
// trial correction lines (owner only), the before/after count, "review"
// marks, test <-> error guards and the procedure effect, with the doctor
// findings skill-sharpen, guard-suspicion and procedure-effect.
// lm commits 049f8756/f1e58138 (L3), 9a5c71a3/ce851a07 (commit time of a
// Fixes edge as its source time), 66ed2907 (a version may set the scope).
//
// Red on the fixed base 2930909: src/experience.mjs does not exist
// (ERR_MODULE_NOT_FOUND for every probe), `mem skills` knows no
// account/sharpen/version, `mem experience` is unknown, and the three
// findings are missing. Positive controls: "the account counts the error
// IN scope" and "guarded" show the negations below can see something.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as reg from '../src/skillregistry.mjs';
import * as doctor from '../src/doctor.mjs';
import * as xp from '../src/experience.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const NOW = new Date('2026-09-30T12:00:00Z');
const ago = (n) => new Date(NOW.getTime() - n * 86400000);
const CLS = 'concurrency';
const ENV = { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_MAX_AUTHORITY: '', MEM_BROADCAST_OFF: '1' };
const cli = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a], { encoding: 'utf8', env: ENV, timeout: 40000 });

const log = (root, type, data, days) => memory.logEntry(root, type, { agent: 'test', ...data }, { now: ago(days) }).entry;
const err = (root, days, cls = CLS, file = 'src/svc/a.mjs', extra = {}) => log(root, 'error', { title: `error ${days}`, text: 'filler', class: cls, file, ...extra }, days);
const link = (root, kind, from, to, days, extra = {}) => log(root, 'link', { from, to, kind, why: 'probe', ...extra }, days);
const item = (root, id) => reg.registry(root).find((i) => i.id === id || i.name === id);

/**
 * A skill `needle` (scope: concurrency in src/svc/), a skill `none` without
 * a scope, both released 39 days ago. Errors:
 *   n0 (60 days)  concurrency in src/svc/a.mjs   -> in scope, older than 30 days
 *   n1 (5), n2 (3) concurrency in src/svc/a.mjs  -> IN scope
 *   x1 (2)        concurrency in src/other/b.mjs -> file outside
 *   x2 (2)        mishandling in src/svc/a.mjs   -> class outside
 */
function world(t, { needle = {} } = {}) {
  const root = tempDir('cm-l3-', t);
  assert.equal(cli(root, 'init').status, 0);
  const ids = {};
  ids.needle = log(root, 'skill', { title: 'Needle: start services cleanly', text: 'body', classes: [CLS], files: ['src/svc/'], ...needle }, 40).id;
  ids.none = log(root, 'skill', { title: 'None: some skill', text: 'body' }, 40).id;
  for (const k of ['needle', 'none']) log(root, 'skill', { status_of: ids[k], status: 'released', issued_by: 'owner' }, 39);
  ids.n0 = err(root, 60).id;
  ids.n1 = err(root, 5).id;
  ids.n2 = err(root, 3).id;
  ids.x1 = err(root, 2, CLS, 'src/other/b.mjs').id;
  ids.x2 = err(root, 2, 'mishandling').id;
  return { root, ids };
}
const bytes = (root) => fs.readdirSync(path.join(root, 'global')).filter((f) => f.endsWith('.jsonl')).sort()
  .map((f) => fs.readFileSync(path.join(root, 'global', f), 'utf8')).join('|');

// --- scope & account -----------------------------------------------------------

test('account: counts the errors IN scope, not outside (positive control + counter-probes)', (t) => {
  const { root, ids } = world(t);
  const k = xp.account(item(root, ids.needle), xp.stock(root), { now: NOW });
  assert.deepEqual(k.traps.map((f) => f.id).sort(), [ids.n0, ids.n1, ids.n2].sort());
  assert.deepEqual(k.cases.sort(), [ids.n1, ids.n2].sort(), 'n0 is older than 30 days');
  assert.equal(k.proposal, true);
  assert.equal(k.usage.outcome, 'unknown', 'the outcome of a use is in no journal');
});

test('without a scope: NO error assignment — even when class and file would match by chance', (t) => {
  const { root, ids } = world(t);
  const k = xp.account(item(root, ids.none), xp.stock(root), { now: NOW });
  assert.equal(k.withoutScope, true);
  assert.equal(k.traps.length, 0);
  const bad = xp.scopeOf({ classes: ['no-such-class'] });
  assert.deepEqual(bad.invalid, ['no-such-class'], 'an unknown class is not guessed');
  assert.equal(bad.empty, true);
  assert.deepEqual(xp.scopeOf({ on_class: 'concurrency' }).classes, [CLS], "a procedure's on_class is its scope");
});

test('account: fixes (resolves), learnings (generalizes), contradictions and open traps — each with an id', (t) => {
  const { root, ids } = world(t);
  const l = log(root, 'learning', { title: 'Lesson', text: 'x' }, 1);
  link(root, 'resolves', 'commit:abcdef123456', ids.n1, 1, { evidence: 'commit:abcdef123456' });
  link(root, 'generalizes', l.id, ids.n2, 1);
  link(root, 'contradicts', l.id, ids.n0, 1);
  const k = xp.account(item(root, ids.needle), xp.stock(root), { now: NOW });
  assert.deepEqual(k.fixes.map((f) => [f.fix, f.error]), [['commit:abcdef123456', ids.n1]]);
  assert.deepEqual(k.learnings.map((f) => [f.learning, f.error]), [[l.id, ids.n2]]);
  assert.equal(k.contradictions.length, 1);
  assert.deepEqual(k.openTraps.sort(), [ids.n0, ids.n2].sort());
});

test('gate: one case in 30 days is no proposal, two are one', (t) => {
  const root = tempDir('cm-l3-', t);
  assert.equal(cli(root, 'init').status, 0);
  const s = log(root, 'skill', { title: 'Gate', text: 'b', classes: [CLS] }, 40);
  log(root, 'skill', { status_of: s.id, status: 'released', issued_by: 'owner' }, 39);
  err(root, 4);
  err(root, 45);
  assert.equal(xp.account(item(root, s.id), xp.stock(root), { now: NOW }).proposal, false);
  err(root, 2);
  assert.equal(xp.account(item(root, s.id), xp.stock(root), { now: NOW }).proposal, true);
});

// --- sharpening package -------------------------------------------------------------

test('package: new traps, a proven fix, a new learning — each with evidence; ripe needs points, kinds AND the gate', (t) => {
  const { root, ids } = world(t);
  const old = err(root, 25, CLS, 'src/svc/z.mjs');
  const fix = log(root, 'learning', { title: 'Fix note', text: 'x' }, 20);
  link(root, 'resolves', fix.id, old.id, 20);
  const l = log(root, 'learning', { title: 'Lesson', text: 'x' }, 1);
  link(root, 'generalizes', l.id, ids.n1, 1);
  const p = xp.packages(root, { now: NOW, name: ids.needle })[0];
  const kinds = new Set(p.points.map((x) => x.kind));
  assert.ok(kinds.has('new-trap') && kinds.has('new-learning'), JSON.stringify(p.points));
  assert.ok(p.points.some((x) => x.kind === 'proven-fix' && x.evidence === fix.id), 'a fix 20 days old, its error never came back');
  assert.equal(p.ripe, true, p.reason);
  const none = xp.packages(root, { now: NOW, name: ids.none })[0];
  assert.equal(none.withoutScope, true);
  assert.equal(none.ripe, false);
});

test('package: too young a fix, or one whose error came back, is NOT proven; a lone kind is not ripe', (t) => {
  const { root, ids } = world(t);
  const fix = log(root, 'learning', { title: 'Fix', text: 'x' }, 4);
  link(root, 'resolves', fix.id, ids.n1, 4);
  const p = xp.packages(root, { now: NOW, name: ids.needle })[0];
  assert.ok(!p.points.some((x) => x.kind === 'proven-fix'), 'four days is not proven');
  assert.deepEqual([...new Set(p.points.map((x) => x.kind))], ['new-trap']);
  assert.equal(p.ripe, false, 'only traps: a situation, not a package');
  const { root: r2, ids: i2 } = world(t);
  const f2 = log(r2, 'learning', { title: 'Fix', text: 'x' }, 20);
  link(r2, 'resolves', f2.id, i2.n0, 20);
  assert.ok(!xp.packages(r2, { now: NOW, name: i2.needle })[0].points.some((x) => x.kind === 'proven-fix'),
    'same class and file came back after the fix (n1, n2)');
});

test('Fixes edge: the COMMIT time is the source time, not when backfill wrote the edge (lm 9a5c71a3)', (t) => {
  const { root, ids } = world(t);
  const g = (env, ...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', env: { ...process.env, ...env } });
  g({}, 'init', '-q');
  fs.writeFileSync(path.join(root, 'work.txt'), 'x\n');
  g({}, 'add', 'work.txt');
  const when = ago(20).toISOString();
  const c = g({ GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-qm', `fix\n\nFixes: ${ids.n0}`);
  assert.equal(c.status, 0, c.stderr);
  const hash = g({}, 'rev-parse', 'HEAD').stdout.trim().slice(0, 12);
  // the edge itself is written "now" (1 day ago) — as backfill would
  link(root, 'resolves', `commit:${hash}`, ids.n0, 1, { evidence: `commit:${hash}` });
  const s = xp.stock(root);
  const k = xp.account(item(root, ids.needle), s, { now: NOW });
  assert.equal(Date.parse(k.fixes[0].ts), Date.parse(when), 'commit time, not edge time');
});

// --- versions ------------------------------------------------------------------------

test('version: refused without --authority user or with an agent as author — NOTHING written', (t) => {
  const { root, ids } = world(t);
  const before = bytes(root);
  const env = { MEM_HEADLESS: '' };
  assert.throws(() => xp.writeVersion(root, ids.needle, { text: 'v2', issued_by: 'owner', env }), /--authority user/);
  assert.throws(() => xp.writeVersion(root, ids.needle, { text: 'v2', authority: 'user', issued_by: 'some-agent', env }), /not a human/);
  assert.throws(() => xp.writeVersion(root, ids.needle, { text: 'v2', authority: 'user', issued_by: 'owner', env: { MEM_HEADLESS: 'watcher' } }), /headless/);
  assert.throws(() => xp.writeVersion(root, ids.needle, { authority: 'user', issued_by: 'owner', env }), /changes nothing/);
  assert.equal(bytes(root), before);
});

test('version: a human files a correction line, status trial (never released), scope carries; a procedure is refused', (t) => {
  const { root, ids } = world(t);
  const r = xp.writeVersion(root, ids.needle, { text: 'v2 body', authority: 'user', issued_by: 'owner', env: { MEM_HEADLESS: '' } });
  assert.equal(r.entry.replaces_id, ids.needle);
  assert.equal(r.entry.start_status, 'trial');
  const now = reg.registry(root).filter((i) => i.title.startsWith('Needle'));
  assert.deepEqual(now.map((i) => [i.id, i.status]), [[r.entry.id, 'trial']], 'the old one is replaced, the new one is trial');
  assert.deepEqual(xp.scopeOf(r.entry).classes, [CLS]);
  assert.deepEqual(xp.scopeOf(r.entry).files, ['src/svc/']);
  const proc = log(root, 'procedure', { rule: 'Never start twice', title: 'Twice', issued_by: 'owner', on_class: CLS }, 10);
  assert.throws(() => xp.writeVersion(root, proc.id, { text: 'x', authority: 'user', issued_by: 'owner', env: { MEM_HEADLESS: '' } }), /procedure/);
});

test('version may set the scope; a scope-only version keeps the package start (lm 66ed2907)', (t) => {
  const { root, ids } = world(t);
  const before = xp.packages(root, { now: NOW, name: ids.none })[0];
  assert.equal(before.withoutScope, true);
  assert.throws(() => xp.writeVersion(root, ids.none, { classes: ['nope'], authority: 'user', issued_by: 'owner', env: { MEM_HEADLESS: '' } }), /unknown values/);
  const r = xp.writeVersion(root, ids.none, { classes: [CLS], files: ['src/svc/'], authority: 'user', issued_by: 'owner', env: { MEM_HEADLESS: '' } });
  assert.ok(r.entry.content_since, 'content_since carried');
  const after = xp.packages(root, { now: NOW, name: r.entry.id })[0];
  assert.equal(after.withoutScope, false);
  assert.ok(after.points.filter((x) => x.kind === 'new-trap').length >= 2, 'the cases since the content stay in the package');
});

test('before/after: unknown until the window is full and enough cases lay before; then measured', (t) => {
  const { root, ids } = world(t);
  const s = xp.stock(root);
  const it = item(root, ids.needle);
  assert.equal(xp.compare(it, s, { now: NOW }).state, 'unknown', 'never replaced');
  const at = (days) => ({ ...it, ts: ago(days).toISOString(), entry: { ...it.entry, version_of: 'x' } });
  assert.match(xp.compare(at(5), s, { now: NOW }).reason, /window not full/);
  assert.match(xp.compare(at(20), s, { now: NOW }).reason, /minimum 3/);
  for (const d of [30, 28, 26, 10, 8]) err(root, d);
  const v = xp.compare(at(20), xp.stock(root), { now: NOW });
  assert.equal(v.state, 'measured', JSON.stringify(v));
  assert.deepEqual([v.before, v.after], [3, 2]);
});

// --- review marks (L2b) ---------------------------------------------------------------

test('review: a newer learning over an error with a fix marks the OLD fix — never obsolete, nothing written', (t) => {
  const { root, ids } = world(t);
  const fix = log(root, 'learning', { title: 'Fix 1', text: 'x' }, 10);
  link(root, 'resolves', fix.id, ids.n1, 10);
  const newer = log(root, 'learning', { title: 'General', text: 'x' }, 2);
  link(root, 'generalizes', newer.id, ids.n1, 2);
  const before = bytes(root);
  assert.deepEqual(xp.reviewMarks(root), [{ fix: fix.id, learning: newer.id, error: ids.n1 }], 'positive control');
  assert.equal(bytes(root), before);
  const { root: r2, ids: i2 } = world(t);
  const older = log(r2, 'learning', { title: 'Old lesson', text: 'x' }, 50);
  const f2 = log(r2, 'learning', { title: 'Fix', text: 'x' }, 10);
  link(r2, 'resolves', f2.id, i2.n1, 10);
  link(r2, 'generalizes', older.id, i2.n1, 9);
  assert.deepEqual(xp.reviewMarks(r2), [], 'a learning OLDER than the fix questions nothing');
});

// --- guards ----------------------------------------------------------------------------

function guardWorld(t) {
  const { root } = world(t);
  const s1 = err(root, 40, 'two-truths', 'src/a.mjs');
  const s2 = err(root, 40, 'two-truths', 'src/b.mjs');
  const s3 = err(root, 40, 'two-truths', 'src/c.mjs');
  const w2 = err(root, 5, 'two-truths', 'src/b.mjs');
  const w3 = err(root, 5, 'mishandling', 'src/zzz.mjs', { origin: { derived_from: [s3.id] } });
  const v1 = err(root, 45, 'two-truths', 'src/a.mjs');
  const mk = (id) => `// error: ${id}\nimport test from 'node:test';\ntest('p', () => {});\n`;
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'a.test.mjs'), mk(s1.id));
  fs.writeFileSync(path.join(root, 'test', 'b.test.mjs'), mk(s2.id));
  fs.writeFileSync(path.join(root, 'test', 'c.test.mjs'), mk(s3.id));
  fs.writeFileSync(path.join(root, 'test', 'd.test.mjs'), mk('unknown9abcd'));
  fs.writeFileSync(path.join(root, 'test', 'empty.test.mjs'), `// error: ${s1.id}\n// no test here\n`);
  return { root, s1, s2, s3, w2, w3, v1 };
}

test('guards: a test with `// error: <id>` guards it; a return AFTER the test commit is a suspicion with both ids', (t) => {
  const { root, s1, s2, s3, w2, w3, v1 } = guardWorld(t);
  const g = xp.guards(root, { commitTime: () => ago(30).toISOString() });
  const per = Object.fromEntries(g.pairs.map((p) => [p.error, p]));
  assert.equal(g.pairs.length, 4, 'a test file without test() does not count');
  assert.equal(per[s1.id].state, 'guarded', 'positive control');
  assert.ok(!per[s1.id].back.some((x) => x.id === v1.id), 'an error BEFORE the test commit is no return');
  assert.deepEqual(per[s2.id].back, [{ id: w2.id, via: 'file-class' }]);
  assert.equal(per[s2.id].test, 'test/b.test.mjs');
  assert.deepEqual(per[s3.id].back, [{ id: w3.id, via: 'explicit' }]);
  assert.equal(per.unknown9abcd.state, 'id-unknown');
  const blind = xp.guards(root, { commitTime: () => null });
  assert.ok(blind.pairs.filter((p) => p.error !== 'unknown9abcd').every((p) => p.state === 'time-unknown'), 'no commit time: never guarded');
});

test('doctor guard-suspicion: unknown without git, then measured with a real commit', (t) => {
  const { root } = guardWorld(t);
  const blind = doctor.checkGuardSuspicion(root);
  assert.equal(blind.name, 'guard-suspicion');
  assert.equal(blind.level, 'unknown', blind.text);
  const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('add', 'test');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 't');
  const ok = doctor.checkGuardSuspicion(root);
  assert.equal(ok.level, 'good', `${ok.text} — the errors lie BEFORE the commit made now`);
});

// --- procedure effect ---------------------------------------------------------------------

function effectWorld(t, after) {
  const root = tempDir('cm-l3-', t);
  assert.equal(cli(root, 'init').status, 0);
  for (const i of [1, 2, 3, 4]) err(root, 20 + i * 2);
  for (const d of after) err(root, d);
  const p = log(root, 'procedure', { rule: 'Never start a service twice', title: 'Double start', issued_by: 'owner', on_class: CLS, start_status: 'trial' }, 21);
  log(root, 'procedure', { status_of: p.id, status: 'released', issued_by: 'owner' }, 20);
  const legacy = memory.logEntry(root, 'procedure', { rule: 'Old rule', title: 'Old', issued_by: 'owner', on_class: CLS, agent: 'test' },
    { now: new Date('2026-09-01T00:00:00Z') }).entry;
  return { root, p, legacy };
}
const effect = (root) => Object.fromEntries(xp.procedureEffect(root, { now: NOW }).map((x) => [x.id, x]));

test('procedure effect: effective (none after), ineffective (rate not lower), legacy/too few -> unknown', (t) => {
  const a = effectWorld(t, []);
  const e = effect(a.root);
  assert.equal(e[a.p.id].verdict, 'effective', JSON.stringify(e[a.p.id]));
  assert.equal(e[a.p.id].before.errors, 4);
  assert.equal(e[a.legacy.id].verdict, 'unknown', 'legacy: no release moment');
  const b = effectWorld(t, [18, 16, 14, 12]);
  assert.equal(effect(b.root)[b.p.id].verdict, 'ineffective');
  const c = effectWorld(t, [18]);
  assert.equal(effect(c.root)[c.p.id].verdict, 'unknown', 'neither clearly lower nor the same');
  const young = xp.procedureEffect(a.root, { now: ago(10) }).find((x) => x.id === a.p.id);
  assert.match(young.reason, /window not full/);
});

test('doctor procedure-effect and skill-sharpen: good / warn / unknown', (t) => {
  assert.equal(doctor.checkProcedureEffect(effectWorld(t, []).root, { now: NOW }).level, 'good');
  assert.equal(doctor.checkProcedureEffect(effectWorld(t, [18, 16, 14, 12]).root, { now: NOW }).level, 'warn');
  const { root, ids } = world(t);
  assert.equal(doctor.checkProcedureEffect(root, { now: NOW }).level, 'unknown');
  assert.equal(doctor.checkSkillSharpen(root, { now: NOW }).level, 'good', 'only traps: not ripe');
  const fix = log(root, 'learning', { title: 'Fix', text: 'x' }, 20);
  link(root, 'resolves', fix.id, err(root, 25, CLS, 'src/svc/z.mjs').id, 20);
  const l = log(root, 'learning', { title: 'Lesson', text: 'x' }, 1);
  link(root, 'generalizes', l.id, ids.n1, 1);
  const w = doctor.checkSkillSharpen(root, { now: NOW });
  assert.equal(w.level, 'warn', w.text);
  assert.match(w.advice, /needle/);
  const bare = tempDir('cm-l3-', t);
  assert.equal(cli(bare, 'init').status, 0);
  assert.equal(doctor.checkSkillSharpen(bare, { now: NOW }).level, 'unknown', 'no entry with a scope: not measurable');
  const names = new Set(doctor.checkAll(bare).findings.map((f) => f.name));
  for (const n of ['skill-sharpen', 'guard-suspicion', 'procedure-effect']) assert.ok(names.has(n), n);
});

// --- CLI ------------------------------------------------------------------------------

test('CLI: mem skills account/sharpen/version and mem experience run; version without authority is refused', (t) => {
  const { root, ids } = world(t);
  const a = cli(root, 'skills', 'account');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /2 entries, 1 with a scope, 1 without/);
  const one = cli(root, 'skills', 'account', ids.needle, '--json');
  assert.equal(JSON.parse(one.stdout)[0].id, ids.needle);
  const s = cli(root, 'skills', 'sharpen', ids.needle);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /new-trap/);
  assert.match(s.stdout, /Proposal only/);
  const no = cli(root, 'skills', 'version', ids.needle, '--text', 'v2', '--issued-by', 'owner');
  assert.equal(no.status, 1);
  assert.match(no.stderr + no.stdout, /--authority user/);
  const yes = cli(root, 'skills', 'version', ids.needle, '--text', 'v2', '--issued-by', 'owner', '--authority', 'user', '--json');
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(JSON.parse(yes.stdout).status, 'trial');
  for (const sub of ['review', 'guards', 'effect']) {
    const r = cli(root, 'experience', sub, '--json');
    assert.ok(r.status === 0 || (sub === 'guards' && r.status === 1), `${sub}: ${r.stderr}`);
  }
  assert.equal(cli(root, 'experience', 'nope').status, 1);
});
