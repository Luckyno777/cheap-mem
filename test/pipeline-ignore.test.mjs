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
import { RUNTIME_DIRS } from '../src/trackedruntime.mjs';

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

// ---- a memory that ALREADY committed .pipeline/* (review: the doctor said "ok" for exactly these) ----------------------

function committedBeforeTheRule(t) {
  const root = memory(t);
  fs.writeFileSync(path.join(root, '.gitignore'), ignoreLines(root).filter((l) => l.trim() !== '.pipeline/').join('\n'));
  runtimeFiles(root);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'state with the runtime files');
  assert.ok(tracked(root).includes('.pipeline/injections.jsonl'), 'the setup must have them tracked');
  return root;
}

test('RED: after `mem init` the rule is there, check-ignore says "ignored" - and the memory still tracks the files', (t) => {
  const root = committedBeforeTheRule(t);
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.match(init.stdout, /added 1 missing \.gitignore rule/);
  // What the old doctor asked: true, and no help - the files stay in the index.
  const ci = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', '.pipeline/injections.jsonl']);
  assert.equal(ci.status, 0, 'check-ignore --no-index no longer says ignored - the red proof has moved');
  assert.ok(tracked(root).length > 0, 'the files are still tracked');
  fs.appendFileSync(path.join(root, '.pipeline', 'injections.jsonl'), '{"more":1}\n');
  assert.notEqual(git(root, 'status', '--porcelain', '--untracked-files=no').trim(), '', 'a hook write turns the tree dirty');
});

test('the doctor says WARN with the exact command, `mem init` names it, and after it the finding is ok', (t) => {
  const root = committedBeforeTheRule(t);
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.match(init.stdout, /still TRACKED/);
  assert.match(init.stdout, /git rm --cached -r \.pipeline/);
  const f = doctor.checkGitignoreEffective(root);
  assert.equal(f.level, 'warn', JSON.stringify(f));
  assert.match(JSON.stringify(f), new RegExp(`STILL TRACKS ${tracked(root).length} runtime file`));
  assert.match(JSON.stringify(f), /git rm --cached -r \.pipeline/);
  // The repair, once.
  git(root, 'rm', '--cached', '-r', '-q', '.pipeline');
  git(root, 'commit', '-q', '-m', 'untrack the runtime folder');
  assert.equal(doctor.checkGitignoreEffective(root).level, 'good');
  assert.equal(tracked(root).length, 0);
  assert.ok(fs.existsSync(path.join(root, '.pipeline', 'injections.jsonl')), 'the files stay on the disk');
  const again = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.doesNotMatch(again.stdout, /still TRACKED/);
});

test('a clean memory: no hint, the finding is ok', (t) => {
  const root = memory(t);
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.doesNotMatch(init.stdout, /TRACKED/);
  assert.equal(doctor.checkGitignoreEffective(root).level, 'good');
});

// ---- the runtime folders under .mem/ (Task #27): the same gap, found by reading what the hooks write there ------------------
//
// before-edit/ and workflow-marks/ hold JSON marks, command-guard-marks/ holds EMPTY files (git tracks an empty file), locks/
// holds lock files with this machine's pid and start time. The three *-turns/ folders hold claims taken by `mkdir`
// (empty folders: git does not see them, so no dirty tree today - the rule is there so it stays so).

const MEM_RUNTIME = RUNTIME_DIRS.filter((d) => d.startsWith('.mem/'));
const trackedIn = (root, dir) => git(root, 'ls-files', dir).split('\n').filter(Boolean);
function writeUnder(root, dir) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'sess__x.json'), '{}\n');
  fs.writeFileSync(path.join(root, dir, 'sess__y.warned'), '');
}

test('RUNTIME_DIRS: every runtime folder has a rule in the .gitignore `mem init` writes, and every hook folder of the env register is in the list', (t) => {
  const rules = new Set(ignoreLines(memory(t)).map((l) => l.trim()));
  for (const d of RUNTIME_DIRS) assert.ok(rules.has(`${d}/`), `${d}/ is in RUNTIME_DIRS but has no .gitignore rule`);
  // A new "Directory of the per-session marks / once-per-turn claims" default under .mem/ must join the list (and the rule).
  const reg = fs.readFileSync(path.join(REPO, 'src', 'envregister.mjs'), 'utf8');
  const dirs = [...reg.matchAll(/'`<root>\/(\.mem\/[a-z-]+)`', 'Directory of the (?:per-session marks|once-per-turn claims)/g)].map((m) => m[1]);
  assert.ok(dirs.length >= 6, `the register scan found only ${dirs.length} folders - the probe has moved`);
  for (const d of dirs) assert.ok(RUNTIME_DIRS.includes(d), `${d} is a per-session folder of the env register, but not a runtime folder`);
  assert.ok(RUNTIME_DIRS.includes('.mem/locks'), 'the drawer lock folder');
});

test('a fresh memory: files in every .mem runtime folder, git add -A - none is tracked (positive control: the other files are)', (t) => {
  const root = memory(t);
  for (const d of MEM_RUNTIME) writeUnder(root, d);
  git(root, 'add', '-A');
  for (const d of MEM_RUNTIME) assert.deepEqual(trackedIn(root, d), [], `${d} is tracked`);
  assert.ok(git(root, 'ls-files').includes('.gitignore'), 'POSITIVE CONTROL: add -A does track ordinary files');
});

test('RED: without the rules git add -A tracks the marks, the claims inside and the locks (so the probe above can fail)', (t) => {
  const root = memory(t);
  const kept = ignoreLines(root).filter((l) => !MEM_RUNTIME.some((d) => l.trim() === `${d}/`));
  fs.writeFileSync(path.join(root, '.gitignore'), kept.join('\n'));
  for (const d of MEM_RUNTIME) writeUnder(root, d);
  git(root, 'add', '-A');
  for (const d of MEM_RUNTIME) assert.ok(trackedIn(root, d).length > 0, `${d}: the red proof has moved - nothing tracked without the rule`);
});

test('a memory that committed a .mem runtime folder: the doctor says WARN with the command for exactly the folders, init names it, after it ok', (t) => {
  const root = memory(t);
  const kept = ignoreLines(root).filter((l) => !MEM_RUNTIME.some((d) => l.trim() === `${d}/`));
  fs.writeFileSync(path.join(root, '.gitignore'), kept.join('\n'));
  writeUnder(root, '.mem/before-edit'); writeUnder(root, '.mem/locks');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'state with marks');
  // The doctor sees the missing rules first (the old answer), `mem init` repairs the file ...
  assert.equal(doctor.checkGitignoreEffective(root).level, 'warn');
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.match(init.stdout, new RegExp(`added ${MEM_RUNTIME.length} missing \\.gitignore rule`));
  // ... and the files stay in the index: now the finding is the tracked one, with the exact command.
  assert.match(init.stdout, /still TRACKED/);
  assert.match(init.stdout, /git rm --cached -r \.mem\/before-edit \.mem\/locks\b/);
  const f = doctor.checkGitignoreEffective(root);
  assert.equal(f.level, 'warn', JSON.stringify(f));
  assert.match(JSON.stringify(f), /STILL TRACKS 4 runtime file/);
  assert.match(JSON.stringify(f), /git rm --cached -r \.mem\/before-edit \.mem\/locks`/);
  assert.doesNotMatch(JSON.stringify(f), /\.pipeline/);
  git(root, 'rm', '--cached', '-r', '-q', '.mem/before-edit', '.mem/locks');
  git(root, 'commit', '-q', '-m', 'untrack');
  assert.equal(doctor.checkGitignoreEffective(root).level, 'good');
  assert.ok(fs.existsSync(path.join(root, '.mem', 'locks', 'sess__x.json')), 'the files stay on the disk');
});

test('MUTATION: a doctor that forgets the tracked check is caught by the probe above (the finding turns ok)', (t) => {
  const root = memory(t);
  fs.writeFileSync(path.join(root, '.gitignore'), ignoreLines(root).filter((l) => l.trim() !== '.mem/locks/').join('\n'));
  writeUnder(root, '.mem/locks');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'lock');
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  const asked = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', '.mem/locks/'], { encoding: 'utf8' });
  assert.equal(asked.status, 0, 'what the old doctor asked says "ignored"');
  assert.equal(doctor.checkGitignoreEffective(root).level, 'warn', 'only the tracked check turns it into a warning');
});
