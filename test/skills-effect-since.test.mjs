// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// `mem skills effect --since`, "not measurable" and "too little data" wording
// (port of lucky-mem fd4d2eee, H7 follow-up).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as effect from '../src/skilleffect.mjs';
import * as injection from '../src/injection.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const cli = (root, args) => spawnSync(process.execPath, [MEM, ...args, '--root', root],
  { encoding: 'utf8', input: '', timeout: 40000 });

function world(t) {
  const root = tempDir('cm-skeff-since-', t);
  const init = cli(root, ['init']);
  assert.equal(init.status, 0, init.stderr);
  // One skill id, offered on two days (ids need not exist in the registry).
  for (const ts of ['2026-09-20T10:00:00Z', '2026-10-02T10:00:00Z']) {
    injection.book(root, { ts, session: 'sess-a', occasion: injection.OCCASION.SKILL_OFFER, sources: ['k1'] });
  }
  return root;
}

test('since: offers before the date do not count (positive control: without it both count)', (t) => {
  const root = world(t);
  assert.equal(effect.measure(root).skills[0].offered, 2);
  const late = effect.measure(root, { since: new Date('2026-10-01T00:00:00Z') });
  assert.equal(late.skills[0].offered, 1);
  assert.equal(late.since, '2026-10-01T00:00:00.000Z');
  assert.equal(effect.measure(root, { since: new Date('2027-01-01T00:00:00Z') }).state, 'empty');
});

test('text: "too little data" instead of "unknown", "not measurable" instead of "unobserved"', (t) => {
  const root = world(t);
  const txt = effect.asText(effect.measure(root));
  assert.match(txt, /too little data/);
  assert.match(txt, /not measurable/);
  assert.doesNotMatch(txt, /unobserved/);
  assert.match(effect.asText(effect.measure(root, { since: new Date('2026-10-01T00:00:00Z') })), /since 2026-10-01T00:00:00\.000Z/);
});

test('CLI: --since takes a date, rejects nonsense and a bare flag', (t) => {
  const root = world(t);
  const ok = cli(root, ['skills', 'effect', '--since', '2026-10-01', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).skills[0].offered, 1);
  const none = cli(root, ['skills', 'effect', '--since', '2027-01-01', '--json']);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(JSON.parse(none.stdout).state, 'empty');
  const bad = cli(root, ['skills', 'effect', '--since', 'nonsense']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--since needs a date/);
  const bare = cli(root, ['skills', 'effect', '--since']);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /--since needs a date/);
});
