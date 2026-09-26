// The Windows SessionStart hook, embedded as a heredoc in
// install/windows.ps1, against install/hooks/session-start.sh.
//
// **The finding (N4b agent, 2026-09-26).** `install/windows.ps1` writes
// its own copy of the SessionStart hook instead of translating
// install/hooks/session-start.sh, and that copy had stopped tracking
// the POSIX one. Measured against the state at commit f281c28: the
// embedded PowerShell hook called `mem context` and then stopped. It
// never called `mem user --session-start` (the habit line N4b just
// wired into the POSIX hook), never called `mem doctor --alarm` (the
// outage detector from 2026-09-17), and never printed the HINTS block
// that tells a session how to use the memory at all. A Windows session
// therefore started with strictly less than a Linux or macOS one, and
// nothing said so — test/hook-parity.test.mjs only ever compared
// bin/*.sh against bin/*.ps1, and this gap lives in install/, not bin/.
//
// **Why this counts calls instead of diffing prose.** The two files are
// different languages with different quoting, so a line-by-line diff
// would flag every stylistic difference as a regression. What has to
// match is narrower and more durable: which `mem <subcommand>` calls
// each hook makes or shows the human, not how either hook is written.
// `shellCalls()` reads that off the bash text (anchored on the literal
// `bin/mem` path); `powershellCalls()` reads it off the PowerShell text
// (anchored on `node $<var> <subcommand>`, since every mem invocation
// in this hook — real or shown as a hint — is written that way). Both
// normalize to "subcommand [event|decision|error|write] [--first-flag]",
// which is enough to tell `doctor --alarm` from `doctor --quiet` and
// `log event` from `log decision`, without caring about later flags,
// alignment spaces, or placeholder spelling ("..." vs "<text>").
//
// **Why the PowerShell side is isolated to one heredoc.** windows.ps1
// also embeds Stop, UserPromptSubmit and PreToolUse hooks in heredocs of
// their own. Those legitimately call different things (or nothing at
// all — the recall and pre-edit lanes delegate to .ps1 scripts, not to
// `mem` directly). Reading the whole file would let those heredocs hide
// a real SessionStart gap inside a bigger union, or manufacture a false
// one. `startHookHeredoc()` isolates exactly the block that is piped
// into `-LiteralPath $startHookDst`.
//
// **The exemption list stays empty.** Every one of the nine calls the
// POSIX hook makes has a legitimate Windows equivalent — none of them
// touch a POSIX-only tool — so there is nothing here that is genuinely
// Unix-only. An entry would need a reason of real length, the same
// discipline test/hook-parity.test.mjs applies to `windows-parity-ok:`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH_PATH = path.join(REPO, 'install/hooks/session-start.sh');
const PS1_PATH = path.join(REPO, 'install/windows.ps1');

/**
 * A named exemption: a call the POSIX hook makes that has no Windows
 * equivalent, with the reason it is genuinely Unix-only. Empty today.
 */
const EXEMPT = new Set([
  // 'some --call': 'reason of real length goes here, not a one-liner',
]);

function normalizeCall(sub, noun, flag) {
  let s = sub.toLowerCase();
  if (noun) s += ` ${noun.toLowerCase()}`;
  if (flag) s += ` ${flag.toLowerCase()}`;
  return s;
}

/** mem CLI calls made or shown, by name, in the POSIX SessionStart hook. */
export function shellCalls(text) {
  const out = new Set();
  const re = /bin\/mem"?\s+([a-zA-Z][\w-]*)(?:\s+(event|decision|error|write))?(?:\s+(--[\w-]+))?/g;
  for (const m of text.matchAll(re)) out.add(normalizeCall(m[1], m[2], m[3]));
  return out;
}

/**
 * mem CLI calls made or shown, by name, in a PowerShell hook.
 *
 * Backticks are stripped first: the embedded heredoc in windows.ps1
 * writes every `$name` it wants to survive into the generated .ps1
 * file as `` `$name `` (an escaped dollar, so the OUTER script does not
 * interpolate it at install time). That backtick sits between `node`
 * and the variable in the raw source and would otherwise break a plain
 * `node\s+\$\w+` match — stripping it first lets the same regex read
 * both a raw heredoc-with-backticks and an already-generated .ps1 file.
 */
export function powershellCalls(rawText) {
  const text = rawText.replace(/`/g, '');
  const out = new Set();
  const re = /node\s+\$\w+\s+([a-zA-Z][\w-]*)(?:\s+(event|decision|error|write))?(?:\s+(--[\w-]+))?/g;
  for (const m of text.matchAll(re)) out.add(normalizeCall(m[1], m[2], m[3]));
  return out;
}

/** Just the heredoc piped into `-LiteralPath $startHookDst`. */
export function startHookHeredoc(installerText) {
  const m = installerText.match(/@"[\s\S]*?"@\s*\|\s*Set-Content\s+-LiteralPath\s+\$startHookDst/);
  return m ? m[0] : '';
}

/** The two directions of mismatch between a shell set and a PS set. */
export function missingCalls(shSet, psSet, exempt = EXEMPT) {
  const missingInPs = [...shSet].filter((c) => !psSet.has(c) && !exempt.has(c));
  const missingInSh = [...psSet].filter((c) => !shSet.has(c) && !exempt.has(c));
  return { missingInPs, missingInSh };
}

test('POSITIVE CONTROL: shellCalls reads the real calls off session-start.sh', () => {
  const sh = fs.readFileSync(SH_PATH, 'utf8');
  const calls = shellCalls(sh);
  // The floor a reader that no longer fits the file would fall below.
  assert.ok(calls.size >= 9, `only ${calls.size} calls read from session-start.sh — the reader broke`);
  for (const expected of [
    'context --n', 'user --session-start', 'doctor --alarm', 'doctor --quiet',
    'log event --title', 'log decision --topic', 'log error --class',
    'find', 'inbox write --as',
  ]) {
    assert.ok(calls.has(expected), `session-start.sh: "${expected}" not read — the probe missed a real call`);
  }
});

test('POSITIVE CONTROL: powershellCalls reads a synthetic hook, backticks and all', () => {
  const synthetic = [
    'if (Test-Path `$mem) {',
    '  & node `$mem context --n 10',
    '}',
    'if (Test-Path `$mem) {',
    '  `$habits = & node `$mem user --session-start 2>`$null',
    '}',
    '`$alarmJob = Start-Job -ScriptBlock {',
    '  param(`$m)',
    '  & node `$m doctor --alarm 2>`$null',
    '} -ArgumentList `$mem',
    'Write-Host "By hand: node `$mem doctor --quiet"',
    'Write-Host "  node `$mem log event    --title <text> --tags <tag1,tag2>"',
    'Write-Host "  node `$mem find <query>"',
  ].join('\n');
  const calls = powershellCalls(synthetic);
  assert.deepEqual([...calls].sort(), [
    'context --n', 'doctor --alarm', 'doctor --quiet',
    'find', 'log event --title', 'user --session-start',
  ].sort());
});

test('POSITIVE CONTROL: startHookHeredoc isolates the SessionStart block only', () => {
  const ps1 = fs.readFileSync(PS1_PATH, 'utf8');
  const body = startHookHeredoc(ps1);
  assert.ok(body.length > 100, 'the isolator found nothing — its anchor no longer matches windows.ps1');
  assert.ok(/mem context/.test(body), 'the isolated block does not even contain the mem-context line');
  // The Stop / UserPromptSubmit / PreToolUse heredocs must NOT leak in —
  // each carries a comment naming the lane it delegates to, unique to
  // that heredoc.
  for (const foreign of ['mem-stop.ps1', 'mem-retrieve.ps1', 'mem-before-edit.ps1']) {
    assert.ok(!body.includes(foreign),
      `startHookHeredoc() pulled in ${foreign} — it is reading past the SessionStart heredoc`);
  }
});

test('POSITIVE CONTROL: a synthetic pair with a missing call is reported', () => {
  const sh = shellCalls('node "$CHEAP_MEM_ROOT/bin/mem" context --n 10\n'
    + 'node "$CHEAP_MEM_ROOT/bin/mem" doctor --alarm\n');
  const ps = powershellCalls('& node `$mem context --n 10\n');
  const { missingInPs, missingInSh } = missingCalls(sh, ps);
  assert.deepEqual(missingInPs, ['doctor --alarm'],
    'a call present in the shell hook and absent from the PowerShell one was not reported');
  assert.deepEqual(missingInSh, []);
});

test('the embedded Windows SessionStart hook calls what the POSIX one calls', () => {
  const shText = fs.readFileSync(SH_PATH, 'utf8');
  const ps1Text = fs.readFileSync(PS1_PATH, 'utf8');
  const sh = shellCalls(shText);
  const ps = powershellCalls(startHookHeredoc(ps1Text));
  const { missingInPs, missingInSh } = missingCalls(sh, ps);

  assert.deepEqual(missingInPs, [],
    'install/windows.ps1\'s embedded SessionStart hook is missing calls that '
    + 'install/hooks/session-start.sh makes — a Windows session starts with less '
    + `than a Linux/macOS one:\n  ${missingInPs.join('\n  ')}\n`
    + 'Add the call to the heredoc in install/windows.ps1, or add a named, reasoned '
    + 'exemption to EXEMPT in this file if it is genuinely Unix-only.');
  assert.deepEqual(missingInSh, [],
    'install/windows.ps1\'s embedded SessionStart hook calls something '
    + `install/hooks/session-start.sh does not:\n  ${missingInSh.join('\n  ')}`);
});

test('the exemption list, if used, gives each entry a real reason', () => {
  for (const [call, reason] of EXEMPT) {
    assert.ok(reason && reason.length >= 20,
      `EXEMPT["${call}"] has no reason of real length — that is a silencer, not an exemption`);
  }
});
