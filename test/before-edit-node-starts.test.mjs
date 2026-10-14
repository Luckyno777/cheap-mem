// hooks-harden-cm / TB5 — how many node processes does ONE before-edit run start?
//
// Measured 2026-10-14 on the old hook (bash, e98bf2d; Linux 6.18, 4 cores,
// Node 22.22): 14 node starts and a median of 852 ms (7 runs) for one Edit
// with a hit. The hook fires on every Edit, Write and file-writing Bash call,
// so the cost lands in the middle of the work. It is ONE start now.
//
// The count is taken the same way on every platform: NODE_OPTIONS carries a
// `--require` of a tiny counter that appends a line per process, and every
// child node inherits it — no wrapper script on PATH, no /tmp, no POSIX tool.
// The number is a ratchet: it is allowed to fall, never to grow again.
//
// RED PROOF (the old hook, kept as test/fixture/before-edit-v1/, runs through
// the same counter and must be far over the limit) and POSITIVE CONTROL (the
// counter really sees a plain `node -e 0`; a hook copy with ONE extra node
// start is over the limit) are part of the file.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './temp-dir.mjs';
import { waitForRebuildIdle } from '../src/component-table.mjs';
import * as memory from '../src/memory.mjs';
import { REPO, OLD_HOOK_TEXT, toolDir } from './fixture/before-edit-old.mjs';

const MEM = path.join(REPO, 'bin', 'mem');
const FILE = '/home/x/proj/install/claude-code.sh';

/** A box with no `timeout`, `gtimeout` or `perl` caps the call with a node watchdog: one start more, by design. */
const CAP_NEEDS_NODE = spawnSync('bash', ['-c', 'command -v timeout || command -v gtimeout || command -v perl'], { encoding: 'utf8' }).status !== 0;
/** The ratchet. Lower it when it falls; raising it needs a reason in this comment. */
const LIMIT = 1 + (CAP_NEEDS_NODE ? 1 : 0);

function world(t) {
  const root = tempDir('cm-bens-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  memory.logEntry(root, 'error', { class: 'unquoted-path', title: 'install/claude-code.sh does not quote the bash path', text: 'install/claude-code.sh breaks on a space' });
  return root;
}

/** The counter: one line per node process that starts with it in NODE_OPTIONS. */
function counter(t) {
  const dir = tempDir('cm-bens-cnt-', t);
  const file = path.join(dir, 'starts.txt');
  const req = path.join(dir, 'count.cjs');
  // The detached rebuild of a STALE component table (src/component-table.mjs) is a start of its own that no
  // hook can avoid when the table is stale; it carries CM_REBUILD_LOCK and is labelled, not counted.
  fs.writeFileSync(req, "require('node:fs').appendFileSync(process.env.CM_COUNT_FILE, "
    + "(process.env.CM_REBUILD_LOCK ? 'rebuild ' : 'start ') + process.argv.slice(1, 3).join(' ') + '\\n');\n");
  fs.writeFileSync(file, '');
  return {
    env: { CM_COUNT_FILE: file, NODE_OPTIONS: `--require="${req}"` },
    reset: () => fs.writeFileSync(file, ''),
    n: () => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('start ')).length, dump: () => fs.readFileSync(file, 'utf8'),
  };
}

function run(hook, root, c, input, session = 's1') {
  c.reset();
  const marks = path.join(root, '.mem', `be-${session}`);
  const r = spawnSync('bash', [hook], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...c.env, CHEAP_MEM_ROOT: root, MEM_BEFORE_EDIT_MARKS: marks, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '' },
  });
  return { starts: c.n(), seen: c.dump(), stdout: r.stdout, stderr: r.stderr };
}
const edit = (session = 's1') => ({ session_id: session, tool_name: 'Edit', tool_input: { file_path: FILE } });
const bash = (command, session = 's1') => ({ session_id: session, tool_name: 'Bash', tool_input: { command } });

/** Warm the component table, so a stale-table rebuild (one more, detached start) is not in the count. */
function warm(hook, root, c) {
  run(hook, root, c, edit('warm'));
  waitForRebuildIdle(root);
}

test('POSITIVE CONTROL: the counter sees every node process, children included', (t) => {
  const c = counter(t);
  c.reset();
  const r = spawnSync(process.execPath, ['-e', "require('node:child_process').spawnSync(process.execPath, ['-e', '0'])"],
    { env: { ...process.env, ...c.env } });
  assert.equal(r.status, 0);
  assert.equal(c.n(), 2, 'the counter did not see the parent and its child');
});

test('RED PROOF: the old hook took many starts for one Edit with a hit', (t) => {
  const root = world(t);
  const c = counter(t);
  const old = toolDir(t, fs.readFileSync(OLD_HOOK_TEXT, 'utf8'));
  warm(old, root, c);
  const a = run(old, root, c, edit('red'));
  waitForRebuildIdle(root);
  assert.match(a.stdout, /memory knows install\/claude-code\.sh/, 'the probe must see a block, else the count belongs to a different path');
  assert.ok(a.starts >= 10, `the old hook took only ${a.starts} starts — the red proof no longer holds`);
});

test('one Edit with a hit, the pointer on the next one, and a miss: at most the limit', (t) => {
  const root = world(t);
  const c = counter(t);
  const hook = toolDir(t, fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8'), { core: true });
  warm(hook, root, c);
  const hit = run(hook, root, c, edit('a'));
  assert.match(hit.stdout, /memory knows install\/claude-code\.sh/);
  assert.ok(hit.starts >= 1, 'the counter saw no start at all — the probe is blind');
  assert.ok(hit.starts <= LIMIT, `a hit took ${hit.starts} node starts (limit ${LIMIT}):\n${hit.seen}`);
  const again = run(hook, root, c, edit('a'));
  assert.match(again.stdout, /already injected/);
  assert.ok(again.starts <= LIMIT, `the pointer took ${again.starts} node starts (limit ${LIMIT})`);
  const miss = run(hook, root, c, { session_id: 'm', tool_name: 'Write', tool_input: { file_path: '/home/x/proj/src/never-mentioned.mjs' } });
  assert.equal(miss.stdout, '');
  assert.ok(miss.starts <= LIMIT, `a miss took ${miss.starts} node starts (limit ${LIMIT})`);
});

test('Bash: no write starts no node at all; a write starts one', (t) => {
  const root = world(t);
  const c = counter(t);
  const hook = toolDir(t, fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8'), { core: true });
  warm(hook, root, c);
  const none = run(hook, root, c, bash('cat install/claude-code.sh 2>&1 >/dev/null', 'b1'));
  assert.equal(none.stdout, '');
  assert.equal(none.starts, 0, 'the text prefilter must leave before any node start');
  const write = run(hook, root, c, bash('printf x | tee install/claude-code.sh', 'b2'));
  assert.match(write.stdout, /memory knows install\/claude-code\.sh/);
  assert.ok(write.starts >= 1 && write.starts <= LIMIT, `a writing Bash call took ${write.starts} node starts (limit ${LIMIT})`);
});

test('MUTATION: one extra node start in the hook is caught by the limit', (t) => {
  const root = world(t);
  const c = counter(t);
  const text = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  const marker = 'printf \'%s\' "$IN" | CHEAP_MEM_ROOT="$ROOT" MEM_BE_START_MS';
  assert.equal(text.split(marker).length, 2, 'the line the mutation hooks into moved (it must be there exactly once)');
  const mutated = text.replace(marker, `node -e 0 >/dev/null 2>&1\n${marker}`);
  const hook = toolDir(t, mutated, { core: true });
  warm(hook, root, c);
  const r = run(hook, root, c, edit('mut'));
  assert.match(r.stdout, /memory knows/, 'the mutated hook still works, it is only slower');
  assert.ok(r.starts > LIMIT, `${r.starts} starts: the limit would not have caught an extra start`);
});
