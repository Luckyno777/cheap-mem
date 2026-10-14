// hooks-harden-cm / D4 - which remote and branch do the hooks fetch and pull?
//
// The finding (2026-10-14, reproduced below): the session start fetched `origin main`, checked out `main`
// and pulled, whatever the memory said; the recall hook pulled `origin main`. A memory that lives on
// `develop` (.mem/config.json defaultBranch, the key mem-watch reads) came out of a session start on a NEW
// local `main` tracking origin/main - every later write went to the wrong branch - and the recall hook's
// background pull never brought `develop` forward.
//
// Now both ask the memory (defaultRemote / defaultBranch, else origin/main). The config is data out of a
// cloned repository: only a plain name goes to git (a `--upload-pack=...` branch is refused LOUDLY).
//
// Proofs: the old session start (fixture, as of e98bf2d) ends on `main` (RED), the new one stays on
// `develop`; a memory on `main` behaves as before (POSITIVE CONTROL: the probe sees `main` too); the
// function in bin/_portable.sh and the inline twin in install/hooks/session-start.sh agree over a table of
// configs; a hostile value starts nothing (no file appears); the recall hook's pull reaches `develop`.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const START = path.join(REPO, 'install', 'hooks', 'session-start.sh');
const START_OLD = path.join(REPO, 'test', 'fixture', 'session-start-v1.sh.txt');
const PORTABLE = path.join(REPO, 'bin', '_portable.sh');
const RETRIEVE = path.join(REPO, 'bin', 'mem-retrieve');
const sl = (p) => p.replaceAll('\\', '/');

const GIT = ['-c', 'user.email=t@example.org', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
function git(cwd, ...a) {
  const r = spawnSync('git', [...GIT, ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A remote with `main` (A) and `develop` (A+B, config says develop) or, with `onMain`, a memory whose config says main;
 * a clone of the tracked branch; returns { remote, mem, other } where `other` pushes later commits.
 */
function world(t, { branch = 'develop', config = {} } = {}) {
  const dir = tempDir('cm-trk-', t);
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', seed], { encoding: 'utf8', input: '' }).status, 0);
  const cfgPath = path.join(seed, '.mem', 'config.json');
  const cfg = { ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), defaultBranch: branch, ...config };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'A');
  git(seed, 'checkout', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(seed, 'b.txt'), 'b');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'B');
  const remote = path.join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', seed, remote);
  const mem = path.join(dir, 'mem');
  git(dir, 'clone', '-q', '-b', branch, remote, mem);
  const other = path.join(dir, 'other');
  git(dir, 'clone', '-q', '-b', 'develop', remote, other);
  return { dir, remote, mem, other };
}

function start(script, mem, home, extraEnv = {}) {
  const env = { ...process.env, CHEAP_MEM_ROOT: mem, HOME: home, USERPROFILE: home, MEM_HOOK_OFF: '', ...extraEnv };
  delete env.CHEAP_MEM_CODE;
  return spawnSync('bash', [script], { input: '', encoding: 'utf8', env, timeout: 60000 });
}
const home = (t) => path.join(tempDir('cm-trk-h-', t), 'home with space');
const mkhome = (h) => { fs.mkdirSync(h, { recursive: true }); return h; };

test('RED PROOF: the old session start moves a memory on develop to a new local main; the new one stays', (t) => {
  const w = world(t);
  assert.equal(git(w.mem, 'branch', '--show-current'), 'develop');
  assert.ok(git(w.mem, 'branch', '-r').includes('origin/main'), 'the remote has a main - else the old hook has nothing to misroute to');

  const old = start(START_OLD, w.mem, mkhome(home(t)));
  assert.equal(old.status, 0, old.stderr);
  assert.equal(git(w.mem, 'branch', '--show-current'), 'main', 'the old hook no longer misroutes - the red proof has moved');
  git(w.mem, 'checkout', '-q', 'develop');
  git(w.mem, 'branch', '-q', '-D', 'main');

  const now = start(START, w.mem, mkhome(home(t)));
  assert.equal(now.status, 0, now.stderr);
  assert.equal(git(w.mem, 'branch', '--show-current'), 'develop', 'the session start left the tracked branch');
  assert.equal(git(w.mem, 'branch', '--list', 'main'), '', 'a local main was made anyway');
  assert.match(now.stdout, /develop\s+-> FETCH_HEAD/, 'it did not fetch the tracked branch');
});

test('it brings the tracked branch forward and warns when it is behind (the AU1 text names the tracked ref)', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.other, 'c.txt'), 'c');
  git(w.other, 'add', '-A'); git(w.other, 'commit', '-q', '-m', 'C'); git(w.other, 'push', '-q', 'origin', 'develop');
  const r = start(START, w.mem, mkhome(home(t)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(w.mem, 'rev-parse', 'HEAD'), git(w.other, 'rev-parse', 'HEAD'), 'the clone did not reach the remote develop');
  assert.doesNotMatch(r.stdout, /MEMORY STATE OLD/);
  // Diverged: a local commit on top, the remote moves on -> the warning names origin/develop, not origin/main.
  fs.writeFileSync(path.join(w.mem, 'local.txt'), 'l');
  git(w.mem, 'add', '-A'); git(w.mem, 'commit', '-q', '-m', 'L');
  fs.writeFileSync(path.join(w.other, 'd.txt'), 'd');
  git(w.other, 'add', '-A'); git(w.other, 'commit', '-q', '-m', 'D'); git(w.other, 'push', '-q', 'origin', 'develop');
  const d = start(START, w.mem, mkhome(home(t)));
  assert.match(d.stdout, /MEMORY STATE OLD: 1 commits behind origin\/develop, 1 only local \(diverged\)/);
  assert.doesNotMatch(d.stdout, /origin\/main/);
});

test('POSITIVE CONTROL: a memory on main behaves as before (the probe does see main)', (t) => {
  const w = world(t, { branch: 'main' });
  assert.equal(git(w.mem, 'branch', '--show-current'), 'main');
  git(w.mem, 'checkout', '-q', '-b', 'feature');
  const r = start(START, w.mem, mkhome(home(t)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(w.mem, 'branch', '--show-current'), 'main', 'a feature-branch checkout is still put back on the tracked branch');
  assert.match(r.stdout, /main\s+-> FETCH_HEAD/);
  const old = start(START_OLD, w.mem, mkhome(home(t)));
  assert.equal(old.status, 0, old.stderr);
  assert.equal(git(w.mem, 'branch', '--show-current'), 'main');
});

test('a hostile config value starts nothing: refused with a warning, the default stands', (t) => {
  const marker = path.join(tempDir('cm-trk-x-', t), 'pwned');
  const w = world(t, { branch: 'main', config: {} });
  const cfgPath = path.join(w.mem, '.mem', 'config.json');
  const hostile = `--upload-pack=touch ${sl(marker)}`;
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), defaultBranch: hostile, defaultRemote: `--upload-pack=touch ${sl(marker)}x` }, null, 2));
  const r = start(START, w.mem, mkhome(home(t)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marker), false, 'a config value reached git as an option');
  assert.equal(fs.existsSync(`${marker}x`), false);
  assert.match(r.stdout, /WARNING: config defaultRemote '[^']*' is not a plain remote name - using origin/);
  assert.match(r.stdout, /config defaultBranch '[^']*' is not a plain branch name - using main/);
});

// ---- the function and its inline twin ------------------------------------------------------------------------

const CASES = [
  [null, ['origin', 'main', '']],
  [{}, ['origin', 'main', '']],
  [{ defaultBranch: 'develop' }, ['origin', 'develop', '']],
  [{ defaultBranch: 'release/2026.10', defaultRemote: 'upstream' }, ['upstream', 'release/2026.10', '']],
  [{ defaultBranch: 'trunk', defaultRemote: 'my-remote.2' }, ['my-remote.2', 'trunk', '']],
  [{ defaultBranch: '-x' }, ['origin', 'main', "config defaultBranch '-x' is not a plain branch name - using main"]],
  [{ defaultBranch: '/abs' }, ['origin', 'main', "config defaultBranch '/abs' is not a plain branch name - using main"]],
  [{ defaultBranch: 'a..b' }, ['origin', 'main', "config defaultBranch 'a..b' is not a plain branch name - using main"]],
  [{ defaultBranch: 'dir/' }, ['origin', 'main', "config defaultBranch 'dir/' is not a plain branch name - using main"]],
  [{ defaultBranch: 'a//b' }, ['origin', 'main', "config defaultBranch 'a//b' is not a plain branch name - using main"]],
  [{ defaultBranch: 'x.lock' }, ['origin', 'main', "config defaultBranch 'x.lock' is not a plain branch name - using main"]],
  [{ defaultBranch: 'a b' }, ['origin', 'main', "config defaultBranch 'a b' is not a plain branch name - using main"]],
  [{ defaultBranch: '$(touch x)' }, ['origin', 'main', "config defaultBranch '$(touch x)' is not a plain branch name - using main"]],
  [{ defaultRemote: '-o' }, ['origin', 'main', "config defaultRemote '-o' is not a plain remote name - using origin"]],
  [{ defaultRemote: 'a/b' }, ['origin', 'main', "config defaultRemote 'a/b' is not a plain remote name - using origin"]],
  [{ defaultRemote: '..' }, ['origin', 'main', "config defaultRemote '..' is not a plain remote name - using origin"]],
  [{ defaultRemote: 'ghost' }, ['origin', 'main', "config defaultRemote 'ghost' is not a remote of this clone - using origin"]],
  [{ defaultBranch: `${'a'.repeat(50)} b` }, ['origin', 'main', `config defaultBranch '${'a'.repeat(40)}...' is not a plain branch name - using main`]],
  [{ defaultRemote: '-o', defaultBranch: '-b' }, ['origin', 'main',
    "config defaultRemote '-o' is not a plain remote name - using origin; config defaultBranch '-b' is not a plain branch name - using main"]],
];

/** The inline twin, cut out of the installed hook, run on its own. */
function twinBlock() {
  const text = fs.readFileSync(START, 'utf8');
  const a = text.indexOf('mem_remote="origin"; mem_branch="main"; mem_track_note=""');
  const b = text.indexOf('[ -n "$mem_track_note" ] && echo');
  assert.ok(a > 0 && b > a, 'the inline twin moved - the test cannot find it');
  return text.slice(a, b);
}

test('bin/_portable.sh mem_tracked_ref and the inline twin in session-start.sh agree over a table of configs', (t) => {
  for (const [cfg, want] of CASES) {
    const dir = tempDir('cm-trk-c-', t);
    fs.mkdirSync(path.join(dir, '.mem'));
    // A git repository with two remotes: a name that is no remote of the clone is refused (N5).
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'remote', 'add', 'upstream', 'https://example.invalid/u.git');
    git(dir, 'remote', 'add', 'my-remote.2', 'https://example.invalid/m.git');
    if (cfg !== null) fs.writeFileSync(path.join(dir, '.mem', 'config.json'), JSON.stringify(cfg, null, 2));
    const fn = spawnSync('bash', ['-c', `. "${sl(PORTABLE)}"; mem_tracked_ref "${sl(dir)}"; printf '%s\\n%s\\n%s' "$mem_track_remote" "$mem_track_branch" "$mem_track_note"`], { encoding: 'utf8' });
    assert.equal(fn.status, 0, fn.stderr);
    assert.deepEqual(fn.stdout.split('\n'), want, `function, config ${JSON.stringify(cfg)}`);
    const twin = spawnSync('bash', ['-c', `CHEAP_MEM_ROOT="${sl(dir)}"\n${twinBlock()}\nprintf '%s\\n%s\\n%s' "$mem_remote" "$mem_branch" "$mem_track_note"`], { encoding: 'utf8' });
    assert.equal(twin.status, 0, twin.stderr);
    assert.deepEqual(twin.stdout.split('\n'), want, `twin, config ${JSON.stringify(cfg)}`);
  }
  // N5, outside a git repository nothing is asked and nothing fetched: the plain name stands.
  const plain = tempDir('cm-trk-c-', t);
  fs.mkdirSync(path.join(plain, '.mem'));
  fs.writeFileSync(path.join(plain, '.mem', 'config.json'), JSON.stringify({ defaultRemote: 'whatever' }));
  const np = spawnSync('bash', ['-c', `. "${sl(PORTABLE)}"; mem_tracked_ref "${sl(plain)}"; printf '%s|%s' "$mem_track_remote" "$mem_track_note"`], { encoding: 'utf8' });
  assert.equal(np.stdout, 'whatever|');
  // Control characters and escape sequences in a refused value are not printed (the value is data, and it is printed).
  const ctl = tempDir('cm-trk-c-', t);
  fs.mkdirSync(path.join(ctl, '.mem'));
  git(ctl, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(ctl, '.mem', 'config.json'), '{"defaultBranch":"a\tb\u001b[31m"}');
  const cr = spawnSync('bash', ['-c', `. "${sl(PORTABLE)}"; mem_tracked_ref "${sl(ctl)}"; printf '%s' "$mem_track_note"`], { encoding: 'utf8' });
  assert.equal(cr.stdout, "config defaultBranch 'ab[31m' is not a plain branch name - using main");
  const twinCtl = spawnSync('bash', ['-c', `CHEAP_MEM_ROOT="${sl(ctl)}"\n${twinBlock()}\nprintf '%s' "$mem_track_note"`], { encoding: 'utf8' });
  assert.equal(twinCtl.stdout, cr.stdout);
  // A single-line config is read the same (a minified file must not silently fall back to main).
  const dir = tempDir('cm-trk-c-', t);
  fs.mkdirSync(path.join(dir, '.mem'));
  fs.writeFileSync(path.join(dir, '.mem', 'config.json'), '{"defaultBranch":"develop","defaultRemote":"upstream"}');
  const one = spawnSync('bash', ['-c', `. "${sl(PORTABLE)}"; mem_tracked_ref "${sl(dir)}"; printf '%s/%s' "$mem_track_remote" "$mem_track_branch"`], { encoding: 'utf8' });
  assert.equal(one.stdout, 'upstream/develop');
});

test('MUTATION: a function that ignores the config is caught by the table', (t) => {
  const dir = tempDir('cm-trk-m-', t);
  fs.mkdirSync(path.join(dir, '.mem'));
  fs.writeFileSync(path.join(dir, '.mem', 'config.json'), JSON.stringify({ defaultBranch: 'develop' }));
  const mutated = fs.readFileSync(PORTABLE, 'utf8').replace("grep -o '\"defaultBranch\"", "grep -o '\"defaultBranchX\"");
  assert.notEqual(mutated, fs.readFileSync(PORTABLE, 'utf8'), 'the line the mutation hits moved');
  const f = path.join(tempDir('cm-trk-mf-', t), '_portable.sh');
  fs.writeFileSync(f, mutated);
  const r = spawnSync('bash', ['-c', `. "${sl(f)}"; mem_tracked_ref "${sl(dir)}"; printf '%s' "$mem_track_branch"`], { encoding: 'utf8' });
  assert.equal(r.stdout, 'main', 'the mutated function still found develop - the table would not notice');
});

// ---- the recall hook's background pull -------------------------------------------------------------------------

/** The recall hook (current, or the old one from the fixture) in a tool directory of its own. */
function retrieveHook(t, oldText = null) {
  const dir = tempDir('cm-trk-tool-', t);
  fs.cpSync(path.join(REPO, 'bin'), path.join(dir, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(dir, 'src'), { recursive: true });
  if (oldText) fs.writeFileSync(path.join(dir, 'bin', 'mem-retrieve'), oldText);
  return path.join(dir, 'bin', 'mem-retrieve');
}

async function pulled(t, hook) {
  const w = world(t);
  fs.writeFileSync(path.join(w.other, 'c.txt'), 'c');
  git(w.other, 'add', '-A'); git(w.other, 'commit', '-q', '-m', 'C'); git(w.other, 'push', '-q', 'origin', 'develop');
  const want = git(w.other, 'rev-parse', 'HEAD');
  const h = mkhome(home(t));
  const env = { ...process.env, CHEAP_MEM_ROOT: w.mem, HOME: h, USERPROFILE: h, MEM_HOOK_OFF: '', MEM_RETRIEVE_OFF: '', MEM_HEADLESS: '' };
  for (const k of ['MEM_RETRIEVE_REMOTE', 'MEM_RETRIEVE_BRANCH', 'MEM_RETRIEVE_NO_PULL']) delete env[k];
  const r = spawnSync('bash', [hook], { input: JSON.stringify({ session_id: 's', prompt: 'what do we know about the install script quoting problem' }), encoding: 'utf8', env, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  // The pull is detached by design: wait for it, bounded.
  let got = '';
  for (let i = 0; i < 40; i += 1) {
    got = git(w.mem, 'rev-parse', 'HEAD');
    if (got === want) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  return { got, want, branch: git(w.mem, 'branch', '--show-current') };
}

test('the recall hook pulls the tracked branch: a commit on the remote develop reaches the clone', async (t) => {
  const r = await pulled(t, retrieveHook(t));
  assert.equal(r.branch, 'develop');
  assert.equal(r.got, r.want, 'the recall hook never brought the tracked branch forward');
});

test('RED PROOF: the old recall hook (origin main) never brings develop forward', async (t) => {
  const old = fs.readFileSync(path.join(REPO, 'test', 'fixture', 'mem-retrieve-v1.sh.txt'), 'utf8');
  const r = await pulled(t, retrieveHook(t, old));
  assert.notEqual(r.got, r.want, 'the old hook reached develop - the red proof has moved');
});

// ---- the PowerShell twins (no pwsh in most places this runs: the shape is read, like test/retrieve-ps1-client.test.mjs) ----

test('the PowerShell session start and recall hook ask the config too, and never fetch origin main by name', () => {
  const win = fs.readFileSync(path.join(REPO, 'install', 'windows.ps1'), 'utf8');
  const ret = fs.readFileSync(path.join(REPO, 'bin', 'mem-retrieve.ps1'), 'utf8');
  const code = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code(win), /fetch `\$memRemote `\$memBranch/);
  assert.match(code(win), /checkout `\$memBranch/);
  assert.match(code(win), /pull --ff-only `\$memRemote `\$memBranch/);
  assert.match(code(win), /defaultBranch/);
  assert.doesNotMatch(code(win), /fetch origin main|checkout main\b|pull --ff-only 2>&1/, 'the Windows session start still names origin/main');
  assert.match(code(ret), /\$cfg\.defaultBranch/);
  assert.match(code(ret), /\$cfg\.defaultRemote/);
  // The same plain-name rule as the POSIX function: a letter or digit first, no `..`, no `//`, no trailing `/` or `.lock`.
  for (const text of [code(win), code(ret)]) {
    assert.match(text, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._\/-\]\*/);
    assert.match(text, /Contains\('\.\.'\)/);
    assert.match(text, /EndsWith\('\.lock'\)/);
    // N6: `\z`, not `$` (.NET lets `$` match before a trailing newline); N5: a remote is asked before it is fetched from.
    assert.match(text, /\*\\z'/);
    assert.doesNotMatch(text, /-match '\^\[A-Za-z0-9\][^']*\$'/, 'a plain-name check still ends in $');
    assert.match(text, /remote get-url -- /);
  }
});

test('N5 end to end: a defaultRemote that is no remote - here the name of a directory in the clone - is not fetched from', (t) => {
  const w = world(t);
  // A directory inside the clone that IS a repository with the tracked branch: `git fetch sub main` would take it for a path.
  const sub = path.join(w.mem, 'sub');
  fs.mkdirSync(sub);
  git(sub, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(sub, 'x'), 'x');
  git(sub, 'add', '-A'); git(sub, 'commit', '-q', '-m', 'planted');
  const cfgPath = path.join(w.mem, '.mem', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), defaultRemote: 'sub' }, null, 2));
  const r = start(START, w.mem, mkhome(home(t)));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WARNING: config defaultRemote 'sub' is not a remote of this clone - using origin/);
  assert.equal(git(w.mem, 'branch', '-r', '--list', 'sub/*'), '', 'a ref came from the planted directory');
  assert.doesNotMatch(git(w.mem, 'log', '--all', '--format=%s'), /planted/);
  // RED: the version before this change (c1ad4a9) fetches from it.
  const old = spawnSync('git', ['show', 'c1ad4a9:install/hooks/session-start.sh'], { cwd: REPO, encoding: 'utf8' });
  if (old.status !== 0) { t.diagnostic('c1ad4a9 is not in this clone: the red proof could not run (unknown, not green)'); return; }
  const oldPath = path.join(tempDir('cm-trk-old-', t), 'session-start.sh');
  fs.writeFileSync(oldPath, old.stdout);
  const o = start(oldPath, w.mem, mkhome(home(t)));
  assert.equal(o.status, 0, o.stderr);
  assert.match(git(w.mem, 'log', '--all', '--format=%s'), /planted/, `the red proof no longer holds: the old hook did not fetch from the planted directory\n${o.stdout}`);
});
