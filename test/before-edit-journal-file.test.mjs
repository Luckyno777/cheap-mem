// test/before-edit-journal-file.test.mjs - the before-edit journal line names the file and the
// tool that set the hook off (L1, port of lucky-mem `vorher-hook` 2026-10-03).
//
// Reason: without them "too weak" (the largest share of before-edit lines in the sibling house)
// could never be checked afterwards: nobody knew which file the line was about.
//
// Red proof: at a FIXED base commit the same hook run books a line without `file` and `tool`.
// Positive controls: the normaliser keeps a good relative path and drops what must never stand there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as injection from '../src/injection.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BASE = '0cec5683212e9721fdac0813f1561e50dbb6081f';

function world(t) {
  const root = tempDir('cm-be-file-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  memory.logEntry(root, 'error', { class: 'wrong-cause', title: 'src/zebra.mjs drops the last line', text: 'src/zebra.mjs loses the final newline' });
  return root;
}

function hook(codeDir, root, tool = 'Edit', file = '/work/src/zebra.mjs') {
  const r = spawnSync('bash', [path.join(codeDir, 'bin', 'mem-before-edit')], {
    input: JSON.stringify({ session_id: 's1', tool_name: tool, tool_input: { file_path: file } }),
    encoding: 'utf8', timeout: 30000, env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  return injection.read(root).lines.filter((x) => x.occasion === injection.OCCASION.BEFORE_EDIT);
}

test('the journal line of a before-edit run names the file (relative, two segments) and the tool', (t) => {
  const root = world(t);
  const lines = hook(REPO, root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].file, 'src/zebra.mjs');
  assert.equal(lines[0].tool, 'Edit');
  assert.ok(!JSON.stringify(lines[0]).includes('/work/'), 'an absolute path stands in the journal');
});

test('RED PROOF: at the base commit the same run books a line without file and tool', (t) => {
  const tmp = tempDir('cm-be-file-base-', t);
  // Pure git + fs, no `tar` (on Windows `tar` may be GNU tar, which reads `C:\...` as a remote host)
  // and a junction, not a symlink (a directory symlink needs a privilege on Windows).
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', BASE, 'bin', 'src', 'package.json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
  for (const n of names) {
    const dest = path.join(tmp, ...n.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, execFileSync('git', ['show', `${BASE}:${n}`], { cwd: REPO, maxBuffer: 1 << 28 }));
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
  const root = world(t);
  const before = hook(tmp, root);
  assert.equal(before.length, 1);
  assert.equal(before[0].file, undefined, 'the base already booked a file');
  assert.equal(before[0].tool, undefined);
});

test('a Bash command that writes a file books tool Bash and the file it writes', (t) => {
  const root = world(t);
  const r = spawnSync('bash', [path.join(REPO, 'bin', 'mem-before-edit')], {
    input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' /work/src/zebra.mjs" } }),
    encoding: 'utf8', timeout: 30000, env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  const line = injection.read(root).lines.find((x) => x.occasion === injection.OCCASION.BEFORE_EDIT);
  assert.equal(line.file, 'src/zebra.mjs');
  assert.equal(line.tool, 'Bash');
});

test('fileNormal keeps a relative path and drops absolute, parent, odd or over-long ones; other lines stay byte-identical', () => {
  assert.equal(injection.fileNormal('src/zebra.mjs'), 'src/zebra.mjs');
  assert.equal(injection.fileNormal('./src\\zebra.mjs'), 'src/zebra.mjs');
  for (const bad of ['/etc/passwd', 'C:/x/y.mjs', '../x.mjs', 'a/../b.mjs', 'a//b.mjs', 'a/b;rm.mjs', 'x'.repeat(201), '', null, 5]) {
    assert.equal(injection.fileNormal(bad), undefined, String(bad));
  }
  const plain = JSON.parse(JSON.stringify(injection.buildLine({ occasion: 'question' })));
  assert.ok(!('file' in plain) && !('tool' in plain));
  const set = JSON.parse(JSON.stringify(injection.buildLine({ occasion: 'before-edit', file: 'a/b.mjs', tool: 'Edit' })));
  assert.equal(set.file, 'a/b.mjs');
  assert.equal(set.tool, 'Edit');
  assert.ok(!('tool' in JSON.parse(JSON.stringify(injection.buildLine({ tool: 'rm -rf /' })))), 'a tool value that is no name');
});
