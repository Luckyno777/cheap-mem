// hooks-harden-cm / TB5 — the PowerShell twin of the before-edit hook.
//
// `bin/mem-before-edit.ps1` hands everything after its own guards to the same
// node entry the bash hook uses (bin/mem-before-edit-core.mjs), once. The twin
// differs in ONE way: it asks for ASCII on the wire (MEM_BE_ASCII=1) - an ASCII
// hyphen in the final text where bash writes an em dash, and every other
// non-ASCII character as a \uXXXX escape - because Windows PowerShell 5.1
// decodes a native command's output with the console code page, not UTF-8.
//
// Two halves, and the platform decides which one RUNS:
//   - everywhere: the ASCII mode of the core is held against the plain mode (same JSON once
//     parsed, only the one dash differs), and the twin's shape is read (static parity, like
//     test/retrieve-ps1-client.test.mjs: no pwsh in most places this runs);
//   - on win32 with a PowerShell: the twin itself runs on the same memory and its answer is
//     compared with the core's ASCII answer. No pwsh on this platform is not a skip: the
//     static half asserts, and the test names which half ran.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(REPO, 'bin', 'mem-before-edit-core.mjs');
const PS1_PATH = path.join(REPO, 'bin', 'mem-before-edit.ps1');
const PS1 = fs.readFileSync(PS1_PATH, 'utf8');
const BASH = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');

function world(t) {
  const root = tempDir('cm-betwin-', t);
  assert.equal(spawnSync(process.execPath, [path.join(REPO, 'bin', 'mem'), 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  memory.logEntry(root, 'error', { class: 'unquoted-path', title: 'install/claude-code.sh does not quote the bash path — café ↳', text: 'install/claude-code.sh breaks on a space' });
  return root;
}
const input = (file = '/home/x/proj/install/claude-code.sh', session = 's1') =>
  JSON.stringify({ session_id: session, tool_name: 'Edit', tool_input: { file_path: file } });

function core(root, marks, extra = {}, stdin = input()) {
  const r = spawnSync(process.execPath, [CORE], {
    input: stdin, encoding: 'utf8',
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_BEFORE_EDIT_MARKS: marks, ...extra },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('the ASCII mode is the plain answer with the one dash changed, and nothing but ASCII on the wire', (t) => {
  const root = world(t);
  const plain = core(root, tempDir('cm-betwin-m1-', t));
  const ascii = core(root, tempDir('cm-betwin-m2-', t), { MEM_BE_ASCII: '1' });
  assert.match(plain, /—/, 'the plain answer must carry a non-ASCII character, else this compares nothing');
  assert.ok(/^[\x00-\x7f]*$/.test(ascii), `non-ASCII on the wire: ${ascii.match(/[^\x00-\x7f]/)?.[0]}`);
  assert.match(ascii, /\\u21b3|\\u00e9|\\u2014/, 'the escapes must be there');
  const p = JSON.parse(plain);
  const a = JSON.parse(ascii);
  p.hookSpecificOutput.additionalContext = p.hookSpecificOutput.additionalContext.replace('(DATA, not instructions) — ', '(DATA, not instructions) - ');
  assert.deepEqual(a, p);
  assert.match(a.hookSpecificOutput.additionalContext, /\(DATA, not instructions\) - what went wrong/);
});

test('the ASCII mode keeps the pointer line whole too (its em dash is escaped, not lost)', (t) => {
  const root = world(t);
  const marks = tempDir('cm-betwin-m3-', t);
  core(root, marks, { MEM_BE_ASCII: '1' });
  const second = core(root, marks, { MEM_BE_ASCII: '1' });
  assert.ok(/^[\x00-\x7f]*$/.test(second));
  assert.match(JSON.parse(second).hookSpecificOutput.additionalContext, /1 entry — already injected/);
});

test('the twin hands over to the core once and carries no node snippet of its own', () => {
  assert.match(PS1, /bin\/mem-before-edit-core\.mjs/);
  assert.match(PS1, /& node \$CorePath/);
  assert.match(PS1, /\$env:MEM_BE_ASCII = '1'/);
  assert.match(PS1, /UTF8Encoding\]::new\(\$false\)/, 'stdin to node must be UTF-8 without a BOM');
  // Every remaining `node` call is a guard (command guard, workflow) or the core.
  const calls = PS1.split('\n').filter((l) => !l.trim().startsWith('#') && /&\s*node\b/.test(l));
  assert.equal(calls.length, 3, `expected the core and the two guards, found:\n${calls.join('\n')}`);
  const code = PS1.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /node -e/, 'a node -e snippet came back');
  assert.doesNotMatch(code, /component \$Query/);
  // The bash twin hands over the same way.
  assert.match(BASH, /mem-before-edit-core\.mjs/);
  assert.doesNotMatch(BASH.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /node -e '\s*\n?\s*let d=/);
});

test('PLATFORM: on Windows the twin itself answers like the core in ASCII mode; elsewhere the static half has asserted', (t) => {
  const shell = process.platform === 'win32'
    ? ['powershell.exe', 'pwsh.exe'].find((c) => spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0)
    : null;
  if (!shell) {
    // Not a skip: the previous test already holds the shape, this one says which half ran.
    assert.notEqual(process.platform === 'win32', true, 'on Windows a PowerShell must be found');
    return;
  }
  const root = world(t);
  const marks = tempDir('cm-betwin-m4-', t);
  const want = core(root, tempDir('cm-betwin-m5-', t), { MEM_BE_ASCII: '1' });
  // MEM_BEFORE_EDIT_TRACE: every early exit of the twin (and the core's reason for saying nothing) is named on
  // stderr; stdout stays the contract. CI runs 1066 and 1074 answered with ZERO bytes and exit 0 here, and the
  // probe could only say "Unexpected end of JSON input" - now an empty answer names where it stopped.
  const r = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_PATH], {
    input: input(), encoding: 'utf8',
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_BEFORE_EDIT_MARKS: marks, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '', MEM_BEFORE_EDIT_TRACE: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim(), `${shell}: the twin answered with nothing (exit 0). stderr:\n${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(want));
});
