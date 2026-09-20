// Two modules append to disk. These are the commands that can show what
// they wrote.
//
// **Why this file exists.** `test/no-log-without-reader.test.mjs` caught
// both `src/chain.mjs` and `src/shardarchive.mjs` appending with nothing
// in the CLI able to read them back. The chain was the sharper case:
// `integrity.scanIntegrity` already COMPUTED the chain verdict on every
// call and every caller discarded it, so the memory could know it had
// been tampered with and no command would say so.
//
// That is the third time in one session that a finished, green-tested
// defence turned out to have no reach. A guard caught it; these tests
// keep it caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as memory from '../src/memory.mjs';
import * as chain from '../src/chain.mjs';

const MEM = path.join(import.meta.dirname, '..', 'bin', 'mem');
const run = (root, args) => execFileSync(process.execPath, [MEM, ...args, '--root', root],
  { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: root } });

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cli-chain-'));
  execFileSync(process.execPath, [MEM, 'init'], { env: { ...process.env, CHEAP_MEM_ROOT: root } });
  return root;
}

test('mem chain says UNKNOWN over an unsealed memory, not clean', () => {
  const root = freshRoot();
  try {
    memory.logEntry(root, 'learning', { title: 'a', text: 'b' });
    const out = run(root, ['chain']);
    assert.match(out, /0 seal\(s\) found/, out);
    // The load-bearing sentence. An unsealed memory cannot say it was
    // not tampered with, and must not imply it.
    assert.match(out, /honest unknown, not a clean bill of health/, out);
    assert.doesNotMatch(out, /^ok\b/m, `an unsealed memory reported itself ok:\n${out}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem chain reports a sealed writer, and names the tamper when there is one', () => {
  const root = freshRoot();
  try {
    // **`agent`, not `author`, and the difference cost me a debugging
    // round.** The chain's writer is the AGENT identity — who ran the
    // process, from CHEAP_MEM_AGENT or `human:<user>` — not the entry's
    // `author` field. A fixture that sets `author: 'bot0'` and then
    // seals writer 'bot0' seals an empty chain: the lines were filed
    // under `human:root`, the seal covered nothing, and a tamper went
    // correctly unreported by a chain that was never over those bytes.
    //
    // The consequence worth keeping in view: writers that do not set
    // CHEAP_MEM_AGENT all share one chain. Per-writer chaining is per
    // process identity, and it is only as fine-grained as the
    // deployment makes that identity.
    for (let i = 0; i < 5; i += 1) {
      memory.logEntry(root, 'learning', { title: `t${i}`, text: `body ${i}`, agent: 'bot0' });
    }
    const p = memory.logPath(root, 'learning', null);
    chain.appendSeal(p, 'bot0');

    const clean = run(root, ['chain']);
    assert.match(clean, /1 seal\(s\) found/, clean);
    assert.match(clean, /\bok\b/, `a sealed, untouched chain did not report ok:\n${clean}`);

    // Now change a byte inside a line the seal covers.
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const idx = lines.findIndex((l) => l.includes('"body 2"'));
    assert.ok(idx >= 0, 'fixture line not found');
    lines[idx] = lines[idx].replace('body 2', 'body 2 TAMPERED');
    fs.writeFileSync(p, lines.join('\n'));

    const dirty = run(root, ['chain']);
    // `error` is the chain's own word for it. The help text says the
    // same three words the code returns, deliberately — a display
    // vocabulary that renames states is a second truth about them.
    assert.match(dirty, /^\s+error\s+bot0/m, `a tampered chain was not reported:\n${dirty}`);
    // It must say WHERE, not merely that something is wrong.
    assert.match(dirty, /broke at line \d+/, dirty);
    assert.match(dirty, /declared [0-9a-f]{16}/, dirty);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem archive does not report `good` over an empty archive', () => {
  const root = freshRoot();
  try {
    const out = run(root, ['archive']);
    // Nothing has been archived, so reachability is not a question that
    // arises — and a verdict that cannot say what it inspected does not
    // get to sound like a pass.
    assert.match(out, /Nothing archived/, out);
    assert.doesNotMatch(out, /^good:/m, `an empty archive reported good:\n${out}`);
    // And no empty slot where a number belongs.
    assert.doesNotMatch(out, /in\s+shard\(s\)/, `a count is missing from the line:\n${out}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('both commands answer --help without touching a memory', () => {
  // A command that needs a root to print its own help is a command
  // nobody can discover from outside a memory.
  for (const verb of ['chain', 'archive']) {
    const out = execFileSync(process.execPath, [MEM, verb, '--help'], { encoding: 'utf8' });
    assert.match(out, new RegExp(`mem ${verb}`), out);
  }
});

test('the chain files a line under its AGENT, not its author', () => {
  // The mistake above, as a standing probe. If these two ever become
  // the same field, this test says so rather than leaving the next
  // reader to rediscover it through a silently empty seal.
  const root = freshRoot();
  try {
    memory.logEntry(root, 'learning', { title: 'a', text: 'b', author: 'claims-to-be-bot0' });
    const p = memory.logPath(root, 'learning', null);
    chain.appendSeal(p, 'claims-to-be-bot0');
    const out = run(root, ['chain']);
    // The seal exists, and it covers nothing — the honest reading.
    assert.match(out, /1 seal\(s\) found/, out);
    assert.doesNotMatch(out, /^\s+ok\s+claims-to-be-bot0/m,
      `an author string was accepted as a writer identity:\n${out}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
