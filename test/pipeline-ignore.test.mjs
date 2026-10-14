// hooks-harden-cm / M1 - the memory's .gitignore covers the whole `.pipeline/` runtime folder.
//
// The finding (review of c1ad4a9): `.pipeline/clone-gate.json` - and `.pipeline/injections.jsonl`, which has had the same gap since
// the journal exists - were in no memory's .gitignore (only `.pipeline/observations.jsonl` was). `git add -A`, which mem-reflect
// and mem-handle-post run, then TRACKS them: every hook write makes the tree dirty, the recall hook's pull stops
// ("only tracked changes count"), and two clones meet in add/add conflicts on files that describe one machine each.
//
// The folder is meant as a whole: everything the code puts there is runtime state of ONE clone (journals, verdict caches,
// the recall server's socket and key, the command-guard booklet, the cost journal, the shrink baseline - "runtime state, per
// machine", src/shrink.mjs). `writeMemoryGitignore` now writes `.pipeline/`. An existing memory gets it by `mem init` run
// again (the "already initialized" branch repairs the file, as it did for the broken-comment rules), and the doctor finding
// `gitignore` asks git about the two paths the hooks write on every call and says so, with that very command.
//
// RED: a .gitignore as the base wrote it tracks the files (the probe sees it happen); GREEN: the new one tracks nothing.
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
function memory(t) {
  const root = tempDir('cm-pipeign-', t);
  git(root, 'init', '-q', '-b', 'main');
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  return root;
}
/** What the hooks and features put under .pipeline/ - one file per feature, nested ones included. */
function runtimeFiles(root) {
  const files = ['clone-gate.json', 'injections.jsonl', 'model-cost.jsonl', 'shrink-baseline.json', 'mem-skills.md',
    'question-text-errors.jsonl', 'observations.jsonl', 'command-guard/words.txt', 'recall/key', 'running/job.json'];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, '.pipeline', f)), { recursive: true });
    fs.writeFileSync(path.join(root, '.pipeline', f), '{}\n');
  }
  return files;
}
const tracked = (root) => git(root, 'ls-files', '.pipeline').split('\n').filter(Boolean);
const ignoreLines = (root) => fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');

test('a fresh memory: init, write the runtime files, git add -A - nothing under .pipeline/ is tracked', (t) => {
  const root = memory(t);
  runtimeFiles(root);
  git(root, 'add', '-A');
  assert.deepEqual(tracked(root), []);
  assert.ok(git(root, 'ls-files').includes('.gitignore'), 'POSITIVE CONTROL: add -A does track the memory\'s ordinary files');
});

test('RED: a .gitignore as the base wrote it (no .pipeline/ rule) tracks them', (t) => {
  const root = memory(t);
  const kept = ignoreLines(root).filter((l) => l.trim() !== '.pipeline/');
  fs.writeFileSync(path.join(root, '.gitignore'), kept.join('\n'));
  runtimeFiles(root);
  git(root, 'add', '-A');
  const got = tracked(root);
  assert.ok(got.includes('.pipeline/clone-gate.json') && got.includes('.pipeline/injections.jsonl'), `the probe does not see the defect: ${got}`);
  assert.ok(!got.includes('.pipeline/observations.jsonl'), 'only the observation ledger had a line before');
});

test('an existing memory gets the rule by `mem init` again, once, and the doctor finding says so before and is green after', (t) => {
  const root = memory(t);
  fs.writeFileSync(path.join(root, '.gitignore'), ignoreLines(root).filter((l) => l.trim() !== '.pipeline/').join('\n'));
  const before = doctor.checkGitignoreEffective(root);
  assert.equal(before.level, 'warn');
  assert.match(before.detail ?? before.message ?? JSON.stringify(before), /\.pipeline\/injections\.jsonl, \.pipeline\/clone-gate\.json/);
  assert.match(JSON.stringify(before), /mem init/);
  const again = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.match(again.stdout, /added 1 missing \.gitignore rule/);
  assert.equal(doctor.checkGitignoreEffective(root).level, 'good');
  assert.equal(ignoreLines(root).filter((l) => l.trim() === '.pipeline/').length, 1);
  const third = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.match(third.stdout, /\.gitignore and merge driver are in order/, 'running it again adds nothing');
  runtimeFiles(root);
  git(root, 'add', '-A');
  assert.deepEqual(tracked(root), []);
});

test('the gate\'s cache no longer makes the clone dirty (the untracked file is ignored, the hook may pull)', (t) => {
  const root = memory(t);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'state');
  fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pipeline', 'clone-gate.json'), '{}');
  assert.equal(git(root, 'status', '--porcelain').trim(), '', 'a runtime file shows up in git status');
});

test('MUTATION: a writer that forgets the rule is caught by the first probe', (t) => {
  const root = memory(t);
  fs.writeFileSync(path.join(root, '.gitignore'), ignoreLines(root).filter((l) => l.trim() !== '.pipeline/').join('\n'));
  runtimeFiles(root);
  git(root, 'add', '-A');
  assert.notDeepEqual(tracked(root), [], 'without the rule the probe must see tracked files');
});
