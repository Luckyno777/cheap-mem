// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Z1b (decision E4): nothing unfinished becomes valid by accident.
//
//  (a) a rule WITHOUT any status counts as released (legacy) only when it
//      was filed before procedure.LEGACY_CUTOFF; later ones are `unknown`.
//  (b) the start status is a FIELD of the rule (`start_status`) — one
//      write, so a failure between "rule" and "status" cannot exist.
//  (c) filed with a human --issued-by: released; --start-as proposed|trial
//      still available; a non-human never releases.
//  (d) a `proposed` (or unknown) rule is not shown to a subagent; `trial`
//      comes with its marking; `released` as before.
//
// RED on the fixed old state 68a5316a7b47feb05bbd85f4bc11dd233c575d39: there
// the status was a SECOND write, and when it failed the rule stood as
// released (legacy). The positive control in the same test shows the
// injection really hits the second write there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import * as procedure from '../src/procedure.mjs';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const FAIL = path.join(HERE, 'fixture', 'z1b-fail-second-write.mjs');
const OLD_STATE = '68a5316a7b47feb05bbd85f4bc11dd233c575d39';
const OLD = new Date('2026-09-01T10:00:00Z'); // before the cut-off

function house() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-z1b-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
const mem = (bin, r, env, ...a) => spawnSync(process.execPath, [bin, '--root', r, ...a],
  { encoding: 'utf8', env: { ...process.env, ...env } });
const RULE = (title, ...extra) => ['log', 'procedure', '--title', title,
  '--rule', `Rule text of ${title}.`, '--issued-by', 'owner', '--tags', 'subagent-start', ...extra];
const rows = (r) => fs.readFileSync(path.join(r, 'global', 'procedures.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const statusOfRule = (r, id) => {
  const { entries } = memory.readLog(r, 'procedure');
  return procedure.statusOf(entries.find((e) => e.id === id), procedure.statusIndex(entries));
};
const shown = (r) => procedure.forSubagentStart(r).map((e) => e.title);
const fault = (n) => ({ NODE_OPTIONS: `--import ${pathToFileURL(FAIL).href}`, Z1B_FAIL_APPEND_AT: String(n) });

test('B15 RED on the old state: a failed second write leaves the rule released (legacy); the injection hits the second write (positive control)', () => {
  const r = house();
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-z1b-old-'));
  try {
    execFileSync('tar', ['-x', '-C', old], {
      input: execFileSync('git', ['-C', REPO, 'archive', OLD_STATE], { maxBuffer: 256 * 1024 * 1024 }),
    });
    try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(old, 'node_modules')); } catch { /* none needed */ }
    const o = mem(path.join(old, 'bin', 'mem'), r, fault(2), ...RULE('Old rule', '--start-as', 'proposed'));
    assert.match(o.stderr, /NOT written/, 'positive control: the injected failure hit the status write');
    assert.equal(rows(r).length, 1, 'only the rule was written');
    const { entries } = memory.readLog(r, 'procedure');
    // the OLD reading of that single line: no status line at all = released (legacy)
    assert.equal(entries.filter((e) => e.status_of).length, 0);
    assert.match(mem(path.join(old, 'bin', 'mem'), r, {}, 'procedures').stdout, /status: released \(legacy\)/,
      'old state: the half-written rule stands in force');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test('B15 GREEN: the start status is IN the rule — a failure on the second write cannot happen, on the first it writes nothing', () => {
  for (const start of ['proposed', 'trial']) {
    const r = house();
    try {
      const o = mem(MEM, r, fault(2), ...RULE('Atomic rule', '--start-as', start));
      assert.equal(o.status, 0, o.stderr);
      const id = /id:\s+(\S+)/.exec(o.stdout)[1];
      assert.equal(rows(r).length, 1, 'one line: rule and status together');
      assert.equal(rows(r)[0].start_status, start);
      assert.equal(statusOfRule(r, id).status, start);
      assert.notEqual(statusOfRule(r, id).status, 'released');
      assert.deepEqual(shown(r).includes('Atomic rule'), start === 'trial', 'proposed: not shown; trial: shown (marked)');
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  }
  const r = house();
  try {
    const o = mem(MEM, r, fault(1), ...RULE('Never written', '--start-as', 'proposed'));
    assert.notEqual(o.status, 0, 'a failing write is a failing command');
    assert.ok(!fs.existsSync(path.join(r, 'global', 'procedures.jsonl')) || rows(r).length === 0, 'nothing half-written');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('(a) a status-less rule filed after the cut-off is unknown, never released; the human can still move it', () => {
  const r = house();
  try {
    const e = memory.logEntry(r, 'procedure', {
      title: 'No status', rule: 'x', issued_by: 'owner', agent: 'owner', tags: ['subagent-start'],
    }).entry; // now = after the cut-off
    const st = statusOfRule(r, e.id);
    assert.equal(st.status, 'unknown');
    assert.equal(st.legacy, false);
    assert.equal(procedure.statusMark('unknown'), '[unknown]');
    assert.deepEqual(shown(r), [], 'unknown is not shown to a subagent');
    assert.match(mem(MEM, r, {}, 'procedures').stdout, /\[unknown\] Procedure/);
    const ok = mem(MEM, r, {}, 'procedures', 'status', e.id, 'released', '--issued-by', 'owner');
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(shown(r), ['No status']);
    // a missing/unreadable timestamp is not "old" either
    const noTs = { id: 'zz', rule: 'x', issued_by: 'owner' };
    assert.equal(procedure.statusOf(noTs, procedure.statusIndex([noTs])).status, 'unknown');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: old rules (before the cut-off) stay released (legacy) and are shown as before, also after a correction', () => {
  const r = house();
  try {
    const e = memory.logEntry(r, 'procedure', {
      title: 'Old rule', rule: 'x', issued_by: 'owner', agent: 'owner', tags: ['subagent-start'],
    }, { now: OLD }).entry;
    const st = statusOfRule(r, e.id);
    assert.equal(st.status, 'released');
    assert.equal(st.legacy, true);
    assert.deepEqual(shown(r), ['Old rule']);
    const c = memory.logEntry(r, 'procedure', {
      title: 'Old rule v2', rule: 'y', issued_by: 'owner', agent: 'owner', tags: ['subagent-start'], replaces_id: e.id,
    }).entry; // filed today, but its chain starts before the cut-off
    assert.equal(statusOfRule(r, c.id).status, 'released');
    assert.deepEqual(shown(r), ['Old rule v2']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('(c)+(d) human issuer: released at once and shown; --start-as proposed: not shown; trial: shown, marked; agent never releases itself', () => {
  const r = house();
  try {
    const out = (title, ...x) => { const o = mem(MEM, r, {}, ...RULE(title, ...x)); assert.equal(o.status, 0, o.stderr); return o; };
    out('Human default');
    out('Human proposed', '--start-as', 'proposed');
    out('Human trial', '--start-as', 'trial');
    out('Human explicit released', '--start-as', 'released');
    assert.match(out('Human default2').stdout, /status: released/);
    assert.deepEqual(shown(r).sort(), ['Human default', 'Human default2', 'Human explicit released', 'Human trial']);
    const trial = procedure.forSubagentStart(r).find((e) => e.title === 'Human trial');
    assert.match(procedure.display(trial), /^\[trial\] Procedure/);
    // an agent as issuer is refused, whatever --start-as says
    const bad = mem(MEM, r, {}, 'log', 'procedure', '--title', 'Agent rule', '--rule', 'z', '--issued-by', 'some-agent',
      '--start-as', 'released');
    assert.notEqual(bad.status, 0);
    assert.ok(!rows(r).some((x) => x.title === 'Agent rule'));
    // the field alone does not release for a non-human issuer (written past the CLI)
    const e = memory.logEntry(r, 'procedure', {
      title: 'Forged', rule: 'q', issued_by: 'some-agent', agent: 'some-agent', start_status: 'released', tags: ['subagent-start'],
    }).entry;
    assert.equal(statusOfRule(r, e.id).status, 'unknown');
    assert.ok(!shown(r).includes('Forged'));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
