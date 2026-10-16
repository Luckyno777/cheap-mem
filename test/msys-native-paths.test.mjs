// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// CI run 1074 - the tool and memory paths a hook hands to node.exe are made in the Windows form under Git Bash.
//
// The finding: MSYS2 (Git Bash) translates a POSIX path (`/c/Users/...`, `/tmp/...`) in an argument or environment
// value for a native program, but leaves alone any value holding an apostrophe, a backtick, `*`, `?`, `[` or `]`
// (msys2-runtime, winsup/cygwin/msys2_path_conv.cc, the `skip_p2w` cases). The installer baked `pwd` (POSIX) into
// every shim, the hooks built their tool directory with `pwd`, and with the tool under a folder with an apostrophe
// node read `/tmp/x/mem's root` as C:\tmp\x\...: on windows-latest every installed shim answered with nothing
// (test/installed-hooks-run.test.mjs, "a path with an apostrophe and a space").
//
// The repair: where a hook or the installer makes such a path with `pwd`, it asks `pwd -W` first - Git Bash's
// builtin answers with the Windows form in forward slashes (bash and node both read it, nothing to translate);
// every other bash refuses the flag, and the plain `pwd` stands.
//
// No Git Bash here, so the probe gives the shell a `pwd` that answers `-W` with a marked form and runs each real line
// cut out of its file. RED PROOF: the old lines (plain `pwd`) never ask for it. POSITIVE CONTROL: without the stand-in
// the same lines give the plain directory (no change off Windows). MUTATION: each line with the plain `pwd` back is
// caught. What Git Bash itself does is the CI's half (windows-latest runs the installed shims).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sl = (p) => p.replaceAll('\\', '/');

// file -> the variables it makes with `cd ... && pwd` and later hands to node (directly or as the tool root).
const SITES = {
  'bin/mem-retrieve': ['HOOK_DIR'],
  'bin/mem-before-edit': ['HOOK_DIR'],
  'bin/mem-after-failure': ['HOOK_DIR'],
  'bin/mem-catch-fail': ['HOOK_DIR'],
  'bin/mem-stop': ['HERE'],
  'bin/mem-subagent-start': ['SELF_DIR'],
  'bin/mem-capture': ['HERE'],
  'install/claude-code.sh': ['CHEAP_MEM_ROOT', 'HERE'],
};

/** The assignment line of `name` in `text` that builds it with `cd`; exactly one per name. */
function line(text, name) {
  const found = text.split('\n').filter((l) => new RegExp(`^\\s*${name}="\\$\\(cd `).test(l));
  assert.equal(found.length, 1, `${name}: expected one line ${name}="$(cd ..., found ${found.length} - the probe needs updating`);
  return found[0].trim();
}

const FAKE_PWD = 'pwd() { if [ "${1:-}" = "-W" ]; then printf "W:%s" "$(builtin pwd)"; else builtin pwd; fi; }';

/** Run one cut-out line as if from `file` ($0 / BASH_SOURCE), optionally with the Git Bash stand-in; print the variable. */
function run(file, assignment, name, { gitBash, env = {} }) {
  const script = [
    "to_slashes() { printf '%s' \"${1//\\\\//}\"; }",
    gitBash ? FAKE_PWD : '',
    // BASH_SOURCE[0] is the script itself in a sourced/run file; here it has to be set by hand.
    `BASH_SOURCE_0=${JSON.stringify(sl(path.join(REPO, file)))}`,
    assignment.replace('${BASH_SOURCE[0]}', '$BASH_SOURCE_0'),
    `printf '%s' "$${name}"`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script, sl(path.join(REPO, file))], {
    encoding: 'utf8', cwd: REPO, env: { PATH: process.env.PATH, HOME: process.env.HOME || '', ...env },
  });
  assert.equal(r.status, 0, `${file} ${name}: ${r.stderr}`);
  return r.stdout;
}

function expectedDir(file, name, memDir) {
  if (name === 'CHEAP_MEM_ROOT') return memDir;
  return path.dirname(path.join(REPO, file));
}

const memory = (t) => {
  const d = tempDir('cm-msys-', t);
  return fs.realpathSync(d);
};

test('under Git Bash every hook and the installer make the paths node gets in the Windows form', (t) => {
  if (process.platform === 'win32') {
    // On Windows bash IS Git Bash: the real `pwd -W` answers, no stand-in. The line must give a drive path.
    for (const [file, names] of Object.entries(SITES)) {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      for (const name of names) {
        const out = run(file, line(text, name), name, { gitBash: false, env: { CHEAP_MEM_ROOT: sl(memory(t)) } });
        assert.match(out, /^[A-Za-z]:\//, `${file} ${name}: not the Windows form: ${out}`);
      }
    }
    return;
  }
  const mem = memory(t);
  for (const [file, names] of Object.entries(SITES)) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    for (const name of names) {
      const want = fs.realpathSync(expectedDir(file, name, mem));
      const out = run(file, line(text, name), name, { gitBash: true, env: { CHEAP_MEM_ROOT: mem } });
      assert.equal(out, `W:${want}`, `${file} ${name}: Git Bash would hand node the POSIX form`);
      // POSITIVE CONTROL: off Git Bash the very same line is plain `pwd`.
      const plain = run(file, line(text, name), name, { gitBash: false, env: { CHEAP_MEM_ROOT: mem } });
      assert.equal(plain, want, `${file} ${name}: off Windows the line changed what it gives`);
    }
  }
});

test('RED PROOF and MUTATION: the plain `pwd` line never asks for the Windows form', (t) => {
  // On Windows bash is Git Bash and its own `pwd -W` answers; elsewhere the stand-in does. Either way the question
  // is the same: does the line hand over the Windows form?
  const WIN = process.platform === 'win32';
  const native = (out) => (WIN ? /^[A-Za-z]:\//.test(out) : /^W:/.test(out));
  const mem = memory(t);
  const env = { CHEAP_MEM_ROOT: sl(mem) };
  // The shape every site had before.
  const old = 'HOOK_DIR="$(cd "$(dirname "$(to_slashes "$0")")" && pwd)"';
  assert.equal(native(run('bin/mem-retrieve', old, 'HOOK_DIR', { gitBash: !WIN, env })), false,
    'the old line gave the Windows form - the red proof no longer holds');
  // POSITIVE CONTROL of the instrument: asked for directly, the Windows form comes.
  assert.equal(native(run('bin/mem-retrieve', 'HOOK_DIR="$(cd bin && pwd -W)"', 'HOOK_DIR', { gitBash: !WIN, env })), true,
    'nothing answers -W: the probe would measure nothing');
  // Each real line with the plain `pwd` put back is caught.
  for (const [file, names] of Object.entries(SITES)) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    for (const name of names) {
      const real = line(text, name);
      const mutated = real.replace('{ pwd -W 2>/dev/null || pwd; }', 'pwd');
      assert.notEqual(mutated, real, `${file} ${name}: the mutation found nothing to replace`);
      assert.equal(native(run(file, mutated, name, { gitBash: !WIN, env })), false, `${file} ${name}: the mutant still gave the Windows form`);
    }
  }
});
