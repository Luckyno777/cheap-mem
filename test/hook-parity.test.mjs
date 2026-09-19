// A hook that exists in only one shell exists on only one platform.
//
// **The measurement (2026-09-19, reported by a cheap-mem user on
// Windows).** `bin/mem-before-edit`, `bin/mem-retrieve` and
// `bin/mem-stop` were bash scripts with no `.ps1` counterpart, while
// mem-capture, mem-digest, mem-handle-post, mem-reflect and mem-watch
// all had one. A default Git for Windows install puts `git.exe` on
// PATH but NOT `bash.exe` — Git Bash lives under
// `C:\Program Files\Git\bin` and is only added to PATH if the
// installer's "Use Git and optional Unix tools" option is chosen. So
// on an ordinary Windows machine the recall lane and the before-edit
// lane could not be started at all.
//
// And nothing said so. A hook whose command cannot be launched prints
// nothing, and nothing is exactly what a hook prints when the memory
// has nothing to offer. The product's core promise — "memory shows up
// by itself" — died silently on the platform most companies use.
//
// **Why CI did not catch it.** GitHub's windows-latest runner ships
// Git Bash. Every Windows job in .github/workflows/ci.yml that says
// `shell: bash` therefore ran the POSIX hooks happily, on Windows, and
// proved nothing about the machine the report came from.
//
// **Why this file scans instead of listing.** The gap survived because
// nobody was counting. A hardcoded list of "the hooks that need a
// Windows twin" is the same mistake one level up: it is right on the
// day it is written and stale on the day the ninth hook lands. So the
// rule is a SHAPE derived from bin/ itself — same construction as
// test/portability.test.mjs, which finds its own shell scripts, and
// test/windows-paths.test.mjs, which finds its own sources.
//
// **The exemption is deliberate, and it is used.** A bolt that reports
// innocents gets switched off. `bin/_portable.sh` is a sourced bash
// library of POSIX-tool fallbacks and has nothing to be on Windows, so
// it carries `windows-parity-ok:` with its reason on the line — the
// same marker shape test/windows-paths.test.mjs already uses. The
// reason has to be ON the file, not in a list here, or the list
// becomes the next thing that goes stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin');

/**
 * The exemption marker, with its reason.
 *
 * Returns the reason, or null when the file is not exempt. A bare
 * `windows-parity-ok:` with nothing after it does NOT exempt: an
 * exemption whose reason is missing is indistinguishable from a
 * silencer, and this repo's other marker (`windows-path-ok:`) is
 * written the same way — the reason stands on the line.
 */
export function exemptionReason(text) {
  const m = String(text ?? '').match(/windows-parity-ok:[ \t]*(\S.*?)\s*$/m);
  return m ? m[1] : null;
}

/**
 * Is this a shell script of ours?
 *
 * By shebang OR by `.sh` extension. The extension half is not
 * redundant: `bin/_portable.sh` is SOURCED, never executed, and
 * carries a `# shellcheck shell=bash` directive instead of a shebang.
 * A shebang-only reader would drop it from the candidate set without
 * anyone deciding to — which is a silent exemption, the very thing the
 * marker exists to replace.
 */
export function isShellScript(name, text) {
  if (name.endsWith('.ps1')) return false;
  if (name.endsWith('.sh')) return true;
  return /^#!.*\b(ba)?sh\b/.test(String(text ?? ''));
}

/** The PowerShell name a given shell script would have. */
export function powershellTwin(name) {
  return (name.endsWith('.sh') ? name.slice(0, -3) : name) + '.ps1';
}

/** The shell names a given `.ps1` would answer to. */
export function shellTwins(name) {
  const base = name.slice(0, -'.ps1'.length);
  return [base, `${base}.sh`];
}

function binFiles() {
  return fs.readdirSync(BIN)
    .filter((n) => fs.statSync(path.join(BIN, n)).isFile())
    .map((n) => ({ name: n, text: fs.readFileSync(path.join(BIN, n), 'utf8') }));
}

const present = () => new Set(binFiles().map((f) => f.name));
const shellScripts = () => binFiles().filter((f) => isShellScript(f.name, f.text));
const powershellScripts = () => binFiles().filter((f) => f.name.endsWith('.ps1'));

test('POSITIVE CONTROL: the scanner reads bin/ and sees both halves', () => {
  // A probe that walks an empty directory passes forever and measures
  // nothing. Both halves are checked, because either alone is a check
  // that checks nothing.
  const sh = shellScripts();
  const ps = powershellScripts();
  assert.ok(sh.length >= 8, `only ${sh.length} shell scripts found in bin/ — the reader no longer fits`);
  assert.ok(ps.length >= 8, `only ${ps.length} PowerShell scripts found in bin/ — the reader no longer fits`);

  // And it must see the PAIRS that already existed before this rule
  // did — not as the rule (that is derived above), but as proof the
  // reader recognises a pair when it is looking at one.
  const have = present();
  for (const base of ['mem-capture', 'mem-digest', 'mem-watch']) {
    assert.ok(shellScripts().some((f) => f.name === base), `${base} is not read as a shell script`);
    assert.ok(have.has(`${base}.ps1`), `${base}.ps1 is not in bin/ — the positive control has nothing to stand on`);
  }
  // The node CLIs are not hooks and must NOT be pulled in, or the rule
  // below would demand a PowerShell port of the whole tool.
  for (const cli of ['mem', 'mem-mcp', 'mem-serve']) {
    assert.ok(!shellScripts().some((f) => f.name === cli),
      `${cli} is a node program and is being read as a shell script`);
  }
});

test('POSITIVE CONTROL: the name mapping and the marker reader work', () => {
  assert.equal(powershellTwin('mem-stop'), 'mem-stop.ps1');
  assert.equal(powershellTwin('_portable.sh'), '_portable.ps1');
  assert.deepEqual(shellTwins('mem-stop.ps1'), ['mem-stop', 'mem-stop.sh']);

  assert.equal(isShellScript('x', '#!/usr/bin/env bash\n'), true);
  assert.equal(isShellScript('x', '#!/bin/sh\n'), true);
  assert.equal(isShellScript('x', '#!/usr/bin/env node\n'), false, 'a node program is read as a shell script');
  assert.equal(isShellScript('x.sh', '# shellcheck shell=bash\n'), true, 'a sourced .sh without a shebang is missed');
  assert.equal(isShellScript('x.ps1', '# anything\n'), false);

  assert.equal(exemptionReason('# windows-parity-ok: sourced, never run as a hook'),
    'sourced, never run as a hook');
  assert.equal(exemptionReason('# nothing here'), null);
  assert.equal(exemptionReason('# windows-parity-ok:'), null,
    'a marker with no reason exempts — then it is a silencer, not an exemption');
  assert.equal(exemptionReason('# windows-parity-ok:   '), null,
    'whitespace counts as a reason');
});

test('every shell script in bin/ has a PowerShell counterpart', () => {
  const have = present();
  const missing = [];
  for (const f of shellScripts()) {
    if (exemptionReason(f.text)) continue;
    const twin = powershellTwin(f.name);
    if (!have.has(twin)) missing.push(`bin/${f.name} -> bin/${twin} is missing`);
  }
  assert.deepEqual(missing, [],
    'A default Git for Windows install has git.exe on PATH but not bash.exe, so a '
    + 'bash-only hook cannot start there at all — and a hook that cannot start prints '
    + 'nothing, which reads exactly like "the memory had nothing to say". Add the '
    + '.ps1 port, or mark the file `windows-parity-ok: <reason>`:\n  '
    + missing.join('\n  '));
});

test('every PowerShell script in bin/ has a shell counterpart', () => {
  const have = present();
  const missing = [];
  for (const f of powershellScripts()) {
    if (exemptionReason(f.text)) continue;
    if (!shellTwins(f.name).some((n) => have.has(n))) {
      missing.push(`bin/${f.name} -> bin/${shellTwins(f.name)[0]} is missing`);
    }
  }
  assert.deepEqual(missing, [],
    'The other direction: a Windows-only hook leaves Linux and macOS without the '
    + 'lane. Add the POSIX script, or mark the file `windows-parity-ok: <reason>`:\n  '
    + missing.join('\n  '));
});

test('the exemptions are few, and each one names its reason', () => {
  // Counted, so that "skipped" can never quietly become "all of them" —
  // the same discipline test/doku-zahlen.test.mjs applies to its own
  // carve-outs.
  const exempt = binFiles()
    .filter((f) => isShellScript(f.name, f.text) || f.name.endsWith('.ps1'))
    .map((f) => ({ name: f.name, reason: exemptionReason(f.text) }))
    .filter((f) => f.reason);
  assert.ok(exempt.length <= 2,
    `${exempt.length} hooks are exempt from cross-platform parity — that is no longer `
    + `an exception:\n  ${exempt.map((e) => `${e.name}: ${e.reason}`).join('\n  ')}`);
  for (const e of exempt) {
    assert.ok(e.reason.length >= 20,
      `bin/${e.name} claims the exemption with "${e.reason}" — too short to be a reason`);
  }
  // And the path must actually be walked, not merely available: today
  // exactly one file needs it, and if that stops being true the number
  // above is the place to argue about it.
  assert.ok(exempt.length >= 1,
    'no file uses the exemption marker — then this test has never proven the '
    + 'exemption path works, and the first file that needs it finds out the hard way');
});
