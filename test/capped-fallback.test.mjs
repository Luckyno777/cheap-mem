// A stock Mac has no `timeout` and no `gtimeout`. `capped` used to run the
// command plain there, so a hanging call never ended (CI run 37692975754:
// K3 found no journal line, the digest tick hung until the harness killed it).
// With perl on PATH the cap is real: exit 124 on expiry, own code otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORTABLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', '_portable.sh');
const which = (n) => spawnSync('bash', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();

function stockMac() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nocap-'));
  for (const n of ['bash', 'sleep', 'perl', 'sh', 'dirname']) {
    const p = which(n);
    if (p) fs.symlinkSync(p, path.join(dir, n));
  }
  return dir;
}
const run = (dir, body) => spawnSync(path.join(dir, 'bash'), ['-c', `. "${PORTABLE}"; ${body}`], {
  encoding: 'utf8', timeout: 30000, env: { PATH: dir },
});

test('no timeout/gtimeout on PATH: capped ends a hang with 124, keeps the command code, passes output', (t) => {
  if (process.platform === 'win32') {
    // The fixture builds a PATH of symlinks to POSIX tools; on Windows those are MSYS paths that
    // cannot be symlinked or spawned from node (spawn returns stdout null: CI "Received null").
    // Not a product gap: Git for Windows ships GNU `timeout` (MSYS coreutils), so `capped` takes
    // the `timeout` branch there and the perl watchdog is never reached. UNVERIFIED on a real runner.
    console.log('NOTICE: capped perl-watchdog fallback not exercised on Windows - Git Bash provides GNU timeout, so capped uses it there (UNVERIFIED), and this PATH-of-symlinks fixture is POSIX-only');
    t.skip('POSIX-only fixture; on Windows capped uses Git Bash timeout');
    return;
  }
  if (!which('perl')) { t.skip('no perl here - unknown, not green'); return; }
  const dir = stockMac();
  try {
    const t0 = Date.now();
    const hung = run(dir, 'capped 1.5 sleep 20; echo "rc=$?"');
    assert.match(hung.stdout, /rc=124/, hung.stdout + hung.stderr);
    assert.ok(Date.now() - t0 < 15000, 'the cap ended it early');
    assert.match(run(dir, 'capped 5 bash -c "exit 3"; echo "rc=$?"').stdout, /rc=3/);
    assert.match(run(dir, 'capped 5 bash -c "echo hi"; echo "rc=$?"').stdout, /hi\nrc=0/);
    assert.match(run(dir, 'capped 5 nonexistent-cmd-xyz; echo "rc=$?"').stdout, /rc=127/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
