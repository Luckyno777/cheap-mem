// hooks-harden-cm / round 3 - three ways the doctor finding `gitignore` and `mem init` could be wrong or silent.
//
//  1. A NEGATED pattern (`!.mem/embed.env` at the end of the file) makes `git check-ignore -v` answer WITH a source: the path was
//     matched, by a rule that re-includes it. Counted as "ignored", the rule that keeps the API keys out read green.
//  2. A tracked runtime file whose name holds a line break (or U+2028/U+2029) fell out of the glob groups (`.` does not match
//     it): "STILL TRACKS 1 runtime file(s) ()" and an advice that repairs nothing. Built at run time; Windows cannot hold a line
//     break or CR in a file name, so that platform uses U+2028 and asserts the refusal of the others.
//  3. `git ls-files` failing must be said by `mem init`, not left out of an "in order".
//
// Standalone on purpose (doctor + the CLI only): the same file runs against the base for the red proof.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as doctor from '../src/doctor.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const STAR = '*'; // a slash and a star side by side in a string open a block comment for the source scanners

function git(cwd, ...a) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function memory(t) {
  const root = tempDir('cm-giguard-', t);
  git(root, 'init', '-q', '-b', 'main');
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  return root;
}
const init = (root) => spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

test('a negated pattern that re-includes .mem/embed.env turns the finding to ERROR, not green', (t) => {
  const root = memory(t);
  assert.equal(doctor.checkGitignoreEffective(root).level, 'good', 'POSITIVE CONTROL: the fresh memory is green');
  fs.appendFileSync(path.join(root, '.gitignore'), '\n!.mem/embed.env\n');
  // The control of the control: git itself says "not ignored" for the path.
  assert.equal(spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', '.mem/embed.env']).status, 1);
  const f = doctor.checkGitignoreEffective(root);
  assert.equal(f.level, 'error', JSON.stringify(f));
  assert.match(f.text, /\.mem\/embed\.env/);
  assert.match(f.text, /API keys/);
});

test('a tracked lock file with a line break in its name stays in its group, and the advice repairs it', (t) => {
  const root = memory(t);
  const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
  fs.writeFileSync(path.join(root, '.gitignore'), lines.filter((l) => l.trim() !== `.mem/${STAR}.lock`).join('\n'));
  const names = [`.mem/EVIL\nFORGED${String.fromCharCode(27)}[2J${String.fromCharCode(0x202e)}.lock`, '.mem/CR\rLINE.lock', `.mem/LS${String.fromCharCode(0x2028)}PS${String.fromCharCode(0x2029)}.lock`];
  const made = [];
  for (const n of names) {
    try { fs.writeFileSync(path.join(root, n), 'x'); made.push(n); } catch (e) {
      assert.equal(process.platform, 'win32', `a POSIX file system refused ${JSON.stringify(n)}: ${e.message}`);
    }
  }
  assert.ok(made.length >= 1, 'no hostile name could be made');
  // The second glob spec: a file inside a lock directory, with a line break in its name (the rule for lock directories is dropped too).
  fs.writeFileSync(path.join(root, '.gitignore'), fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').filter((l) => l.trim() !== `.mem/${STAR}.lock.d/`).join('\n'));
  const inner = `.mem/NL.lock.d/in${String.fromCharCode(0x2028)}side`;
  const innerNl = '.mem/NL.lock.d/in\nside';
  fs.mkdirSync(path.join(root, '.mem', 'NL.lock.d'), { recursive: true });
  let dMade = 0;
  for (const n of [inner, innerNl]) {
    try { fs.writeFileSync(path.join(root, n), 'x'); dMade += 1; } catch (e) { assert.equal(process.platform, 'win32', e.message); }
  }
  assert.ok(dMade >= 1);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'locks');
  assert.equal(git(root, 'ls-files', '-z').split('\0').filter((x) => x.endsWith('.lock') || x.includes('.lock.d/')).length, made.length + dMade, 'POSITIVE CONTROL: they are tracked');
  const out = init(root).stdout;
  const f = doctor.checkGitignoreEffective(root);
  assert.equal(f.level, 'warn', JSON.stringify(f));
  for (const [what, text] of [['mem init', out], ['text', f.text], ['advice', f.advice]]) {
    assert.doesNotMatch(text, /EVIL|FORGED|CR.LINE|NL\.lock/, `${what}: a fragment of a name`);
    assert.doesNotMatch(text.replace(/\n/g, ' '), UNSAFE, `${what}: a control or bidi character`);
  }
  assert.match(f.text, new RegExp(`STILL TRACKS ${made.length + dMade} runtime file\\(s\\) \\(${made.length} in \\.mem/\\${STAR}\\.lock, ${dMade} in \\.mem/\\${STAR}\\.lock\\.d/\\${STAR}\\)`), f.text);
  assert.doesNotMatch(f.text, /\(\)/, 'an empty group list');
  assert.match(out, new RegExp(`${made.length} in \\.mem/\\${STAR}\\.lock, ${dMade} in`));
  // The shell sentence belongs to a quoted command.
  assert.match(f.advice, /bash or PowerShell \(cmd\.exe does not take single quotes\)/);
  assert.match(out, /bash or PowerShell/);
  const cmd = /`(git rm --cached -r [^`]+)`/.exec(f.advice)?.[1];
  assert.equal(cmd, `git rm --cached -r '.mem/${STAR}.lock' '.mem/${STAR}.lock.d/${STAR}'`);
  // Run the advice the way a user would (quotes off, no shell): it untracks all of them.
  const words = [...cmd.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
  git(root, 'rm', '--cached', '-r', '-q', ...words.slice(4));
  git(root, 'commit', '-q', '-m', 'untrack');
  assert.equal(doctor.checkGitignoreEffective(root).level, 'good');
});

test('mem init says so when git cannot list the index, never a quiet "in order"', (t) => {
  const root = memory(t);
  assert.doesNotMatch(init(root).stdout, /unknown/, 'POSITIVE CONTROL: a sound repository says nothing');
  fs.writeFileSync(path.join(root, '.git', 'index'), 'this is not an index');
  const out = init(root).stdout;
  assert.match(out, /tracked runtime files: unknown/);
  // Not a git repository at all: nothing is tracked, nothing to say.
  const plain = tempDir('cm-giguard-plain-', t);
  const first = spawnSync(process.execPath, [MEM, 'init', '--root', plain], { encoding: 'utf8', input: '' });
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(init(plain).stdout, /unknown/);
});
