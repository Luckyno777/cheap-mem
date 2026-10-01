// recall-gaps (Z-abruf 15): the before-edit hook also fires for a Bash
// command that WRITES a file — and stays silent for one that does not.
//
// **The gap.** PreToolUse was registered for Edit|Write|NotebookEdit
// only; `sed -i x install/claude-code.sh` changed the same file as an
// Edit and got no recall. lucky-mem's PreToolUse hook fires on Bash.
//
// Red proof (recorded 2026-10-01 against 0a2fe4e, the base of this
// branch): src/bashtargets.mjs does not exist there, the hook reads only
// `file_path`, so SED/TEE/REDIRECT print nothing, and both installers
// register the old matcher. The silence cases are the falsification: a
// reader that always finds "a file" would be noise on every shell call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeTargets } from '../src/bashtargets.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'bin', 'mem-before-edit');
const MEM = path.join(REPO, 'bin', 'mem');

test('writeTargets: the five write shapes', () => {
  assert.deepEqual(writeTargets("sed -i 's/a/b/' install/claude-code.sh"), ['install/claude-code.sh']);
  assert.deepEqual(writeTargets("sed -i.bak -e 's/a/b/' -e 's/c/d/' src/x.mjs src/y.mjs"), ['src/x.mjs', 'src/y.mjs']);
  assert.deepEqual(writeTargets("sed -ni 's/x/y/p' a.txt"), ['a.txt']);
  assert.deepEqual(writeTargets('echo hi > out.txt 2>&1'), ['out.txt']);
  assert.deepEqual(writeTargets('echo x>>notes.md; grep foo bar.txt'), ['notes.md']);
  assert.deepEqual(writeTargets('echo a &> all.log'), ['all.log']);
  assert.deepEqual(writeTargets('node x.js 2>&1 | tee -a logs/run.log'), ['logs/run.log']);
  assert.deepEqual(writeTargets('cp a.sh b/c.sh && mv old.mjs new.mjs'), ['b/c.sh', 'new.mjs', 'old.mjs']);
  assert.deepEqual(writeTargets("cat > src/new.mjs <<'EOF'\nconsole.log('a > b.txt');\nEOF"), ['src/new.mjs']);
});

test('writeTargets: silence where nothing readable is written', () => {
  for (const c of [
    "sed -n '1,5p' src/x.mjs",           // sed without -i reads
    'cmd >/dev/null 2>&1',                // only /dev/null and a dup
    'cp -r src build',                    // directories, no extension
    'echo $X > $S/out.tap',               // decided at run time
    "node -e 'const f=(a)=>a>b.txt'",     // inside quotes: data
    "git commit -m 'a > b.md'",           // inside quotes: data
    'sed -i "s/x/y/" ~/a.txt',            // ~ expands
    'grep -rn foo src/ | head -5',
    "echo 'unbalanced > x.txt",           // not readable: nothing
    '',
  ]) assert.deepEqual(writeTargets(c), [], c);
});

function memory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rg-bash-'));
  const r = spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'), JSON.stringify({
    id: 'e1', ts: '2026-09-07T10:00:00Z', class: 'unquoted-path', agent: 'a',
    title: 'install/claude-code.sh does not quote the bash path',
  }) + '\n');
  return root;
}

function hook(root, command, session) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '', MEM_BEFORE_EDIT_TRACE: '1' },
  });
  return { raw: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '') };
}

test('HOOK: a shell write to a known file brings the entry (sed -i, tee, redirect)', () => {
  const root = memory();
  try {
    for (const [i, c] of [
      "sed -i 's/a/b/' /home/x/proj/install/claude-code.sh",
      'printf x | tee install/claude-code.sh',
      'echo x >> install/claude-code.sh',
    ].entries()) {
      const { raw, stderr } = hook(root, c, `s${i}`);
      assert.ok(raw, `silent for: ${c}\n${stderr}`);
      assert.match(JSON.parse(raw).hookSpecificOutput.additionalContext, /unquoted-path/, c);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('HOOK: a Bash call that writes no file stays silent and starts no lookup', () => {
  const root = memory();
  try {
    const a = hook(root, 'cat install/claude-code.sh 2>&1 >/dev/null', 'q1');
    assert.equal(a.raw, '');
    assert.match(a.stderr, /exit at bash-not-a-write/, 'the bash prefilter, before any node start');
    const b = hook(root, "grep -n x install/claude-code.sh | sed 's/a/b/'", 'q2');
    assert.equal(b.raw, '');
    assert.match(b.stderr, /no-readable-path \(bash: no written file\)/);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('INSTALLERS: both register Bash for the before-edit hook, the ps1 hook reads it', () => {
  const sh = fs.readFileSync(path.join(REPO, 'install', 'claude-code.sh'), 'utf8');
  assert.match(sh, /upsertHook\('PreToolUse', 'pre-edit', 'Edit\|Write\|NotebookEdit\|Bash'\)/);
  const ps = fs.readFileSync(path.join(REPO, 'install', 'windows.ps1'), 'utf8');
  assert.match(ps, /'PreToolUse' 'cheap-mem-pre-edit\.ps1' .*'Edit\|Write\|NotebookEdit\|Bash'/);
  const hookPs = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit.ps1'), 'utf8');
  assert.match(hookPs, /src\/bashtargets\.mjs/);
  assert.match(hookPs, /writeTargets/);
});
