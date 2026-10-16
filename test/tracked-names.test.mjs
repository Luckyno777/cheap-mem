// hooks-harden-cm / B1 - a file name out of the INDEX is never printed.
//
// `mem init` and the doctor finding `gitignore` name the runtime files a memory still tracks. The names come out of the
// index, which anybody who can commit can fill, and a legal POSIX file name can hold an escape sequence (a title
// change, a hyperlink), a bell, a newline (a forged second line of output) or a bidi override. The line goes to a
// terminal and, from a hook or the doctor, into a model's context. So the output carries folders and COUNTS only.
//
// Built at run time (nothing hostile sits in the repository). Windows: a file name cannot hold a control character there, so
// that platform asserts the refusal and runs the probe with the bidi override alone.
//
// RED: the same probe against 862d815 prints the name raw (see the CHANGELOG).
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

function git(cwd, ...a) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** What may not reach the output: C0 (but the newline between lines), DEL, C1, the bidi marks. */
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

function hostileName() {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  const rlo = String.fromCharCode(0x202e);
  return { full: `EVILNAME${esc}]0;PWNED${bel}\nFORGED-LINE${rlo}gnp.txt`, bidiOnly: `EVILNAME${rlo}gnp.txt` };
}

test('B1: a tracked runtime file with an escape, a bell, a newline and a bidi override in its name is counted, never printed', (t) => {
  const root = tempDir('cm-trkname-', t);
  git(root, 'init', '-q', '-b', 'main');
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  // The memory as it was before the rule: committed first, ignored later.
  const gi = path.join(root, '.gitignore');
  fs.writeFileSync(gi, fs.readFileSync(gi, 'utf8').split('\n').filter((l) => l.trim() !== '.pipeline/').join('\n'));
  fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pipeline', 'injections.jsonl'), '{}\n');
  const names = hostileName();
  let used = names.full;
  try {
    fs.writeFileSync(path.join(root, '.pipeline', names.full), 'x');
    assert.notEqual(process.platform, 'win32', 'win32 accepted a control character in a file name - the platform branch is wrong');
  } catch (e) {
    assert.equal(process.platform, 'win32', `a POSIX file system refused the hostile name: ${e.message}`);
    used = names.bidiOnly;
    fs.writeFileSync(path.join(root, '.pipeline', used), 'x');
  }
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'runtime files');
  // POSITIVE CONTROL: the hostile file is in the index under its real name.
  const listed = git(root, 'ls-files', '-z', '--', '.pipeline').split('\0');
  assert.ok(listed.includes(`.pipeline/${used}`), 'the setup must have the hostile name tracked');

  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  const finding = doctor.checkGitignoreEffective(root);
  assert.equal(finding.level, 'warn', JSON.stringify(finding));
  for (const [what, text] of [['mem init', init.stdout], ['doctor text', finding.text], ['doctor advice', finding.advice]]) {
    assert.doesNotMatch(text, /EVILNAME|PWNED|FORGED/, `${what}: a fragment of the file name was printed`);
    assert.doesNotMatch(text, UNSAFE, `${what}: a control or bidi character was printed`);
  }
  // What stays: the count and the folder, and the one command.
  assert.match(init.stdout, /still TRACKED \(\d+ in \.pipeline\)/);
  assert.match(finding.text, /STILL TRACKS \d+ runtime file\(s\) \(\d+ in \.pipeline\)/);
  assert.match(finding.advice, /git rm --cached -r \.pipeline`/);
  // The advice repairs it, whatever the name.
  git(root, 'rm', '--cached', '-r', '-q', '.pipeline');
  git(root, 'commit', '-q', '-m', 'untrack');
  assert.equal(doctor.checkGitignoreEffective(root).level, 'good');
});
