// A hook with a baked-in absolute path is dead on the second machine —
// and dead SILENTLY, which is the part that costs.
//
// **The finding (2026-09-08, second machine.)** The installer wrote the
// first machine's path into the generated hook. On the second one that
// directory does not exist, so the hook fell through its own guard and
// exited 0. No memory, no error, no clue: a session that had lost its
// memory looked exactly like a session that never had one.
//
// The rule this encodes: `MEM_HOOK_OFF=1` is the ONLY silent exit,
// because that one is a decision somebody made on purpose. Every other
// way of not loading the memory has to say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = path.join(import.meta.dirname, '..', 'install', 'hooks', 'session-start.sh');

// `spawnSync`, not `execFileSync`: the hook exits 0 even when it has
// nothing to load (a missing memory must not kill the session), and
// execFileSync hands back only stdout on success — so the message,
// which goes to stderr, was invisible to the first version of this
// helper. The test then failed for a reason that had nothing to do
// with the hook.
function lauf(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hookhome-'));
  const r = spawnSync('sh', [HOOK], {
    env: { PATH: process.env.PATH, HOME: home, ...env },
    encoding: 'utf8',
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status };
}

function memoryAt(dir) {
  fs.mkdirSync(path.join(dir, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.mem', 'config.json'), '{}');
  return dir;
}

test('a dead CHEAP_MEM_ROOT is reported, not swallowed', () => {
  const tot = path.join(os.tmpdir(), 'gibt-es-nicht-' + Date.now());
  const { out, err } = lauf({ CHEAP_MEM_ROOT: tot });
  const alles = out + err;
  assert.match(alles, /no memory found/,
    'the hook exited without saying the memory was missing');
  // And it must name the path it was given — "not found" without the
  // path is a message nobody can act on.
  assert.ok(alles.includes(tot), 'the dead path is not named in the message');
  assert.match(alles, /Fix:/, 'no way out is offered');
});

test('an unset CHEAP_MEM_ROOT is reported too', () => {
  const { out, err } = lauf({});
  assert.match(out + err, /CHEAP_MEM_ROOT is not set/);
});

test('a memory in a conventional place is found without CHEAP_MEM_ROOT', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hookhome-'));
  memoryAt(path.join(home, 'my-memory'));
  const r = spawnSync('sh', [HOOK], {
    env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8',
  });
  assert.match((r.stdout ?? '') + (r.stderr ?? ''), /cheap-mem attached/,
    'the fallback lookup did not find $HOME/my-memory');
});

test('MEM_HOOK_OFF stays the one silent exit', () => {
  const { out, err } = lauf({ MEM_HOOK_OFF: '1', CHEAP_MEM_ROOT: '/nope' });
  assert.equal((out + err).trim(), '',
    'an explicit opt-out must not print anything');
});
