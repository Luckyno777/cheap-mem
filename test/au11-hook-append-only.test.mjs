// AU11 (lucky-mem parity, automation gap L11):
//  (1) the installers arm the git hook themselves: `mem init` (and `mem setup
//      claude`) set core.hooksPath in a memory that is a git repository of its
//      own, never overwrite one that is set, never touch a repository the memory
//      is merely nested in, and say so when they cannot;
//  (2) the pre-commit hook also checks APPEND-ONLY: no committed line of a memory
//      log (global/*.jsonl, projects/<p>/*.jsonl, raw-record.jsonl, digested.jsonl)
//      may be changed or deleted, new lines only at the END. A deliberate change
//      goes through with CHEAP_MEM_JSONL_APPROVAL="<reason, id>", named in the log;
//      without it the commit is refused with a rescue path; a crash of the check
//      refuses the commit.
//
// Everything in temp directories, the machine's git configuration switched off.
// Red probe: against the code before AU11 `mem init` arms nothing and the hook lets
// a changed or deleted line through; the counter-probes (append, shared/, a set
// hooksPath) hold on both states.
//
// error: 1rmp6w45nul6
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Temp directories made by this file are removed when the process ends.
const MADE = [];
process.on('exit', () => { for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); MADE.push(d); return d; };

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const ID = ['-c', 'user.name=probe', '-c', 'user.email=probe@example.test', '-c', 'commit.gpgsign=false'];

function tmp() {
  const t = mkTmp('cm-au11-');
  const gc = path.join(t, 'gitconfig-empty');
  fs.writeFileSync(gc, '');
  const env = { PATH: process.env.PATH, HOME: t, CLAUDE_HOME: path.join(t, '.claude'), GIT_CONFIG_GLOBAL: gc, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  return { t, env };
}
const sh = (env, cwd, cmd, args, input) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 60000, input });
const git = (x, cwd, ...a) => sh(x.env, cwd, 'git', [...ID, ...a]);
function gitOk(x, cwd, ...a) { const r = git(x, cwd, ...a); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
const mem = (x, cwd, ...a) => sh(x.env, cwd, 'node', [MEM, ...a]);
// The folder the installer arms, compared as the SAME folder rather than as the same text: the memory's root comes from
// the process working directory, which the system spells in its canonical form (macOS /var -> /private/var, a Windows
// 8.3 name C:\\Users\\RUNNER~1 -> runneradmin), while the test built `dir` from os.tmpdir().
const armedDir = (dir) => path.join(dir, '.mem', 'hooks');
const sameFolderAs = (actual, expected) => actual !== '' && fs.realpathSync.native(actual) === fs.realpathSync.native(expected);
const hooksPath = (x, dir) => git(x, dir, 'config', '--local', '--get', 'core.hooksPath').stdout.trim();

// --- (1) the installers arm the hook ----------------------------------

test('AU11: mem init in a git repository arms core.hooksPath and says so', () => {
  const x = tmp();
  const dir = path.join(x.t, 'm'); fs.mkdirSync(dir);
  gitOk(x, dir, 'init', '-q', '-b', 'main');
  const r = mem(x, dir, 'init');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /git hook armed/);
  assert.match(r.stdout, /Test: does the hook catch a planted token\?[\s\S]*blocked/);
  assert.ok(sameFolderAs(hooksPath(x, dir), armedDir(dir)), `core.hooksPath is ${hooksPath(x, dir)}, not the memory's .mem/hooks`);
  assert.doesNotMatch(r.stdout, /mem hooks install\s+<- do this one/);
});

test('AU11 counter-probe: without a git repository nothing is armed and the advice stays', () => {
  const x = tmp();
  const dir = path.join(x.t, 'm'); fs.mkdirSync(dir);
  const r = mem(x, dir, 'init');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /git hook armed/);
  assert.match(r.stdout, /mem hooks install\s+<- do this one/);
});

test('AU11 counter-probe: a core.hooksPath that is already set is left alone', () => {
  const x = tmp();
  const dir = path.join(x.t, 'm'); fs.mkdirSync(dir);
  gitOk(x, dir, 'init', '-q', '-b', 'main');
  gitOk(x, dir, 'config', 'core.hooksPath', '/somewhere/else');
  const r = mem(x, dir, 'init');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hooksPath(x, dir), '/somewhere/else');
  assert.match(r.stdout, /already set \(core\.hooksPath = \/somewhere\/else\)/);
});

test('AU11 counter-probe: a memory nested in a bigger repository does not change THAT repository\'s hooks', () => {
  const x = tmp();
  const outer = path.join(x.t, 'outer'); fs.mkdirSync(outer);
  gitOk(x, outer, 'init', '-q', '-b', 'main');
  const dir = path.join(outer, 'memory'); fs.mkdirSync(dir);
  const r = mem(x, dir, 'init');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hooksPath(x, outer), '', 'the outer repository was changed');
  assert.match(r.stdout, /git hook NOT armed: the memory sits inside the repository/);
});

test('AU11: running mem init again on an initialized memory arms a hook that is missing', () => {
  const x = tmp();
  const dir = path.join(x.t, 'm'); fs.mkdirSync(dir);
  assert.equal(mem(x, dir, 'init').status, 0);
  gitOk(x, dir, 'init', '-q', '-b', 'main');
  assert.equal(hooksPath(x, dir), '');
  const r = mem(x, dir, 'init');
  assert.match(r.stdout, /Already initialized/);
  assert.match(r.stdout, /git hook armed/);
  assert.ok(sameFolderAs(hooksPath(x, dir), armedDir(dir)), `core.hooksPath is ${hooksPath(x, dir)}, not the memory's .mem/hooks`);
});

// --- (2) the append-only check -----------------------------------------

/** An initialized, hook-armed memory with a committed log of three lines and a tool table. */
function armedMemory() {
  const x = tmp();
  const dir = path.join(x.t, 'm'); fs.mkdirSync(dir);
  gitOk(x, dir, 'init', '-q', '-b', 'main');
  assert.equal(mem(x, dir, 'init').status, 0);
  fs.writeFileSync(path.join(dir, 'global', 'errors.jsonl'), '{"id":"a1","t":"one"}\n{"id":"a2","t":"two"}\n{"id":"a3","t":"three"}\n');
  fs.mkdirSync(path.join(dir, 'shared'));
  fs.writeFileSync(path.join(dir, 'shared', 'table.jsonl'), '{"k":1}\n{"k":2}\n');
  fs.writeFileSync(path.join(dir, 'note.md'), 'old\n');
  gitOk(x, dir, 'add', '-A');
  gitOk(x, dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); gitOk(x, dir, 'add', '-A'); };
  const commit = (extra = {}) => sh({ ...x.env, ...extra }, dir, 'git', [...ID, 'commit', '-q', '-m', 'probe']);
  return { x, dir, write, commit, log: () => fs.readFileSync(path.join(dir, 'global', 'errors.jsonl'), 'utf8') };
}

test('AU11: a new line at the end goes through (positive control: the hook runs at all)', () => {
  const m = armedMemory();
  m.write('global/errors.jsonl', `${m.log()}{"id":"a4","t":"four"}\n`);
  const c = m.commit();
  assert.equal(c.status, 0, c.stderr);
});

test('AU11: a changed committed line refuses the commit, with file, line and rescue path', () => {
  const m = armedMemory();
  m.write('global/errors.jsonl', '{"id":"a1","t":"one"}\n{"id":"a2","t":"CHANGED"}\n{"id":"a3","t":"three"}\n');
  const c = m.commit();
  assert.notEqual(c.status, 0, 'a changed line went through');
  assert.match(c.stderr, /APPEND-ONLY broken/);
  assert.match(c.stderr, /global\/errors\.jsonl: a committed line was changed or removed \(first difference at line 2, HEAD has 3 lines\)/);
  assert.match(c.stderr, /git restore --staged --worktree -- <file>/);
  assert.match(c.stderr, /CHEAP_MEM_JSONL_APPROVAL=/);
});

test('AU11: a deleted line, a deleted file: both refuse', () => {
  const m = armedMemory();
  m.write('global/errors.jsonl', '{"id":"a1","t":"one"}\n{"id":"a2","t":"two"}\n');
  assert.match(m.commit().stderr, /changed or removed/);
  fs.rmSync(path.join(m.dir, 'global', 'errors.jsonl'));
  gitOk(m.x, m.dir, 'add', '-A');
  const c = m.commit();
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /global\/errors\.jsonl: file deleted \(HEAD had 3 lines\)/);
});

test('AU11: with an approval the deliberate change passes and the log names reason and file', () => {
  const m = armedMemory();
  m.write('global/errors.jsonl', '{"id":"a1","t":"one"}\n{"id":"a3","t":"three"}\n');
  const c = m.commit({ CHEAP_MEM_JSONL_APPROVAL: 'redaction of a2, approved by the owner 2026-10-12' });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, /append-only deliberately broken, approval: redaction of a2, approved by the owner 2026-10-12/);
  assert.match(c.stderr, /global\/errors\.jsonl/);
});

test('AU11 counter-probe: a blank approval does not count', () => {
  const m = armedMemory();
  m.write('global/errors.jsonl', '{"id":"a1","t":"one"}\n');
  assert.notEqual(m.commit({ CHEAP_MEM_JSONL_APPROVAL: '  ' }).status, 0);
});

test('AU11 counter-probe: the tool\'s own tables (shared/) and non-log files may change', () => {
  const m = armedMemory();
  m.write('shared/table.jsonl', '{"k":1}\n{"k":22}\n');
  fs.writeFileSync(path.join(m.dir, 'note.md'), 'new\n');
  gitOk(m.x, m.dir, 'add', '-A');
  const c = m.commit();
  assert.equal(c.status, 0, c.stderr);
});

test('AU11 counter-probe: a NEW log file passes', () => {
  const m = armedMemory();
  m.write('projects/p/errors.jsonl', '{"id":"n1"}\n');
  assert.equal(m.commit().status, 0);
});

test('AU11: the rule is also applied to a project log and to raw-record.jsonl', () => {
  const m = armedMemory();
  m.write('projects/p/errors.jsonl', '{"id":"p1"}\n{"id":"p2"}\n');
  m.write('raw-record.jsonl', '{"path":"raw/x"}\n');
  assert.equal(m.commit().status, 0);
  m.write('projects/p/errors.jsonl', '{"id":"p1"}\n{"id":"p2x"}\n');
  fs.writeFileSync(path.join(m.dir, 'raw-record.jsonl'), '');
  gitOk(m.x, m.dir, 'add', '-A');
  const c = m.commit();
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /projects\/p\/errors\.jsonl/);
  assert.match(c.stderr, /raw-record\.jsonl/);
});

test('AU11: if the check itself crashes, the commit is refused (nothing printed + exit != 0 is not "fine")', () => {
  const m = armedMemory();
  // The hook calls the package's hooks/append-only.mjs; a copy of the package with a crashing one:
  const pkg = path.join(m.x.t, 'pkg');
  fs.cpSync(path.join(REPO, 'hooks'), path.join(pkg, 'hooks'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'hooks', 'append-only.mjs'), 'process.exit(2);\n');
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"type":"module"}\n');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
  m.write('global/errors.jsonl', `${m.log()}{"id":"a4"}\n`);
  const c = sh({ ...m.x.env, CHEAP_MEM_PKG: pkg }, m.dir, 'bash', [path.join(pkg, 'hooks', 'pre-commit')]);
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /append-only check did not finish/);
});

test('AU11: the doctor finding append-only-git and the hook share ONE rule (src/appendonly.mjs)', () => {
  const doctor = fs.readFileSync(path.join(REPO, 'src', 'doctor.mjs'), 'utf8');
  assert.match(doctor, /appendonly\.onlyAppended\(/);
  assert.doesNotMatch(doctor, /current\.startsWith\(committedLf\)/, 'the doctor still carries its own copy of the rule');
});

test('AU11: mem setup claude arms the memory\'s git hook as well (installer, not advice)', () => {
  const x = tmp();
  const dir = path.join(x.t, 'm'); fs.mkdirSync(dir);
  assert.equal(mem(x, dir, 'init').status, 0);          // not a git repository yet: nothing armed
  gitOk(x, dir, 'init', '-q', '-b', 'main');
  assert.equal(hooksPath(x, dir), '');
  const r = mem(x, dir, 'setup', 'claude');
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /git hook armed/);
  assert.ok(sameFolderAs(hooksPath(x, dir), armedDir(dir)), `core.hooksPath is ${hooksPath(x, dir)}, not the memory's .mem/hooks`);
  assert.ok(fs.existsSync(path.join(x.t, '.claude', 'settings.json')), 'the installer did not run in the temp home');
});

// --- merge commits (MERGE_HEAD): union merges reorder lines but lose none -----

const jl = (...ids) => ids.map((i) => `{"id":"${i}"}`).join('\n') + '\n';

/**
 * A README conflict AND a union merge of a log in the same merge. With this order of lines (this side
 * appends O1,X; the other side appends T1,C,X) git puts T1,C BEFORE this side's last X: HEAD is no
 * byte prefix any more, no line was lost (the shape of the sibling's real cases 787da554a, 236fb06a9, 63658be1f).
 */
function mergeSetup() {
  const x = tmp();
  const dir = path.join(x.t, 'm'); fs.mkdirSync(dir);
  gitOk(x, dir, 'init', '-q', '-b', 'main');
  assert.equal(mem(x, dir, 'init').status, 0);
  const w = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
  w('global/errors.jsonl', jl('B', 'Y', 'A')); w('README.md', 'base\n');
  gitOk(x, dir, 'add', '-A'); gitOk(x, dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  gitOk(x, dir, 'checkout', '-q', '-b', 'side');
  w('global/errors.jsonl', jl('B', 'Y', 'A', 'O1', 'X')); w('README.md', 'side\n');
  gitOk(x, dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'side');
  gitOk(x, dir, 'checkout', '-q', 'main');
  w('global/errors.jsonl', jl('B', 'Y', 'A', 'T1', 'C', 'X')); w('README.md', 'main\n');
  gitOk(x, dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'main');
  gitOk(x, dir, 'checkout', '-q', 'side');
  assert.ok(sameFolderAs(hooksPath(x, dir), armedDir(dir)), `precondition: \`mem init\` armed the hook (core.hooksPath is '${hooksPath(x, dir)}')`);
  const m = git(x, dir, 'merge', '--no-commit', 'main');
  assert.notEqual(m.status, 0, 'precondition: the merge stops at the README');
  w('README.md', 'resolved\n'); gitOk(x, dir, 'add', 'README.md');
  const head = gitOk(x, dir, 'show', 'HEAD:global/errors.jsonl');
  assert.ok(!fs.readFileSync(path.join(dir, 'global', 'errors.jsonl'), 'utf8').startsWith(head), 'precondition: HEAD is NO byte prefix of the united file');
  return { x, dir, w };
}

test('AU11 merge: a union merge (no prefix, nothing lost) goes through as a merge commit', () => {
  const m = mergeSetup();
  const c = git(m.x, m.dir, 'commit', '--no-edit');
  assert.equal(c.status, 0, c.stderr);
  const lines = gitOk(m.x, m.dir, 'show', 'HEAD:global/errors.jsonl').split('\n').filter(Boolean);
  for (const id of ['B', 'Y', 'A', 'O1', 'X', 'T1', 'C']) assert.ok(lines.includes(`{"id":"${id}"}`), `line ${id} missing`);
});

test('AU11 merge counter-probe: the same state WITHOUT MERGE_HEAD (a plain commit) is refused', () => {
  const m = mergeSetup();
  fs.rmSync(path.join(m.dir, '.git', 'MERGE_HEAD'));
  const c = git(m.x, m.dir, 'commit', '-m', 'plain');
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /changed or removed/);
});

test('AU11 merge: a line lost in the merge is refused - with the merge rescue path, not "git restore"', () => {
  const m = mergeSetup();
  const p = path.join(m.dir, 'global', 'errors.jsonl');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('{"id":"O1"}\n', ''));
  gitOk(m.x, m.dir, 'add', 'global/errors.jsonl');
  const c = git(m.x, m.dir, 'commit', '--no-edit');
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /the merge lost 1 line\(s\) of this side/);
  assert.match(c.stderr, /DURING A MERGE/);
  assert.match(c.stderr, /git merge --abort/);
  assert.match(c.stderr, /NOT 'git restore --staged --worktree'/);
});

test('AU11 merge: the multiset counts - a line HEAD holds twice that the merge leaves once is lost', () => {
  const x = tmp();
  const dir = path.join(x.t, 'm'); fs.mkdirSync(dir);
  gitOk(x, dir, 'init', '-q', '-b', 'main');
  assert.equal(mem(x, dir, 'init').status, 0);
  const w = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
  w('global/errors.jsonl', jl('A', 'D', 'D'));
  gitOk(x, dir, 'add', '-A'); gitOk(x, dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  // a (pretended) merge in progress whose result keeps D only once
  w('global/errors.jsonl', jl('D', 'A'));
  gitOk(x, dir, 'add', '-A');
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), `${gitOk(x, dir, 'rev-parse', 'HEAD')}\n`);
  const c = git(x, dir, 'commit', '--no-edit', '-m', 'merge');
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /the merge lost 1 line\(s\)/);
  // and the same file with D kept twice, only reordered, passes
  w('global/errors.jsonl', jl('D', 'A', 'D'));
  gitOk(x, dir, 'add', '-A');
  const ok = git(x, dir, 'commit', '--no-edit', '-m', 'merge');
  assert.equal(ok.status, 0, ok.stderr);
});
