// test/helpers/bash-file.mjs - run a bash script the way a hook runs: from a FILE.
//
// Not `bash -c <script>`. On Windows a native process (node) hands Git Bash one command line, and the MSYS runtime
// splits it itself: inside a quoted argument it reads `\\` as ONE backslash (the Cygwin command-line globbing in
// dcrt0.cc; MSVC's rules keep both). A probe that defines the hooks' `to_slashes() { printf '%s' "${1//\\//}"; }`
// through `-c` got `${1//\//}` instead - "delete every slash" - and every path it built pointed nowhere
// (test/hook-spaces.test.mjs, red on Windows from CI run 1066 to 1141; test/msys-native-paths.test.mjs green there
// for that same reason). A hook file is read by bash byte for byte; so is this one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let dir = null;
let n = 0;

/** Run `script` from a fresh file with `bash`; `args` become $1..; the spawnSync result (utf8). */
export function bashFile(script, { args = [], env, cwd } = {}) {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-bash-file-'));
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir */ } });
  }
  const file = path.join(dir, `s${(n += 1)}.sh`);
  fs.writeFileSync(file, script);
  return spawnSync('bash', [file, ...args], { encoding: 'utf8', env, cwd });
}
