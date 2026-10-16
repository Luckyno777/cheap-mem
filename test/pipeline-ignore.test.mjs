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
import { RUNTIME_RULES, RUNTIME_DIRS } from '../src/trackedruntime.mjs';

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

// ---- a memory that ALREADY committed files under .pipeline/ (review: the doctor said "ok" for exactly these) ----------------------

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

// ---- the runtime paths under .mem/ (#27, B2): the same gap, found by reading what the code writes there ---------------------
//
// Folders: before-edit/ and workflow-marks/ hold JSON marks, command-guard-marks/ EMPTY files (git tracks an empty file),
// locks/ lock files with this machine's pid; the three *-turns/ folders hold `mkdir` claims (empty folders: git does not see
// them, so no dirty tree today - the rule keeps it so). Single files: derived caches, logs, lock files and state that the code
// itself calls "gitignored" / "machine-local" / "not versioned" (the reason of each is in src/trackedruntime.mjs).

const MEM_RULES = RUNTIME_RULES.filter((r) => r.rule.startsWith('.mem/'));
const specTracked = (root, spec) => git(root, 'ls-files', '--', spec).split('\n').filter(Boolean);
/** Writes the probe path: a folder rule gets two files in it, a file rule the file itself. */
function materialize(root, probe) {
  if (probe.endsWith('/')) {
    fs.mkdirSync(path.join(root, probe), { recursive: true });
    fs.writeFileSync(path.join(root, probe, 'sess__x.json'), '{}\n');
    fs.writeFileSync(path.join(root, probe, 'sess__y.warned'), '');
  } else {
    fs.mkdirSync(path.dirname(path.join(root, probe)), { recursive: true });
    fs.writeFileSync(path.join(root, probe), '{}\n');
  }
}
const dropRules = (root, rules) => fs.writeFileSync(path.join(root, '.gitignore'),
  ignoreLines(root).filter((l) => !rules.some((r) => l.trim() === r.rule)).join('\n'));

test('RUNTIME_RULES: every rule is in the .gitignore `mem init` writes and git agrees on its probe; the per-session folders of the env register are all in the table', (t) => {
  const root = memory(t);
  const lines = new Set(ignoreLines(root).map((l) => l.trim()));
  for (const r of RUNTIME_RULES) {
    assert.ok(lines.has(r.rule), `${r.rule} is in RUNTIME_RULES but has no .gitignore rule`);
    const asked = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', r.probe], { encoding: 'utf8' });
    assert.equal(asked.status, 0, `git does not ignore the probe ${r.probe} of ${r.rule}`);
    assert.ok(r.why && r.spec, `${r.rule}: a reason and a pathspec are part of the entry`);
  }
  assert.equal(new Set(RUNTIME_DIRS).size, RUNTIME_DIRS.length, 'a pathspec twice');
  const reg = fs.readFileSync(path.join(REPO, 'src', 'envregister.mjs'), 'utf8');
  const dirs = [...reg.matchAll(/'`<root>\/(\.mem\/[a-z-]+)`', 'Directory of the (?:per-session marks|once-per-turn claims)/g)].map((m) => m[1]);
  assert.ok(dirs.length >= 6, `the register scan found only ${dirs.length} folders - the probe has moved`);
  for (const d of dirs) assert.ok(RUNTIME_DIRS.includes(d), `${d} is a per-session folder of the env register, but not a runtime path`);
});

// What the code names under `.mem/` and the table does NOT cover, on purpose, with the reason. Every other `.mem/<name>` that
// src/, bin/ or install/ mention must be ignored by the rules of a fresh memory (git is asked), so a NEW file under `.mem/`
// is a red test until it is in the table or here. An entry that is covered after all, or no longer named, fails as well.
const NOT_RUNTIME = {
  'config.json': 'the memory\'s own configuration, versioned',
  'thesaurus.json': 'authored word groups of the owner',
  'answer-patterns.json': 'authored answer-check patterns of the owner',
  'answer-check-patterns.json': 'authored answer-check patterns (the name MEM_ANSWER_CHECK_PATTERNS documents)',
  'langbridge': 'authored term bridges of the owner (.tsv)',
  'rewrites.jsonl': 'the learned rewrite table: append-only, a candidate for sharing between clones - owner decides',
  'bridge-reports.jsonl': 'history of the bridge reports: per machine, but no module calls it gitignored - open',
  'raw-exclusion-state.json': 'state of the capture exclusion: no module says whether it travels - open',
  'keyring.json': 'the shred keys: a committed key survives in history and defeats the shredding - owner decides',
  'raw': 'the raw archive: tracked on purpose (src/archive.mjs)',
  'inbox': 'a false hit: the dashboard\'s list of places (`.mem`, `inbox`, `agents`)',
};
function codeFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...codeFiles(p));
    else if (/\.(mjs|sh|ps1)$/.test(e.name) || !e.name.includes('.')) out.push(p);
  }
  return out;
}

test('INVENTORY: every .mem/<name> the code mentions is ignored by a fresh memory, or listed above with a reason', (t) => {
  const root = memory(t);
  const names = new Set();
  for (const d of ['src', 'bin', 'install']) {
    for (const f of codeFiles(path.join(REPO, d))) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/'\.mem',\s*'([A-Za-z0-9_-][A-Za-z0-9._-]*)'/g)) names.add(m[1].replace(/\.$/, ''));
      for (const m of text.matchAll(/\.mem\/([A-Za-z0-9_-][A-Za-z0-9._-]*)/g)) names.add(m[1].replace(/\.$/, ''));
    }
  }
  assert.ok(names.size > 40, `the scan found only ${names.size} names - the probe has moved`);
  assert.ok(names.has('component-table.json') && names.has('watch.log') && names.has('locks'), 'POSITIVE CONTROL: the scan sees the known names');
  const open = [];
  for (const n of [...names].sort()) {
    const ignored = ['', '/x'].some((tail) => spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', `.mem/${n}${tail}`]).status === 0);
    if (!ignored) open.push(n);
  }
  const unlisted = open.filter((n) => !(n in NOT_RUNTIME));
  assert.deepEqual(unlisted, [], `named under .mem/ and neither ignored nor listed with a reason: ${unlisted.join(', ')}`);
  const stale = Object.keys(NOT_RUNTIME).filter((n) => !open.includes(n));
  assert.deepEqual(stale, [], `listed as not runtime, but now ignored or no longer named: ${stale.join(', ')}`);
});

test('a fresh memory: every .mem runtime path written, git add -A - none is tracked (positive control: ordinary files are)', (t) => {
  const root = memory(t);
  for (const r of MEM_RULES) materialize(root, r.probe);
  git(root, 'add', '-A');
  for (const r of MEM_RULES) assert.deepEqual(specTracked(root, r.spec), [], `${r.spec} is tracked`);
  assert.ok(git(root, 'ls-files').includes('.gitignore'), 'POSITIVE CONTROL: add -A does track ordinary files');
});

test('RED: without the rules git add -A tracks every one of them (so the probe above can fail)', (t) => {
  const root = memory(t);
  dropRules(root, MEM_RULES);
  for (const r of MEM_RULES) materialize(root, r.probe);
  git(root, 'add', '-A');
  for (const r of MEM_RULES) assert.ok(specTracked(root, r.spec).length > 0, `${r.spec}: the red proof has moved - nothing tracked without the rule`);
});

/** The advice, run the way a user would run it (quotes taken off, no shell): it must untrack exactly what it names. */
function runAdvice(root, command) {
  const words = [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(words.slice(0, 5), ['git', 'rm', '--cached', '-r'].concat(words[4]), `not the command shape: ${command}`);
  git(root, 'rm', '--cached', '-r', '-q', ...words.slice(4));
}

test('a memory that committed runtime paths of .mem - folders, single files and a lock: WARN with counts and ONE command, init names it, after it ok', (t) => {
  const root = memory(t);
  const hit = ['.mem/before-edit/', '.mem/component-table.json', '.mem/watch.lock', '.mem/watch.lock.d/'];
  dropRules(root, MEM_RULES);
  for (const p of hit) materialize(root, p);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'state with runtime files');
  // The doctor sees the missing rules first (the old answer), `mem init` repairs the file ...
  assert.equal(doctor.checkGitignoreEffective(root).level, 'warn');
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.match(init.stdout, new RegExp(`added ${MEM_RULES.length} missing \\.gitignore rule`));
  // ... and the files stay in the index: now the finding is the tracked one, in counts, with the exact command.
  assert.match(init.stdout, /still TRACKED \(2 in \.mem\/before-edit, 1 in \.mem\/component-table\.json, 1 in \.mem\/\*\.lock, 2 in \.mem\/\*\.lock\.d\/\*\)/);
  const f = doctor.checkGitignoreEffective(root);
  assert.equal(f.level, 'warn', JSON.stringify(f));
  assert.match(f.text, /STILL TRACKS 6 runtime file\(s\) \(2 in \.mem\/before-edit, 1 in \.mem\/component-table\.json/);
  assert.doesNotMatch(JSON.stringify(f), /\.pipeline/);
  const cmd = /`(git rm --cached -r [^`]+)`/.exec(f.advice)?.[1];
  // (the star is built from parts: slash and star side by side in a string open a block comment for the source scanners)
  const star = '*';
  assert.equal(cmd, `git rm --cached -r .mem/before-edit .mem/component-table.json '.mem/${star}.lock' '.mem/${star}.lock.d/${star}'`);
  runAdvice(root, cmd);
  git(root, 'commit', '-q', '-m', 'untrack');
  assert.equal(doctor.checkGitignoreEffective(root).level, 'good');
  assert.ok(fs.existsSync(path.join(root, '.mem', 'component-table.json')), 'the files stay on the disk');
});

test('MUTATION: a doctor that forgets the tracked check turns this very memory ok (the probe above is what catches it)', (t) => {
  const root = memory(t);
  dropRules(root, MEM_RULES.filter((r) => r.rule === '.mem/embed.json'));
  materialize(root, '.mem/embed.json');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'embed config');
  assert.deepEqual(specTracked(root, '.mem/embed.json'), ['.mem/embed.json'], 'the setup must have it tracked');
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  const asked = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', '.mem/embed.json'], { encoding: 'utf8' });
  assert.equal(asked.status, 0, 'what the old doctor asked says "ignored"');
  assert.equal(doctor.checkGitignoreEffective(root).level, 'warn', 'only the tracked check turns it into a warning');
});
