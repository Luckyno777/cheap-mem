// X3 — the status of a rule (proposed / trial / released / withdrawn)
// and the effect number per rule.
//
// Red on the old stand ea4d78c25a1f386a7f005ab8f569234f371215e8 (there
// is no status, no `mem procedures status`, no effect line): run this
// file against an archive of that commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as procedure from '../src/procedure.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const DAY = 24 * 60 * 60 * 1000;

function house() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-x3-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
const run = (r, ...a) =>
  spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8' });
const RULE = (...extra) => ['log', 'procedure', '--title', 'Falsify first',
  '--rule', 'Build the probe that goes red when it does NOT work.',
  '--issued-by', 'owner', '--on-class', 'looks-right-does-nothing', ...extra];
// E4: a rule WITHOUT any status counts as released (legacy) only when it
// was filed before the cut-off; today's rules without a status are unknown.
// So the legacy fixtures are written with an old timestamp.
const OLD = new Date('2026-09-01T10:00:00Z');
const legacyRule = (r) => memory.logEntry(r, 'procedure', {
  title: 'Falsify first', rule: 'Build the probe that goes red when it does NOT work.',
  issued_by: 'owner', on_class: 'looks-right-does-nothing', agent: 'owner',
}, { now: OLD }).entry;
const idOf = (out) => /id:\s+(\S+)/.exec(out)[1];
const lines = (r) => fs.readFileSync(path.join(r, 'global', 'procedures.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));

test('POSITIVE CONTROL: a rule without a status line is released (legacy) and is shown as before', () => {
  const r = house();
  try {
    const id = legacyRule(r).id;
    const list = run(r, 'procedures').stdout;
    assert.match(list, /Falsify first/);
    assert.match(list, /status: released \(legacy\)/);
    assert.ok(!/\[(proposed|trial)\]/.test(list));
    const armed = run(r, 'log', 'error', '--title', 'x', '--class', 'looks-right-does-nothing').stdout;
    assert.match(armed, /1 procedure in force for this class/);
    assert.ok(id);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a transition without a human is refused and writes nothing', () => {
  const r = house();
  try {
    const id = idOf(run(r, ...RULE('--start-as', 'proposed')).stdout);
    const before = lines(r).length;
    for (const by of [[], ['--issued-by', 'some-agent']]) {
      const o = run(r, 'procedures', 'status', id, 'trial', ...by);
      assert.notEqual(o.status, 0, 'accepted without a human');
      assert.match(o.stderr + o.stdout, /issued_by/);
    }
    assert.equal(lines(r).length, before, 'a refused change still wrote a line');
    // the same call WITH a human goes through (counter-probe)
    const ok = run(r, 'procedures', 'status', id, 'trial', '--issued-by', 'owner');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(lines(r).length, before + 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('nothing moves by itself: repetition, an error of the class, a lane — no status line appears', () => {
  const r = house();
  try {
    run(r, ...RULE('--start-as', 'trial'));
    const n = lines(r).length;
    for (let i = 0; i < 4; i++) run(r, 'log', 'error', '--title', `again ${i}`, '--class', 'looks-right-does-nothing');
    run(r, 'procedures'); run(r, 'procedures', '--match', 'falsify');
    assert.equal(lines(r).length, n);
    // E4: the start status lives in the rule itself; no status LINE was added.
    assert.equal(lines(r).filter((l) => l.status_of).length, 0);
    assert.equal(lines(r).filter((l) => l.start_status === 'trial').length, 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a withdrawn rule is not shown anywhere: list, class lane, keyword lane', () => {
  const r = house();
  try {
    const id = idOf(run(r, ...RULE('--triggers', 'falsify')).stdout);
    assert.equal(run(r, 'procedures', 'status', id, 'withdrawn', '--issued-by', 'owner').status, 0);
    assert.doesNotMatch(run(r, 'procedures').stdout, /Falsify first/);
    assert.doesNotMatch(run(r, 'log', 'error', '--title', 'e', '--class', 'looks-right-does-nothing').stdout, /in force for this class/);
    assert.doesNotMatch(run(r, 'procedures', '--match', 'falsify').stdout, /Falsify first/);
    assert.deepEqual(procedure.forClass(r, 'looks-right-does-nothing'), []);
    // withdrawn is final
    assert.notEqual(run(r, 'procedures', 'status', id, 'released', '--issued-by', 'owner').status, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a proposed or trial rule is shown marked, never as a rule in force; release removes the marking', () => {
  const r = house();
  try {
    const id = idOf(run(r, ...RULE('--start-as', 'proposed')).stdout);
    let list = run(r, 'procedures').stdout;
    assert.match(list, /\[proposed\] Procedure, issued by owner/);
    assert.match(list, /NOT a rule in force/);
    run(r, 'procedures', 'status', id, 'trial', '--issued-by', 'owner');
    assert.match(run(r, 'procedures').stdout, /\[trial\] Procedure/);
    const hits = procedure.forClass(r, 'looks-right-does-nothing');
    assert.equal(hits.length, 1);
    assert.match(procedure.display(hits[0]), /^\[trial\] Procedure, issued by owner/);
    run(r, 'procedures', 'status', id, 'released', '--issued-by', 'owner');
    list = run(r, 'procedures').stdout;
    assert.ok(!/\[(proposed|trial)\]/.test(list));
    assert.match(list, /status: released\n/);
    // a disallowed jump is refused
    assert.notEqual(run(r, 'procedures', 'status', id, 'proposed', '--issued-by', 'owner').status, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a correction (replaces_id) inherits the status: replacing a trial rule does not release it', () => {
  const r = house();
  try {
    const id = idOf(run(r, ...RULE('--start-as', 'trial')).stdout);
    run(r, 'correction', 'procedure', id, '--rule', 'Build the probe, run it on the old stand.');
    const list = run(r, 'procedures').stdout;
    assert.match(list, /\[trial\] Procedure/);
    assert.match(list, /old stand/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('effect: "unknown", not 0, while the 14-day window after the release is not full', () => {
  const r = house();
  try {
    const id = idOf(run(r, ...RULE('--start-as', 'proposed')).stdout);
    run(r, 'procedures', 'status', id, 'released', '--issued-by', 'owner');
    const list = run(r, 'procedures').stdout;
    assert.match(list, /effect: unknown \(window not full/);
    assert.doesNotMatch(list, /in the 14 days before/);
    // a legacy rule has no release moment at all
    const r2 = house();
    try {
      legacyRule(r2);
      assert.match(run(r2, 'procedures').stdout, /effect: unknown \(no release moment/);
    } finally { fs.rmSync(r2, { recursive: true, force: true }); }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('effect: errors of the class 14 days before and after the release, once the window is full (positive control)', () => {
  const r = house();
  try {
    const now = new Date('2026-10-30T12:00:00Z');
    const t = (days) => new Date(now.getTime() - days * DAY);
    const id = idOf(run(r, ...RULE()).stdout);
    // released 20 days ago (birth line first, then the release)
    procedure.writeStatus(r, id, 'proposed', { issued_by: 'owner', birth: true, now: t(30) });
    procedure.writeStatus(r, id, 'released', { issued_by: 'owner', now: t(20) });
    const err = (days, cls) => memory.logEntry(r, 'error',
      { title: `e${days}`, class: cls }, { now: t(days) });
    err(25, 'looks-right-does-nothing'); err(22, 'looks-right-does-nothing'); // before: 2
    err(18, 'looks-right-does-nothing');                                     // after: 1
    err(21, 'concurrency'); err(10, 'concurrency');                          // other class: ignored
    err(40, 'looks-right-does-nothing');                                     // outside the window
    const { entries } = memory.readLog(r, 'procedure');
    const idx = procedure.statusIndex(entries);
    const rule = entries.find((e) => e.id === id);
    const eff = procedure.effectOf(rule, idx, procedure.readErrors(r), { now });
    assert.equal(eff.state, 'measured');
    assert.equal(eff.before, 2);
    assert.equal(eff.after, 1);
    // the same rule 5 days after the release is unknown, not "1"
    const early = procedure.effectOf(rule, idx, procedure.readErrors(r), { now: t(15) });
    assert.equal(early.state, 'unknown');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
