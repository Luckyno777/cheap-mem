// test/tool-missing-state-win.test.mjs - the "at most every 30 minutes" marker of install/support/tool-missing.sh goes
// to XDG_STATE_HOME also when Git Bash hands that variable on in its Windows spelling (CI run 1103, Windows).
//
// **The finding.** MSYS2 converts only PATH, HOME and the temp variables to the POSIX form; XDG_STATE_HOME arrives as
// `C:\Users\...\state`. The script took only a value starting with `/` as absolute, so on Windows the user's setting was
// passed over and the marker went to ~/.local/state ("tool-missing: a symlink in the memory ...", red on Windows with
// ENOENT on <home>/state/cheap-mem). Elsewhere `C:/x` is a relative path and stays refused.
//
// Linux stand-in for Git Bash: a `uname` on the PATH that answers MINGW64_NT, and the drive-letter value, which is then
// a relative folder `C:` under the scratch directory (the working directory of the run) - where it lands is the proof.
// Measure:          the folder that holds the marker.  Starting value: ~/.local/state (base 9a10bf6).
// Expected change:  the XDG_STATE_HOME folder under a MINGW uname; ~/.local/state under any other.
// Abort criterion:  a Windows value used outside Git Bash, or passed over under it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'install', 'support', 'tool-missing.sh');

const WIN = process.platform === 'win32';

// `unameSays`: null = the real uname (on Windows that is Git Bash itself). The Windows-spelled value is a real absolute
// folder under the scratch directory on Windows, and the relative `C:` folder of the stand-in elsewhere.
function run(unameSays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tmstate-'));
  const shims = path.join(dir, 'shims');
  fs.mkdirSync(shims);
  if (unameSays) fs.writeFileSync(path.join(shims, 'uname'), `#!/usr/bin/env bash\necho ${unameSays}\n`, { mode: 0o755 });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const xdgValue = WIN ? path.join(dir, 'state') : 'C:\\Users\\u\\state';
  const xdgDir = WIN ? path.join(dir, 'state', 'cheap-mem') : path.join(dir, 'C:', 'Users', 'u', 'state', 'cheap-mem');
  const r = spawnSync('bash', [SCRIPT, 'user-prompt', 'mem-retrieve'], {
    cwd: dir, encoding: 'utf8',
    env: { ...(WIN ? process.env : {}), PATH: `${shims}${path.delimiter}${process.env.PATH}`, HOME: home, CHEAP_MEM_ROOT: path.join(dir, 'mem'),
      CHEAP_MEM_CODE: path.join(dir, 'nowhere'), XDG_STATE_HOME: xdgValue, LOCALAPPDATA: '' },
  });
  const marks = (p) => (fs.existsSync(p) ? fs.readdirSync(p).filter((n) => n.startsWith('tool-missing-user-prompt-')) : []);
  const out = { r, xdg: marks(xdgDir), local: marks(path.join(home, '.local', 'state', 'cheap-mem')) };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('Git Bash: a Windows-spelled XDG_STATE_HOME holds the marker (Windows: the real Git Bash; elsewhere: the stand-in)', () => {
  const { r, xdg, local } = run(WIN ? null : 'MINGW64_NT-10.0-20348');
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).systemMessage, /user-prompt hook is SILENT/);
  assert.equal(xdg.length, 1, `the marker is not under XDG_STATE_HOME (in ~/.local/state: ${local.length})`);
  assert.equal(local.length, 0);
});

test('anywhere else a drive-letter value is not absolute: the marker stays in ~/.local/state', () => {
  const { r, xdg, local } = run('Linux');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(xdg.length, 0, 'a drive-letter value was taken for a state directory outside Git Bash');
  assert.equal(local.length, 1);
});
