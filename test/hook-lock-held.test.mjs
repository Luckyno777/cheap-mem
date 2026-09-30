// K2: an externally held drawer/keyring lock must not crash a hook or
// cost it its output. Finding (2026-09-30): NO hook path takes a lock —
// find/component/today/context/doctor --alarm/raw-capture/checkStop/
// stopReport/hookResult only read or append the journal lines
// (`appendLine`, no lock); `logEntry`/`putKey`/`archiveOldest` are
// reached only from `mem log`/`mem archive`-style commands, never from
// bin/mem-* or install/hooks/*. This test is the guard for that finding:
// hold every lock, run every hook, compare with the run without locks.
// Positive control: the held lock IS seen as held (withLock times out).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock, LockTimeoutError } from '../src/filelock.mjs';
import * as memory from '../src/memory.mjs';
import * as shred from '../src/shred.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const bin = (n) => path.join(CODE, 'bin', n);

function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hooklock-'));
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  execFileSync('node', [MEM, '--root', root, 'log', 'error',
    '--title', 'lockfile race - two runs overwrote it',
    '--text', 'the sperrdatei-rennen probe failed because two test runs overwrote the same lock file at once',
    '--class', 'race', '--file', 'src/filelock.mjs'], { stdio: 'ignore' });
  return root;
}

function holdAll(root) {
  const held = [];
  const put = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${process.pid} h ${new Date().toISOString()} tok\n`); held.push(p); };
  for (const type of Object.keys(memory.TYPES)) put(memory.drawerLockPath(root, type));
  put(shred.keyringLockPath(root));
  return held;
}

const bash = (script, input, root) => spawnSync('bash', [script], {
  input, encoding: 'utf8', timeout: 40000,
  env: {
    ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_STOP_ROOTS: root, MEM_STOP_NO_PUSH: '1',
    MEM_RETRIEVE_MIN: '0.1', MEM_RETRIEVE_NO_PULL: '1', MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '', MEM_CATCH_FAIL_OFF: '', MEM_BEFORE_EDIT_MARKS: path.join(root, '.mem', 'marks'),
    MEM_AFTER_FAILURE_TURNS: path.join(root, '.mem', 'aft'),
  },
});

const RED = 'TAP version 13\nnot ok 2 - lockfile race: two runs overwrote the lock file\n# tests 2\n# pass 1\n# fail 1\n';
const HOOKS = {
  'mem-retrieve': [bin('mem-retrieve'), JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'the lockfile race where two test runs overwrote the same lock file' })],
  'mem-before-edit': [bin('mem-before-edit'), JSON.stringify({ session_id: 's1', tool_name: 'Edit', tool_input: { file_path: 'src/filelock.mjs' } })],
  'mem-catch-fail': [bin('mem-catch-fail'), JSON.stringify({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: RED, stderr: '' } })],
  'mem-after-failure': [bin('mem-after-failure'), JSON.stringify({ session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'lockfile race: two runs overwrote the same lock file' })],
  'mem-stop': [bin('mem-stop'), JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false })],
  'mem-subagent-start': [bin('mem-subagent-start'), JSON.stringify({ session_id: 's1', hook_event_name: 'SubagentStart', agent_type: 'general-purpose' })],
  'session-start.sh': [path.join(CODE, 'install', 'hooks', 'session-start.sh'), ''],
};

test('positive control: the held lock is seen as held', () => {
  const root = build();
  try {
    holdAll(root);
    assert.throws(() => withLock(memory.drawerLockPath(root, 'error'), () => {}, { waitMs: 200, staleS: 120 }), LockTimeoutError);
    assert.throws(() => withLock(shred.keyringLockPath(root), () => {}, { waitMs: 200, staleS: 60 }), LockTimeoutError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [name, [script, input]] of Object.entries(HOOKS)) {
  test(`K2: ${name} with every lock held: exit 0, same output, no crash`, () => {
    // Two identical memories: once-per-session marks must not eat the second run.
    const rootFree = build();
    const root = build();
    try {
      const free = bash(script, input, rootFree);
      const held = holdAll(root);
      const t0 = Date.now();
      const r = bash(script, input, root);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(Date.now() - t0 < 9000, 'the hook waited on a lock');
      const norm = (o, rt) => o.split(rt).join('ROOT').replace(/\d{4}-\d\d-\d\dT[\d:]+Z/g, 'TS');
      assert.equal(norm(r.stdout, root), norm(free.stdout, rootFree), 'output differs when the locks are held');
      assert.doesNotMatch(r.stderr, /LockTimeout|ELOCKTIMEOUT/);
      for (const h of held) assert.ok(fs.existsSync(h), 'a hook removed a lock it does not own');
      if (name === 'mem-retrieve' || name === 'mem-before-edit' || name === 'mem-catch-fail') assert.ok(r.stdout, `${name} gave no output (test input too weak)`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(rootFree, { recursive: true, force: true }); }
  });
}
