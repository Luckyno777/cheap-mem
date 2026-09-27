// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/time-lane-harness-gate.test.mjs — `mem find`'s time router end to
// end (M16 port from lucky-mem, "the time lane floods the same 20
// entries"):
//
//   - a harness-wrapped turn (<task-notification>...) never takes the
//     time-window route, even carrying a bare date;
//   - the SAME date, asked as a real question, does take it;
//   - the JSON branch of the time-window route honours --top instead of
//     always handing back up to 20;
//   - it books to the injection journal like the ranked lane does, so
//     --journal-session sees a time-routed turn too.
//
// Positive controls throughout: every "this must not happen" case is
// paired with one proving the same machinery DOES fire when it should.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { read as readInjection } from '../src/injection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');

function mem(root, ...argv) {
  try {
    return { code: 0, out: execFileSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// Five digested entries, all inside the same day — enough to prove a cap
// below 5 actually cuts something.
const DAY = '2026-08-29';
const ROWS = Array.from({ length: 5 }, (_, i) => ({
  id: `w${i}`,
  ts: `${DAY}T${String(10 + i).padStart(2, '0')}:00:00Z`,
  type: 'event',
  title: `entry ${i} about the deploy`,
}));

function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-time-gate-'));
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.writeFileSync(path.join(root, 'global', 'events.jsonl'),
    ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return root;
}
const teardown = (root) => fs.rmSync(root, { recursive: true, force: true });

test('a harness-wrapped turn with a bare date does not take the time route', () => {
  const root = build();
  try {
    // No preposition before the date, no question word anywhere — and it
    // arrives wrapped exactly the way a relayed harness turn would.
    const r = mem(root, 'find', `<task-notification>\nsession touched ${DAY}\n</task-notification>`, '--json');
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.out);
    assert.equal(j.window, undefined, `took the time route: ${r.out.slice(0, 200)}`);
  } finally { teardown(root); }
});

test('POSITIVE CONTROL: the same date, asked as a real question, DOES take the time route', () => {
  const root = build();
  try {
    const r = mem(root, 'find', `on ${DAY} from 00:00 to 23:59`, '--json');
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.out);
    assert.ok(j.window, `did not take the time route: ${r.out.slice(0, 200)}`);
    assert.equal(j.window.label.startsWith(DAY), true, j.window.label);
  } finally { teardown(root); }
});

test('a bare date with no preposition and no question word does not take the time route either (unwrapped)', () => {
  const root = build();
  try {
    const r = mem(root, 'find', `deploy notes ${DAY}`, '--json');
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.out);
    assert.equal(j.window, undefined, `took the time route on a bare mention: ${r.out.slice(0, 200)}`);
  } finally { teardown(root); }
});

test('POSITIVE CONTROL: a relative time word alone is enough, no date needed', () => {
  const root = build();
  try {
    const r = mem(root, 'find', 'what happened last week', '--json');
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.out);
    assert.ok(j.window, `did not take the time route: ${r.out.slice(0, 200)}`);
  } finally { teardown(root); }
});

test('the time-window JSON branch honours --top instead of always up to 20', () => {
  const root = build();
  try {
    const full = mem(root, 'find', `on ${DAY} from 00:00 to 23:59`, '--json');
    assert.equal(JSON.parse(full.out).hits.length, 5, 'sanity: all five entries are in the window');
    const capped = mem(root, 'find', `on ${DAY} from 00:00 to 23:59`, '--top', '2', '--json');
    assert.equal(JSON.parse(capped.out).hits.length, 2, capped.out);
  } finally { teardown(root); }
});

test('--journal-session books the time-routed turn (same as the ranked lane)', () => {
  const root = build();
  try {
    const r = mem(root, 'find', `on ${DAY} from 00:00 to 23:59`, '--top', '3',
      '--journal-session', 's-time-1', '--journal-min', '5', '--json');
    assert.equal(r.code, 0, r.out);
    const j = readInjection(root);
    assert.equal(j.present, true, 'no injection journal was written');
    const line = j.lines.find((l) => l.session === 's-time-1');
    assert.ok(line, 'no journal line for this session');
    assert.equal(line.occasion, 'question');
    assert.equal(line.reason, null, 'a non-empty window should count as shown, not too-weak/empty');
    assert.equal(line.hits, 3);
  } finally { teardown(root); }
});
