// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/guard-duty-addressee.test.mjs — `mem guard run --duty` writes the addressee into the field the readers know.
//
// **The finding (card-core-cm, from the H11 inventory 2026-10-13).** `mem guard run --duty` wrote `owed_to: 'owner'`. No reader of a
// duty knows `owed_to` (they read `who ?? owner ?? to`), and `owner` is a role, not a participant: the duty sat in the store and
// never showed up for anyone ("duties without a known owner"). The same mistake as `wem` in the sibling house.
//
// **The fix.** The duty carries `who: <the configured human participant>` (no name in the code, design commitment 3); with no
// human configured it is written without an addressee, and the command says so.
//
// Red proof: on the basis 2bb9889 the first probe fails (the duty is in the store, `decisionsForHuman` does not list it, and the
// line has `owed_to`). Positive controls: a duty written by hand with `who` is listed; the old field name is gone from the line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as today from '../src/today.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const cli = (root, args) => spawnSync(process.execPath, [MEM, ...args, '--root', root], { encoding: 'utf8', input: '', timeout: 40000, env: { ...process.env, CHEAP_MEM_AGENT: 'builder-x' } });

function worldWithRedLatch(t) {
  const root = tempDir('cm-guardduty-', t);
  assert.equal(cli(root, ['init']).status, 0);
  fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'), `${JSON.stringify({
    id: 'er0001abc', ts: '2026-10-01T00:00:00Z', class: 'race', title: 'A race', guard: { kind: 'file-there', path: 'missing-file.txt' },
  })}\n`);
  return root;
}

test('the duty raised by `guard run --duty` shows up for the human participant', (t) => {
  const root = worldWithRedLatch(t);
  const r = cli(root, ['guard', 'run', '--duty']);
  assert.match(r.stdout, /1 duty\/duties raised/, r.stdout + r.stderr);
  const duties = memory.readLog(root, 'duty').entries;
  assert.equal(duties.length, 1);
  assert.equal(duties[0].who, 'user', JSON.stringify(duties[0]));
  assert.ok(!('owed_to' in duties[0]), 'the field no reader knows is still written');
  const d = today.decisionsForHuman(root);
  assert.equal(d.readable, true);
  assert.deepEqual(d.list.map((x) => x.id), [duties[0].id], 'the duty does not show up for its addressee');
  assert.match(d.list[0].title, /Latch red: race/);
});

test('without a human participant the duty is written without an addressee, and the command says so', (t) => {
  const root = worldWithRedLatch(t);
  const cfgPath = path.join(root, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.participants = { session: 'any session', librarian: 'the curator' };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = cli(root, ['guard', 'run', '--duty']);
  assert.match(r.stderr, /no participant is marked "human": true/);
  const [duty] = memory.readLog(root, 'duty').entries;
  assert.ok(duty && !('who' in duty) && !('owed_to' in duty), JSON.stringify(duty));
});

test('positive control: a duty written with `who` for the human is listed (the probe can see a listed duty)', (t) => {
  const root = tempDir('cm-guardduty-pc-', t);
  assert.equal(cli(root, ['init']).status, 0);
  assert.equal(cli(root, ['log', 'duty', '--title', 'By hand', '--who', 'user']).status, 0);
  assert.equal(today.decisionsForHuman(root).list.length, 1);
});
