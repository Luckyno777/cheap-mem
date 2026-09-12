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

// ## The other end of the same variable
//
// Everything above tests the HOOK's reading of `CHEAP_MEM_ROOT`. The
// hook then calls `bin/mem`, which reads it a second time — and that
// end had no test at all.
//
// On 2026-09-12 a blanket rename of a local `ROOT` variable to `root`
// in `bin/mem` also hit the STRING `CHEAP_MEM_ROOT`, turning it into
// `CHEAP_MEM_root` in all seven places it appears there. The CLI then
// ignored the variable that 43 other files — every hook, every
// installer, every doc — set for it. `bin/mem` still worked when run
// inside the memory (the cwd walk found it), so the whole suite stayed
// green; only a hook, which runs in the SESSION's directory and not
// the memory's, was cut off. The capture hook then captured nothing,
// silently, exactly the failure mode the head of this file is about.
//
// The lesson is not "be careful with sed". It is that a variable read
// at two ends needs a test at both, and this is the second one.
test('bin/mem honours CHEAP_MEM_ROOT from a foreign cwd', () => {
  const cli = path.join(import.meta.dirname, '..', 'bin', 'mem');
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'memroot-'));
  spawnSync(process.execPath, [cli, '--root', mem, 'init'], { encoding: 'utf8' });

  // A transcript over the capture threshold, and a cwd that is NOT the
  // memory — that is how a hook runs: in the session's directory.
  const tr = path.join(mem, '..', `transcript-${path.basename(mem)}.jsonl`);
  fs.writeFileSync(tr, Array.from({ length: 200 }, (_, i) => JSON.stringify({
    type: 'assistant',
    message: { content: `line ${i}: capture root resolution across a foreign cwd ${i * 7919}` },
  })).join('\n') + '\n');
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));

  const r = spawnSync(process.execPath, [cli, 'raw-capture', '--transcript', tr], {
    cwd: foreign,
    env: { ...process.env, CHEAP_MEM_ROOT: mem },
    encoding: 'utf8',
  });
  const all = (r.stdout ?? '') + (r.stderr ?? '');

  // The effect, not the message: a capture has to exist under the
  // memory we pointed at.
  const raw = path.join(mem, 'raw');
  const captured = fs.existsSync(raw)
    && fs.readdirSync(raw, { recursive: true }).some((f) => String(f).endsWith('.jsonl.gz'));
  assert.ok(captured,
    `CHEAP_MEM_ROOT ignored — nothing captured into ${mem}. Output was:\n${all}`);
  assert.ok(fs.existsSync(path.join(mem, 'raw-record.jsonl')),
    'capture without a record');
});
