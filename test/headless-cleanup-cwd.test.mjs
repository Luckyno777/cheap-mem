// test/headless-cleanup-cwd.test.mjs - the per-run neutral directory is left before it is removed (CI run 1103, Windows).
//
// **The finding.** bin/mem-handle-post and bin/mem-reflect `cd` into the neutral directory to start the model, then call
// `mem_headless_cleanup` (bin/_portable.sh) from INSIDE it; the node process that removes the folder inherits that
// working directory. Windows does not remove a directory that is any process's working directory: two of the three
// per-run folders stayed in the temp directory after every run ("B3: a per-run neutral directory is removed after the
// job", red on Windows; the digest starts its model in a subshell and was clean). Linux removes such a folder, so the
// probe reads the cause itself: where the shell stands when the helper runs. bin/_headless.ps1 had the same shape
// (Set-Location into the folder, then `& node ... cleanup`, which starts in the current location).
//
// Measure:          the shell's working directory after mem_headless_cleanup, and whether the folder is gone.
// Starting value:   still the per-run folder (base 9a10bf6).
// Expected change:  its parent; the folder removed.
// Abort criterion:  the shell still stands in the folder it asked to remove.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const slashes = (p) => p.replace(/\\/g, '/');

test('mem_headless_cleanup steps out of the per-run folder before the helper removes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hlcwd-'));
  try {
    const root = path.join(dir, 'mem');
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(root);
    fs.mkdirSync(tmp);
    // No usable cache base (a FILE where the folder would go): the plan takes a fresh per-run folder in the temp dir.
    fs.writeFileSync(path.join(dir, 'nocache'), 'a file');
    const env = { ...process.env, HOME: path.join(dir, 'nocache'), USERPROFILE: path.join(dir, 'nocache'),
      XDG_CACHE_HOME: path.join(dir, 'nocache', 'x'), LOCALAPPDATA: path.join(dir, 'nocache', 'x'), MEM_HEADLESS_CWD: '',
      TMPDIR: tmp, TEMP: tmp, TMP: tmp };
    const script = [
      `. "${slashes(path.join(REPO, 'bin', '_portable.sh'))}"`,
      `mem_headless_plan "claude -p" "${slashes(root)}" || { echo "no plan"; exit 3; }`,
      'clean="$MEM_HL_CLEAN"',
      'cd "$MEM_HL_CWD" || exit 4',
      'inside="$(pwd -P)"',
      'mem_headless_cleanup',
      'printf "clean=%s\\ninside=%s\\nafter=%s\\n" "$clean" "$inside" "$(pwd -P 2>/dev/null || printf "%s" "$PWD")"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const got = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.match(path.basename(got.clean), /^cheap-mem-headless-cwd-[A-Za-z0-9]{6}$/, `fixture: no per-run folder was planned (${r.stdout})`);
    assert.notEqual(got.after, got.inside, 'the shell still stands in the folder it removed: on Windows it is never removed');
    assert.equal(got.after, path.posix.dirname(got.inside), 'it steps out to the parent (the cache or temp directory), nowhere else');
    assert.equal(fs.existsSync(got.clean), false, 'the per-run folder is gone');
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('cheap-mem-headless-cwd-')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the PowerShell twin leaves the folder too before its helper removes it (static: no PowerShell here)', () => {
  const ps = fs.readFileSync(path.join(REPO, 'bin', '_headless.ps1'), 'utf8');
  const fn = ps.slice(ps.indexOf('function Remove-HeadlessDir'), ps.indexOf('function Get-OldClaudeMessage'));
  assert.ok(fn.length > 0, 'Remove-HeadlessDir moved');
  const step = fn.search(/Set-Location -LiteralPath \(Split-Path -Parent \$Plan\.Clean\)/);
  const call = fn.search(/& node \$script:HeadlessHelper 'cleanup'/);
  assert.ok(step > 0 && call > step, 'Remove-HeadlessDir starts the cleanup from inside the folder it removes');
});
