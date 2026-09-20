// The guarantees cheap-mem does not provide itself. Round two of the
// 2026-09-05 audit found these were the failure class behind the others:
// invisible when present, silent when absent, verified by nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  checkMergeDriver, checkPreCommitHook, checkClock, checkAppendAtomicity,
  checkEnvironment, environmentOk, LAYER,
} from '../src/environment.mjs';

// The git-layer checks are about repository CONFIGURATION, so a fixture
// that is not a repository tests nothing about them — it exercises the
// not-applicable branch instead. Every fixture here is a real repository.
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-env-'));
  execFileSync('git', ['-C', d, 'init', '-q'], { stdio: 'ignore' });
  return d;
}
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });

// `checkAppendAtomicity` shells out to the real `stat` binary with no
// injection point, so the only way to exercise every fsType branch is to
// put a fake `stat` ahead of it on PATH — the same technique a real
// deployment's PATH manipulation would achieve by accident, which is
// exactly the failure mode worth testing against.
function withFakeStat(fsType, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fakestat-'));
  fs.writeFileSync(path.join(dir, 'stat'), `#!/bin/sh\nprintf '%s' '${fsType}'\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  try {
    return fn();
  } finally {
    process.env.PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a missing .gitattributes fails, and the advice says what it costs', () => {
  const root = tmp();
  const c = checkMergeDriver(root);
  assert.equal(c.ok, false);
  assert.equal(c.layer, LAYER.GIT);
  assert.match(c.fix, /merge=union/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a .gitattributes without the rule is not mistaken for one with it', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.md text\n');
  assert.equal(checkMergeDriver(root).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a file that MENTIONS jsonl without declaring the driver still fails', () => {
  // The check must match the whole rule, not the word. A substring test
  // would pass on any of these, and mutation testing found exactly that
  // gap: narrowing the regex to /jsonl/ left every test green.
  for (const text of [
    '*.jsonl text\n',
    '*.jsonl diff=json\n',
    '# TODO: add *.jsonl merge=union one day\n',
    'merge=union\n',
    '*.jsonl merge=ours\n',
    'notes.jsonl -text\n',
  ]) {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.gitattributes'), text);
    assert.equal(checkMergeDriver(root).ok, false,
      `accepted ${JSON.stringify(text)} as the merge driver`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the rule is recognised with surrounding comments and blank lines', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.gitattributes'), '# note\n\n*.jsonl merge=union\n\n# more\n');
  assert.equal(checkMergeDriver(root).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unset core.hooksPath fails rather than being assumed fine', () => {
  const root = tmp();
  git(root, 'init', '-q');
  const c = checkPreCommitHook(root);
  assert.equal(c.ok, false);
  assert.match(c.detail, /not set/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a hooksPath pointing at a directory with no pre-commit fails', () => {
  const root = tmp();
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'hooks'));
  git(root, 'config', 'core.hooksPath', 'hooks');
  assert.equal(checkPreCommitHook(root).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a hook without the executable bit still counts — it is invoked as bash <path>', () => {
  const root = tmp();
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  git(root, 'config', 'core.hooksPath', 'hooks');
  assert.equal(checkPreCommitHook(root).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clock check with nothing to compare against is unknown, not ok', () => {
  const c = checkClock(tmp(), { newestTs: null });
  assert.equal(c.ok, null);
});

test('an entry far in the future is a clock finding', () => {
  const c = checkClock(tmp(), { newestTs: '2099-01-01T00:00:00Z' });
  assert.equal(c.ok, false);
  assert.match(c.detail, /future/);
});

test('a few minutes of skew is tolerated', () => {
  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  assert.equal(checkClock(tmp(), { newestTs: soon }).ok, true);
});

test('strict treats an unverifiable guarantee as a failure, normal does not', () => {
  const checks = [{ name: 'x', layer: LAYER.OS, ok: null, detail: 'unknown', fix: null }];
  assert.equal(environmentOk(checks, { strict: false }), true);
  assert.equal(environmentOk(checks, { strict: true }), false);
});

test('every check names the layer responsible', () => {
  const root = tmp();
  for (const c of checkEnvironment(root, { newestTs: new Date().toISOString() })) {
    assert.ok(Object.values(LAYER).includes(c.layer), `${c.name} has no layer`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('mem init writes the merge driver — a fresh memory must not ship without it', () => {
  const root = tmp();
  execFileSync('node', [path.join(process.cwd(), 'bin', 'mem'), 'init'],
    { cwd: root, stdio: 'ignore' });
  assert.equal(checkMergeDriver(root).ok, true,
    'init left the memory without the guarantee its own design depends on');
  fs.rmSync(root, { recursive: true, force: true });
});

test('init does not clobber an existing .gitattributes', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.png binary\n');
  execFileSync('node', [path.join(process.cwd(), 'bin', 'mem'), 'init'],
    { cwd: root, stdio: 'ignore' });
  const text = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(text, /\*\.png binary/);
  assert.match(text, /\*\.jsonl merge=union/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('init is idempotent — running it twice does not duplicate the rule', () => {
  const root = tmp();
  const mem = path.join(process.cwd(), 'bin', 'mem');
  execFileSync('node', [mem, 'init'], { cwd: root, stdio: 'ignore' });
  execFileSync('node', [mem, 'init', '--force'], { cwd: root, stdio: 'ignore' });
  const hits = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')
    .split('\n').filter((l) => /^\s*\*\.jsonl\s+merge=union\s*$/.test(l));
  assert.equal(hits.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('outside a git repository the git-layer checks are unknown, not failed', () => {
  // A freshly initialised memory that is not versioned yet is a CORRECT
  // state. Reporting it as an error made `mem doctor` exit 2 and held CI
  // red on all three platforms for three runs, unread.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nogit-'));
  for (const c of [checkMergeDriver(root), checkPreCommitHook(root)]) {
    assert.equal(c.ok, null, `${c.name} must be unknown outside a repository`);
    assert.equal(c.layer, LAYER.GIT);
    assert.match(c.detail, /not a git repository/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// --- append-atomicity: allow-list, not deny-list (fixed 2026-09-19) --------
//
// The bug this replaces: `/^(nfs|smb|cifs|fuseblk|9p|virtiofs)/i` matched
// unsafe names and let EVERYTHING ELSE through as "OK, atomic here" —
// including `overlay`, the filesystem of every Docker container, this
// one's own included. Each test below is also its own sabotage
// counter-proof: reverting `checkAppendAtomicity` to the old deny-list
// regex turns the "unknown, not OK" tests red (`overlay` and
// `unknown-0x1234` would come back `ok: true`), while the OK/FAIL tests
// stay green either way — which is exactly why the deny-list looked
// fine for so long.

test('append-atomicity: filesystems with a documented locking guarantee report OK', () => {
  const root = tmp();
  for (const t of ['ext2/ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'tmpfs']) {
    const c = withFakeStat(t, () => checkAppendAtomicity(root));
    assert.equal(c.ok, true, `${t} should be reported as atomic`);
    assert.equal(c.layer, LAYER.OS);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('append-atomicity: filesystems with a documented failure mode report FAIL', () => {
  const root = tmp();
  for (const t of ['nfs', 'nfs4', 'smb', 'smb2', 'smb3', 'cifs', 'sshfs']) {
    const c = withFakeStat(t, () => checkAppendAtomicity(root));
    assert.equal(c.ok, false, `${t} should be reported as unsafe`);
    // Der Grund muss dabeistehen, und zwar als Beleg, nicht als
    // Behauptung: das Urteil kommt hier aus open(2), nicht aus einer
    // Messung — und der Text sagt auch, warum NICHT gemessen wurde.
    assert.match(c.detail, /documented NOT to be atomic/);
    assert.match(c.detail, /open\(2\)/);
    assert.match(c.detail, /[Nn]ot measured/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('append-atomicity: overlay and every unverified name is UNKNOWN, never OK', () => {
  // `overlay`/`overlayfs` is the case that matters most: it is what
  // `stat -f -c %T` reports inside a container, and its real safety
  // depends on the storage driver underneath, which this check cannot
  // see. `fuseblk`, `fuse`, `9p` and `virtiofs` moved off the old
  // deny-list for the same reason: not proven safe, not proven unsafe.
  const root = tmp();
  for (const t of ['overlay', 'overlayfs', 'vfat', 'msdos', 'fuseblk', 'fuse', '9p', 'virtiofs', 'unknown-0x1234']) {
    const c = withFakeStat(t, () => checkAppendAtomicity(root));
    assert.equal(c.ok, null, `${t} must be unknown, not asserted safe or unsafe`);
    assert.match(c.detail, new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the unknown detail must name the filesystem type it could not verify');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('append-atomicity: undeterminable stays unknown, not ok', () => {
  // Ohne Namen laeuft die Messung trotzdem — aber ein sauberer kurzer
  // Lauf belegt die Zusage nicht, er widerlegt sie nur nicht. Also
  // bleibt es beim dritten Zustand, und der Text muss sagen warum.
  const c = withFakeStat('', () => checkAppendAtomicity(tmp()));
  assert.equal(c.ok, null);
  assert.match(c.detail, /can falsify the guarantee, never establish it/);
});

test('append-atomicity: this machine — not faked, cross-checked against the real `stat`', () => {
  // Exercises the real `stat -f -c %T` rather than the fake — on the
  // machine this was written on, `mount` shows `/` as ext4 while
  // `stat -f -c %T` names it `ext2/ext3` (ext2/ext3/ext4 share statfs
  // magic 0xEF53), and the check reports OK because `ext2/ext3` is on
  // the allow-list. Read the real type independently so the assertion
  // holds wherever this runs, not only on that one machine.
  const root = tmp();
  const realType = execFileSync('stat', ['-f', '-c', '%T', root], { encoding: 'utf8' }).trim();
  const c = checkAppendAtomicity(root);
  assert.match(c.detail, new RegExp(realType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (['ext2/ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'tmpfs'].includes(realType)) {
    assert.equal(c.ok, true, `${realType} is on the allow-list and should report OK`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
