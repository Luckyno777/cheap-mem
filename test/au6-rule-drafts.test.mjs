// AU6 (lucky-mem parity, automation gap L6; owner decision A): from repeated errors
// the code writes, per class and ISO week, ONE `thought` tagged `rule-proposal` - a
// DRAFT. It is not a procedure: no procedure is written, and the text carries no
// ready `--issued-by owner` command (a forgery invitation in a text sessions read).
//
// Pattern: the same class AND the same file, or the same class AND the same
// normalised title, from 3 errors in 14 days. "The same class >= 3" alone is
// deliberately NOT enough (it reaches all twelve classes in every window).
//
// Red probe: against the code before AU6 `src/ruledraft.mjs` and `mem suggest rules`
// do not exist; four mutants (threshold 2, no idempotence, coverage off, window 30)
// are each caught by a probe. Temp memories only; the real memory is never touched.
//
// error: 1968v6itl823
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as ruledraft from '../src/ruledraft.mjs';

const MADE = [];
process.on('exit', () => { for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-12T12:00:00Z');   // Monday, 2026-W42
const DAY = 24 * 3600 * 1000;
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');

function mem(root, ...args) {
  return spawnSync('node', [path.join(REPO, 'bin', 'mem'), ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 60000,
  });
}
function memory_() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-au6-'));
  MADE.push(root);
  const r = mem(root, 'init');
  assert.equal(r.status, 0, r.stderr);
  return root;
}
let n = 0;
function err(root, o) {
  n += 1;
  return memory.logEntry(root, 'error', {
    title: o.title ?? `Error number ${n} with a title of its own ${'x'.repeat(n % 7)}${n}`,
    text: o.text ?? `Probe text ${n}. Fixed: set the guard at the right place.`,
    class: o.class, ...(o.file ? { file: o.file } : {}), ts: o.ts ?? ago(1),
  }).entry;
}
const thoughts = (root) => {
  const p = path.join(root, 'global', 'thoughts.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((z) => JSON.parse(z)) : [];
};
const proceduresFile = (root) => path.join(root, 'global', 'procedures.jsonl');
const drafts = (root) => thoughts(root).filter((t) => (t.tags ?? []).includes('rule-proposal'));

test('AU6: the same class and file, 3x in 14 days -> one thought rule-proposal, no procedure', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'two-truths', file: 'src/a.mjs', ts: ago(i + 1) });
  const r = ruledraft.run(root, { now: NOW, write: true });
  assert.equal(r.week, '2026-W42');
  assert.equal(r.created.length, 1, JSON.stringify(r));
  const t = drafts(root);
  assert.equal(t.length, 1);
  assert.equal(t[0].class, 'two-truths');
  assert.equal(t[0].week, '2026-W42');
  assert.equal(t[0].authority, 'inferred');
  assert.match(t[0].title, /not a procedure/);
  assert.match(t[0].text, /DRAFT, not a procedure and not a rule/);
  assert.match(t[0].text, /3x file src\/a\.mjs/);
  assert.match(t[0].text, /set the guard at the right place/, 'quote from the newest error missing');
  assert.equal(fs.existsSync(proceduresFile(root)), false, 'the draft wrote a procedure');
});

test('AU6: the text carries no ready command to enact the rule', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'race', file: 'bin/x.sh' });
  ruledraft.run(root, { now: NOW, write: true });
  const text = drafts(root)[0].text;
  assert.doesNotMatch(text, /--issued-by/);
  assert.doesNotMatch(text, /mem log procedure --/);
});

test('AU6: the same title 3x (no file) is a pattern too', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'handling', title: 'The Watcher  fell asleep!' });
  assert.equal(ruledraft.run(root, { now: NOW, write: true }).created.length, 1);
  assert.match(drafts(root)[0].text, /3x title "the watcher fell asleep"/);
});

test('AU6: idempotent per class and week - a second run writes nothing, the next week writes again', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'two-truths', file: 'src/a.mjs', ts: ago(i) });
  ruledraft.run(root, { now: NOW, write: true });
  const thursday = new Date(NOW.getTime() + 3 * DAY);
  const two = ruledraft.run(root, { now: thursday, write: true });
  assert.deepEqual(two.created, []);
  assert.deepEqual(two.skipped, [{ class: 'two-truths', reason: 'already-this-week' }]);
  assert.equal(drafts(root).length, 1);
  const next = ruledraft.run(root, { now: new Date(NOW.getTime() + 7 * DAY), write: true });
  assert.equal(next.week, '2026-W43');
  assert.equal(next.created.length, 1);
  assert.equal(drafts(root).length, 2);
});

test('AU6 counter-probe: 2 hits are no pattern; 3 in different files and titles neither (the class alone is not enough)', () => {
  const root = memory_();
  err(root, { class: 'race', file: 'src/a.mjs' });
  err(root, { class: 'race', file: 'src/a.mjs' });
  err(root, { class: 'guard-checks-the-wrong-thing', file: 'src/b.mjs' });
  err(root, { class: 'guard-checks-the-wrong-thing', file: 'src/c.mjs' });
  err(root, { class: 'guard-checks-the-wrong-thing', file: 'src/d.mjs' });
  const r = ruledraft.run(root, { now: NOW, write: true });
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.skipped, []);
  assert.equal(drafts(root).length, 0);
});

test('AU6 counter-probe: hits outside the 14 days do not count', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'two-truths', file: 'src/a.mjs', ts: ago(15 + i) });
  assert.deepEqual(ruledraft.run(root, { now: NOW, write: true }).created, []);
  const root2 = memory_();
  err(root2, { class: 'two-truths', file: 'src/a.mjs', ts: ago(1) });
  err(root2, { class: 'two-truths', file: 'src/a.mjs', ts: ago(13) });
  err(root2, { class: 'two-truths', file: 'src/a.mjs', ts: ago(14.5) });
  assert.deepEqual(ruledraft.run(root2, { now: NOW, write: true }).created, []);
});

test('AU6 counter-probe: without an error class there is no pattern (nothing guessed)', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: undefined, file: 'src/a.mjs' });
  assert.deepEqual(ruledraft.run(root, { now: NOW, write: true }).created, []);
});

test('AU6: with a procedure in force for the class there is no draft any more', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'two-truths', file: 'src/a.mjs' });
  const p = mem(root, 'log', 'procedure', '--title', 'One truth', '--rule', 'One source, nothing else.', '--on-class', 'two-truths', '--issued-by', 'owner');
  assert.equal(p.status, 0, p.stderr);
  const r = ruledraft.run(root, { now: NOW, write: true });
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.skipped, [{ class: 'two-truths', reason: 'procedure-in-force' }]);
});

test('AU6: without write it is only a preview (nothing on the disk)', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'two-truths', file: 'src/a.mjs' });
  const r = ruledraft.run(root, { now: NOW });
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].dry, true);
  assert.equal(drafts(root).length, 0);
});

test('AU6 weekly tick: a no-op after the first call of the week, stamp under .mem/, runs again next week', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'two-truths', file: 'src/a.mjs', ts: ago(i) });
  const a = ruledraft.runWeekly(root, { now: NOW });
  assert.equal(a.ranNow, true);
  assert.equal(a.created.length, 1);
  assert.equal(fs.readFileSync(path.join(root, ruledraft.STAMP_FILE), 'utf8').trim(), '2026-W42');
  const b = ruledraft.runWeekly(root, { now: new Date(NOW.getTime() + DAY) });
  assert.equal(b.ranNow, false);
  assert.equal(drafts(root).length, 1);
  const c = ruledraft.runWeekly(root, { now: new Date(NOW.getTime() + 7 * DAY) });
  assert.equal(c.ranNow, true);
  assert.equal(drafts(root).length, 2);
});

test('AU6 CLI: mem suggest rules - preview, --write, again (idempotent), procedures untouched', () => {
  const root = memory_();
  for (let i = 0; i < 3; i += 1) err(root, { class: 'two-truths', file: 'src/a.mjs' });
  const at = ago(0);   // the errors were logged 1 day before NOW; the CLI is told to run at NOW
  const preview = mem(root, 'suggest', 'rules', '--now', at);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /would create {2}two-truths \(3 errors\)/);
  assert.equal(drafts(root).length, 0);
  const wrote = JSON.parse(mem(root, 'suggest', 'rules', '--write', '--now', at, '--json').stdout);
  assert.equal(wrote.created.length, 1);
  assert.deepEqual(JSON.parse(mem(root, 'suggest', 'rules', '--write', '--now', at, '--json').stdout).created, []);
  assert.equal(drafts(root).length, 1);
  assert.equal(fs.existsSync(proceduresFile(root)), false);
});

test('AU6 CLI: an unknown flag and a broken time are refused', () => {
  const root = memory_();
  assert.notEqual(mem(root, 'suggest', 'rules', '--nope').status, 0);
  const z = mem(root, 'suggest', 'rules', '--now', 'yesterday');
  assert.notEqual(z.status, 0);
  assert.match(z.stderr, /is not a time/);
});

test('AU6: bin/mem-digest runs the weekly tick (switch MEM_RULE_DRAFT), after the miss gold and before the dueness check', () => {
  const sh = fs.readFileSync(path.join(REPO, 'bin', 'mem-digest'), 'utf8');
  const a = sh.indexOf('suggest rules --weekly');
  assert.ok(a > 0, 'the tick does not call the weekly rule drafts');
  assert.ok(a > sh.indexOf('gold miss daily') && a < sh.indexOf('digest due'), 'wrong place in the tick');
  assert.match(sh, /MEM_RULE_DRAFT:-yes/);
});
