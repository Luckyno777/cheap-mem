// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/shim-rest-cm.test.mjs - the four leftovers of the hook-shim review (shim-rest-cm, 2026-10-17).
//
//  1. install/support/tool-missing.sh printed its `systemMessage` JSON with only the backslash and the quote escaped.
//     A tab or a line break in a path (CHEAP_MEM_CODE) made the line invalid JSON, which Claude Code drops: the
//     message that exists to say "this hook is mute" was itself mute. Now every U+0000..U+001F (and DEL) is escaped.
//  2. A CHEAP_MEM_CODE with a control character is REJECTED by the shims (bin/_owntool.sh `mem_code_clean`, the
//     PowerShell shims, bin/_owntool.ps1): the start hook prints the value into the session's context, where a line
//     break starts a line of someone else's choosing. Loud (stderr, the missing-tool message), never a crash. A
//     trailing separator is cleaned.
//  3. The PowerShell twins call their helpers (_headless.ps1, the own-tool rule, the missing-tool helper) with
//     separate arguments, never by assembling a command string. Static ratchet. (And, since ps1-pfade-cm: EVERY
//     path cmdlet on EVERY line of every shipped .ps1 takes -LiteralPath, see below.)
//  4. Typographic quotes. Windows PowerShell 5.1 reads a .ps1 without a byte-order mark as ANSI, and PowerShell
//     itself takes U+2018 U+2019 U+201A U+201B as single quotes. Every shipped .ps1 is ASCII already (see
//     test/powershell-ascii.test.mjs) - but the installer BAKES two paths into the shims it writes, and those
//     carry whatever the folder is called. They are now doubled for every quote character, and the shims are written
//     with a byte-order mark on every PowerShell.
//
// Red proof against the base (2f0981b, recorded in the commit message): the JSON probe throws on the old script,
// the shim probes find the raw value, the quote probe fails on the old doubling rule. Positive controls are inside
// each test: the detector must fire on the old shape and stay quiet on the right one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTree } from './fixture/cleanup.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const MISSING = path.join(REPO, 'install', 'support', 'tool-missing.sh');
const OWNTOOL_SH = path.join(REPO, 'bin', '_owntool.sh');
const posix = (p) => p.replace(/\\/g, '/');

const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };

/** The environment of a hook run: bare, the scratch HOME and state directory, nothing of the real user. */
function envOf(dir, extra = {}) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    ...(WIN ? process.env : {}),
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    ...extra,
  };
}
const RAW_CONTROL = /[\x00-\x1f\x7f]/;
const BAD_CODE = '/no/such\tdir\nINJECTED LINE\x01\x1b[2J\x7f"q\\';

// ---------------------------------------------------------------------------
// 1. tool-missing.sh: the JSON line
// ---------------------------------------------------------------------------

test('tool-missing: a path with a tab, a line break and an escape comes out as valid JSON', () => {
  const dir = temp('cm-shim-tm-');
  const r = spawnSync('bash', [MISSING, 'user-prompt', 'mem-retrieve'], {
    cwd: dir, encoding: 'utf8', env: envOf(dir, { CHEAP_MEM_CODE: BAD_CODE }),
  });
  assert.equal(r.status, 0, 'a hook must never fail the session');
  const line = r.stdout.trim();
  assert.ok(!line.includes('\n'), 'the JSON must be ONE line');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `invalid JSON: ${JSON.stringify(line)}`);
  assert.match(parsed.systemMessage, /user-prompt hook is SILENT/);
  // The path is shown, printable: no raw control character reaches the person's terminal or the JSON value.
  assert.ok(!RAW_CONTROL.test(parsed.systemMessage), 'a raw control character in the message');
  assert.match(parsed.systemMessage, /INJECTED LINE/, 'the value is shown (escaped), not dropped');
  assert.ok(!RAW_CONTROL.test(r.stderr.replace(/\n$/, '')), 'a raw control character on stderr');
});

test('tool-missing: every control character U+0001..U+001F and DEL survives a round trip through the JSON line', () => {
  // The hook name is the one value that reaches the message raw; each control character is sent through it.
  // It travels through the ENVIRONMENT into the script's first argument, not on the command line: on Windows the
  // MSYS bash splits its command line at a raw line feed and carriage return (CI run 1205, only U+000A and U+000D
  // "lost"), so the script never saw the character the probe meant to send. An environment value keeps every byte
  // here, as the CHEAP_MEM_CODE probe above shows on Windows too.
  const dir = temp('cm-shim-tmc-');
  const codes = [...Array.from({ length: 31 }, (_, i) => i + 1), 0x7f];
  const bad = [];
  for (const c of codes) {
    const name = `a${String.fromCharCode(c)}b`;
    const r = spawnSync('bash', ['-c', 'exec bash "$1" "$CM_HOOK_NAME" mem-retrieve', 'probe', posix(MISSING)], {
      cwd: dir, encoding: 'utf8', env: envOf(dir, { CHEAP_MEM_CODE: path.join(dir, 'gone'), CM_HOOK_NAME: name }),
    });
    let ok = r.status === 0;
    if (ok) {
      try { ok = JSON.parse(r.stdout.trim()).systemMessage.includes(`the ${name} hook`); } catch { ok = false; }
    }
    if (!ok) bad.push(`U+${c.toString(16).padStart(4, '0')}`);
  }
  assert.deepEqual(bad, [], 'these control characters break the JSON line or are not kept');
});

test('tool-missing POSITIVE CONTROL: the old two-step escape does make the same message invalid JSON', () => {
  // The probe above only means something if the old shape fails it. The old script escaped the backslash and the
  // quote and nothing else; this runs exactly that on a message with a tab and a line break.
  const msg = `cheap-mem: the hook is SILENT (CHEAP_MEM_CODE=${BAD_CODE} does not exist)`;
  const old = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  assert.throws(() => JSON.parse(`{"systemMessage":"${old}"}`), 'the detector does not see the old defect');
  // And the plain case still reads (the escape did not damage an ordinary message).
  const dir = temp('cm-shim-tmp-');
  const plain = path.join(dir, 'gone');
  const r = spawnSync('bash', [MISSING, 'pre-edit', 'mem-before-edit'], {
    cwd: dir, encoding: 'utf8', env: envOf(dir, { CHEAP_MEM_CODE: plain }),
  });
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.systemMessage.includes(`CHEAP_MEM_CODE=${plain} does not exist`), parsed.systemMessage);
});

test('tool-missing: a rejected value (MEM_CODE_REJECTED) speaks even though CHEAP_MEM_CODE is gone', () => {
  const dir = temp('cm-shim-tmr-');
  const quiet = spawnSync('bash', [MISSING, 'user-prompt', 'mem-retrieve'], { cwd: dir, encoding: 'utf8', env: envOf(dir) });
  assert.equal(quiet.stdout, '', 'nothing configured, nothing promised: silent');
  const r = spawnSync('bash', [MISSING, 'user-prompt', 'mem-retrieve'], {
    cwd: dir, encoding: 'utf8', env: envOf(dir, { MEM_CODE_REJECTED: "$'a\\nb'" }),
  });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout.trim()).systemMessage, /CHEAP_MEM_CODE was rejected because it contains a control character/);
});

// ---------------------------------------------------------------------------
// 2. CHEAP_MEM_CODE in the shims
// ---------------------------------------------------------------------------

function makeMemory(dir) {
  const root = path.join(dir, 'memory');
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{}\n');
  return root;
}

const SHIMS = ['user-prompt', 'pre-edit', 'subagent-start', 'session-stop', 'catch-fail', 'after-failure'];

for (const hook of SHIMS) {
  test(`${hook}.sh: a CHEAP_MEM_CODE with a control character is rejected - loud, exit 0, valid JSON`, () => {
    const dir = temp(`cm-shim-${hook}-`);
    const root = makeMemory(dir);
    const r = spawnSync('bash', [path.join(REPO, 'install', 'hooks', `${hook}.sh`)], {
      cwd: dir, encoding: 'utf8', input: '{}',
      env: envOf(dir, { CHEAP_MEM_ROOT: root, CHEAP_MEM_CODE: BAD_CODE }),
    });
    assert.equal(r.status, 0, `a hook must never fail the session: ${r.stderr}`);
    assert.match(r.stderr, /CHEAP_MEM_CODE rejected: it contains a control character/);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout.trim()); }, `invalid JSON: ${JSON.stringify(r.stdout)}`);
    assert.match(parsed.systemMessage, /rejected/);
    assert.ok(!RAW_CONTROL.test(parsed.systemMessage), 'a raw control character in the message');
  });
}

test('session-start.sh: the rejected value is not printed into the context - no line of its choosing', () => {
  const dir = temp('cm-shim-ss-');
  const root = makeMemory(dir);
  const run = (code) => spawnSync('bash', [path.join(REPO, 'install', 'hooks', 'session-start.sh')], {
    cwd: dir, encoding: 'utf8', input: '{}', env: envOf(dir, { CHEAP_MEM_ROOT: root, CHEAP_MEM_CODE: code }),
  });
  // POSITIVE CONTROL: with a harmless path the same words ARE printed - so the probe could have seen them.
  const plain = run(path.join(dir, 'gone', 'INJECTED LINE'));
  assert.match(plain.stdout, /CHEAP_MEM_CODE=.*INJECTED LINE/, 'the control value never reached the output');
  const r = run(BAD_CODE);
  assert.equal(r.status, 0);
  const lines = r.stdout.split('\n');
  assert.ok(!lines.some((l) => l.startsWith('INJECTED LINE')), 'a line of the value\'s own making in the context');
  assert.ok(!RAW_CONTROL.test(r.stdout.replace(/\n/g, '')), 'a raw control character in the context');
  assert.match(r.stdout, /was REJECTED: CHEAP_MEM_CODE holds a control character/);
  assert.match(r.stdout, /NOT attached/);
  assert.equal(r.stdout.includes('(installed: not set)'), false, 'a rejected value must not read as "not set"');
});

// The hook is installed ALONE (~/.claude/hooks/session-start.sh); when cheap-mem-own-tool.sh is not next to it the
// library never runs, mem_code_clean with it, and the raw CHEAP_MEM_CODE reached the session's context (ps1-pfade-cm).
function runStartAlone(dir, script, code) {
  const hooks = path.join(dir, 'hooks-alone');
  fs.mkdirSync(hooks, { recursive: true });
  const copy = path.join(hooks, 'session-start.sh');
  fs.writeFileSync(copy, script);
  const root = makeMemory(dir);
  return spawnSync('bash', [copy], {
    cwd: dir, encoding: 'utf8', input: '{}', env: envOf(dir, { CHEAP_MEM_ROOT: root, CHEAP_MEM_CODE: code }),
  });
}

test('session-start.sh installed WITHOUT the own-tool library: the control value is rejected there too, not printed', () => {
  const dir = temp('cm-shim-ssa-');
  const script = read('install/hooks/session-start.sh');
  // POSITIVE CONTROL 1: with the inline rejection cut out, the same run DOES put the value's own line into the context.
  const cut = script.replace(/if ! type mem_code_clean[\s\S]*?\n {2}esac\nfi\n/, '');
  assert.notEqual(cut, script, 'the inline rejection is not where the probe looks for it');
  const old = runStartAlone(dir, cut, BAD_CODE);
  assert.ok(old.stdout.split('\n').some((l) => l.startsWith('INJECTED LINE')), 'POSITIVE CONTROL: the old shape did not leak - the probe cannot see the defect');
  // POSITIVE CONTROL 2: a harmless path is still printed, so the words could have been seen.
  const plain = runStartAlone(dir, script, path.join(dir, 'gone', 'INJECTED LINE'));
  assert.match(plain.stdout, /CHEAP_MEM_CODE=.*INJECTED LINE/);
  const r = runStartAlone(dir, script, BAD_CODE);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.split('\n').some((l) => l.startsWith('INJECTED LINE')), 'a line of the value\'s own making in the context');
  assert.ok(!RAW_CONTROL.test(r.stdout.replace(/\n/g, '')), 'a raw control character in the context');
  assert.match(r.stdout, /was REJECTED: CHEAP_MEM_CODE holds a control character/);
  assert.equal(r.stdout.includes('(installed: not set)'), false, 'a rejected value must not read as "not set"');
  assert.match(r.stderr, /CHEAP_MEM_CODE rejected: it contains a control character/);
});

test('_owntool.sh: a trailing separator is cleaned, a good path is untouched, the tool is still found', () => {
  const dir = temp('cm-shim-trail-');
  const code = path.join(dir, 'code');
  fs.mkdirSync(path.join(code, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(code, 'bin', 'mem-retrieve'), '# tool\n');
  const root = makeMemory(dir);
  const probe = (value) => {
    const r = spawnSync('bash', ['-c', '. "$1"; mem_pick_tool "$2" bin/mem-retrieve; printf "%s\\n%s\\n%s\\n" "${CHEAP_MEM_CODE-unset}" "$mem_picked" "${MEM_CODE_REJECTED-}"', 'x', posix(OWNTOOL_SH), posix(root)], {
      cwd: dir, encoding: 'utf8', env: envOf(dir, { CHEAP_MEM_CODE: value }),
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n');
  };
  const good = posix(code);
  assert.deepEqual(probe(good).slice(0, 2), [good, `${good}/bin/mem-retrieve`], 'POSITIVE CONTROL: a good path is found as it is');
  const slashed = probe(`${good}///`);
  assert.deepEqual(slashed.slice(0, 2), [good, `${good}/bin/mem-retrieve`], 'the trailing separators are cleaned');
  // The root alone stays the root (nothing is stripped to an empty string).
  assert.equal(probe('/')[0], '/');
  // A control character: rejected, CHEAP_MEM_CODE gone, the printable form handed on.
  const bad = probe(`${good}\nX`);
  assert.equal(bad[0], 'unset');
  assert.equal(bad[1], '', 'a rejected value must not pick a tool');
  assert.match(bad[2], /\\n/, 'the printable form is handed on');
});

test('the PowerShell shims reject the same value, and say so through the missing-tool helper', () => {
  const win = read('install/windows.ps1');
  const own = read('bin/_owntool.ps1');
  // Seven shims bake a code path (start, stop, prompt, edit, catch-fail, after-failure, subagent): each checks it.
  const checks = win.match(/if \(`\$codeRoot -match '\[\\x00-\\x1f\\x7f\]'\)/g) ?? [];
  assert.equal(checks.length, 7, 'every shim that reads CHEAP_MEM_CODE rejects a control character');
  // The six that call the missing-tool helper hand the rejection on.
  const calls = win.match(/& `\$missing -Name '[a-z-]+'[^\n]*-Rejected:`\$codeRejected \}/g) ?? [];
  assert.equal(calls.length, 6, 'every call of the missing-tool helper carries -Rejected');
  assert.match(win, /param\(\[string\]\$Name, \[string\]\$Tool, \[string\]\$Code, \[string\]\$Root, \[switch\]\$Skipped, \[switch\]\$Rejected\)/);
  assert.match(win, /if \(-not \$Code -and -not \$Skipped -and -not \$Rejected\) \{ exit 0 \}/);
  assert.match(own, /\$env:CHEAP_MEM_CODE -and \$env:CHEAP_MEM_CODE -notmatch '\[\\x00-\\x1f\\x7f\]'/);
  // The class the PowerShell side uses is the class the bash side uses: control characters and DEL.
  for (const c of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f]) {
    assert.ok(/[\x00-\x1f\x7f]/.test(String.fromCharCode(c)), `U+${c.toString(16)} is not in the class`);
  }
  assert.ok(!/[\x00-\x1f\x7f]/.test(' ') && !/[\x00-\x1f\x7f]/.test('/'), 'the class takes an ordinary path');
});

// ---------------------------------------------------------------------------
// 3. The PowerShell twins call their helpers with arguments, not with an assembled string
// ---------------------------------------------------------------------------

function powershellScripts() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.ps1$/i.test(e.name)) out.push({ rel: path.relative(REPO, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(REPO);
  return out;
}

// A line that starts, loads or names a helper: the headless plan, the own-tool rule, the missing-tool helper.
const HELPER = /_headless\.ps1|_owntool\.ps1|cheap-mem-own-tool\.ps1|cheap-mem-tool-missing\.ps1|mem-headless\.mjs|HeadlessHelper|\$missing\b|\$OwnToolLib\b|\$ownLib\b/;
// A line that only SAYS something (a hint with a command in it) starts nothing.
const SAYS = /^\s*(Note|Write-Host|Write-Warning|Write-Output|Write-Error|\[Console\]::Error\.WriteLine|Write-Verbose)\b/;

/** What is wrong with the way a line calls a helper; [] when nothing. Backticks of the installer's here-strings are removed first. */
function helperCallProblems(rawLine) {
  const line = rawLine.replace(/`(\$)/g, '$1');
  if (/^\s*#/.test(line) || !HELPER.test(line) || SAYS.test(line)) return [];
  const bad = [];
  if (/\bInvoke-Expression\b|\biex\b/i.test(line)) bad.push('Invoke-Expression');
  if (/-Command\b/i.test(line)) bad.push('-Command');
  if (/(^|[;{(|]\s*|^\s*)(&|\.)\s+["']/.test(line)) bad.push('call or dot-source of a string literal');
  if (/\bStart-Process\b[^\n]*-ArgumentList\s+["']/.test(line)) bad.push('Start-Process with an argument string');
  // A double-quoted string that carries a variable AND an option: an argument line put together by hand.
  if (/(^|[;{(|]\s*|^\s*)&[^\n]*"[^"\n]*\$[^"\n]*\s-{1,2}[A-Za-z][^"\n]*"/.test(line)) bad.push('an argument string assembled with an option in it');
  return bad;
}

// ---- Every path cmdlet takes its path as -LiteralPath (ps1-pfade-cm, 2026-10-17) -------------------------------------
// -Path (and the positional first argument) reads `[` and `]` as a wildcard class: a memory folder called
// `notes [work]` is "not found", and a hook that cannot find its memory is silent. The cmdlets below all have
// -LiteralPath. This reads EVERY line of EVERY shipped .ps1 (the installer's here-strings included, backticks
// removed), not only the lines that name a helper.
const PATH_CMDLETS = [
  'Test-Path', 'Get-Item', 'Get-ChildItem', 'Get-Content', 'Set-Content', 'Add-Content', 'Clear-Content', 'Out-File',
  'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Resolve-Path', 'Select-String', 'Set-Location',
  'Push-Location', 'Get-ItemProperty', 'Set-ItemProperty', 'Import-Clixml', 'Export-Clixml', 'Get-FileHash',
  'Unblock-File', 'Get-Acl', 'Set-Acl',
];
// Aliases count only where a command can stand (line start, after ; { ( | &), so a word in a string is not one.
const PATH_ALIASES = ['ls', 'dir', 'gci', 'cat', 'gc', 'sc', 'ac', 'rm', 'ri', 'del', 'cp', 'copy', 'mv', 'move', 'sl', 'cd', 'pushd'];
const PATH_CMD_RE = new RegExp(
  `(?<![\\w$.:-])(${PATH_CMDLETS.join('|')})(?![\\w-])|(?:^\\s*|[;{(|&=]\\s*)(${PATH_ALIASES.join('|')})(?=\\s)`, 'gi');
// Cmdlets deliberately NOT in the list: New-Item (and `md`/`mkdir`) have no -LiteralPath and take -Path as it
// is - "Accept wildcard characters: False" in the cmdlet's own help; a directory is created, never searched for.
// Allowed without -LiteralPath, each with its reason:
const PATH_ALLOWED = [
  // An environment variable reached through the Env: drive is a name, not a file path.
  { why: 'Env: drive', re: /^[\w-]+\s+Env:/i },
];

/** True when `idx` of `line` lies inside a quoted string (single or double; a backtick escapes in a double one). */
function inQuote(line, idx) {
  let quote = '';
  for (let i = 0; i < idx; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '`' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
  }
  return quote !== '';
}

/** The text of the statement that starts at `from` in `line`: up to a pipe, `;`, `}` or the `)` that closes the caller. */
function statementAfter(line, from) {
  let depth = 0;
  let quote = '';
  for (let i = from; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '`' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { if (depth === 0) return line.slice(from, i); depth -= 1; }
    else if (depth === 0 && (ch === '|' || ch === ';' || ch === '}')) return line.slice(from, i);
    else if (ch === '#' && /\s/.test(line[i - 1] ?? ' ')) return line.slice(from, i);
  }
  return line.slice(from);
}

/** The path cmdlets a line calls without -LiteralPath; [] when none. A statement that goes on in the next line (a trailing backtick) is joined. */
function pathCallProblems(rawLine, nextLine = '') {
  let line = rawLine.replace(/`(\$)/g, '$1');
  if (/^\s*#/.test(line) || SAYS.test(line)) return [];
  if (/`\s*$/.test(line)) line = `${line.replace(/`\s*$/, ' ')}${nextLine.replace(/`(\$)/g, '$1')}`;
  const bad = [];
  for (const m of line.matchAll(PATH_CMD_RE)) {
    const name = m[1] ?? m[2];
    if (m[2] && inQuote(line, m.index + m[0].length - name.length)) continue;
    const body = statementAfter(line, m.index + m[0].length);
    if (/(^|\s)-LiteralPath\b/i.test(body) || /(^|\s)-PSPath\b/i.test(body)) continue;
    if (PATH_ALLOWED.some((a) => a.re.test(`${name} ${body.trim()}`))) continue;
    bad.push(`${name} without -LiteralPath`);
  }
  return bad;
}

test('POSITIVE CONTROL: the helper-call detector fires on every bad shape and stays quiet on the good ones', () => {
  const bad = [
    'Invoke-Expression ". $PSScriptRoot\\_headless.ps1"',
    'iex (Get-Content (Join-Path $Here "_headless.ps1") -Raw)',
    '. "$PSScriptRoot\\_headless.ps1"',
    '& "$missing -Name x"',
    'powershell -Command ". $OwnToolLib"',
    '& node "$script:HeadlessHelper plan --cmd $Cmd"',
    'Start-Process -FilePath node -ArgumentList "$HeadlessHelper plan"',
  ];
  for (const l of bad) assert.notEqual(helperCallProblems(l).length, 0, `not flagged: ${l}`);
  const good = [
    '. (Join-Path $PSScriptRoot \'_headless.ps1\')',
    'if (Test-Path -LiteralPath $OwnToolLib) { . $OwnToolLib; $OwnToolTrusted = Test-OwnToolTrusted $Root }',
    '  if (Test-Path -LiteralPath `$missing) { & `$missing -Name \'user-prompt\' -Tool \'mem-retrieve.ps1\' -Code `$codeRoot -Skipped:`$skipped }',
    '  $lines = @(& node @a 2>$null)',
    '    & node $script:HeadlessHelper \'cleanup\' $Plan.Clean 2>$null | Out-Null',
    '    Note "  Nothing was started. Run: node `"$Here\\mem-headless.mjs`" plan --cmd `"$Cmd`" --root `"$Root`""',
    '# & "$missing -Name x" (a comment)',
  ];
  for (const l of good) assert.deepEqual(helperCallProblems(l), [], `flagged by mistake: ${l}`);
});

test('every line that names a helper is called with separate arguments (no assembled command string)', () => {
  const files = powershellScripts();
  let seen = 0;
  const found = [];
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, i) => {
      if (!/^\s*#/.test(line) && HELPER.test(line) && !SAYS.test(line)) seen += 1;
      for (const p of helperCallProblems(line)) found.push(`${rel}:${i + 1}: ${p}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(found, []);
  // The walker found the helpers at all (a floor, not an equality): the headless lines of four scripts, the own-tool
  // lines of six hooks and seven installed shims, the missing-tool calls.
  assert.ok(seen >= 40, `only ${seen} helper lines seen - the probe reads the wrong thing`);
  // The headless plan is an ARRAY handed to node, not a line.
  const hl = read('bin/_headless.ps1');
  assert.match(hl, /\$a = @\(\$script:HeadlessHelper, 'plan', '--cmd', \$CmdLine, '--root', \$Root\)/);
  assert.match(hl, /& node @a 2>\$null/);
  // And the sh side: the shims start the helper with `exec bash "$helper" <words>`, quoted.
  for (const hook of [...SHIMS]) {
    assert.match(read(`install/hooks/${hook}.sh`), /exec bash "\$missing_helper" [a-z-]+ mem-[a-z-]+/, `${hook}.sh does not call the helper as arguments`);
  }
});

test('POSITIVE CONTROL: the path-cmdlet detector fires on every bare shape and stays quiet on -LiteralPath', () => {
  const bad = [
    'if (Test-Path $transcriptPath) { }',
    "if (-not (Test-Path (Join-Path $Root '.mem'))) { }",
    "  if (Test-Path (Join-Path `$candidate '.mem\\config.json')) { `$memRoot = `$candidate; break }",
    '$n = (Get-Item $p).Length',
    '$got = @(Get-Content $t -ErrorAction SilentlyContinue)',
    'Remove-Item $GoldOut, $GoldErr -Force -ErrorAction SilentlyContinue',
    'Add-Content -Path $LogPath -Value $line',
    'Set-Content -Path $LockPath -Value $PID',
    'Set-Location $root',
    '& powershell -File $h 2>&1 | Out-File -Append -FilePath $log',
    'if ((Test-Path -LiteralPath $a) -and (Test-Path $b)) { }',
    '$x = gc $p',
    'ls $dir',
    '      sl $root',
    'foreach ($f in (Get-ChildItem $dir)) { }',
  ];
  for (const l of bad) assert.notEqual(pathCallProblems(l).length, 0, `not flagged: ${l}`);
  // A statement that goes on in the next line: the option sits there.
  assert.deepEqual(pathCallProblems('Get-Content `', '  -LiteralPath $p'), []);
  assert.notEqual(pathCallProblems('Get-Content `', '  -Raw').length, 0);
  const good = [
    'if (Test-Path -LiteralPath $transcriptPath) { }',
    "if (-not (Test-Path -LiteralPath (Join-Path $Root '.mem'))) { }",
    "  if (Test-Path -LiteralPath (Join-Path `$candidate '.mem\\config.json')) { `$memRoot = `$candidate; break }",
    '$n = (Get-Item -LiteralPath $p).Length',
    'Remove-Item -LiteralPath $GoldOut, $GoldErr -Force -ErrorAction SilentlyContinue',
    '& powershell -File $h 2>&1 | Out-File -Append -LiteralPath $log',
    'Remove-Item Env:\\MEM_HEADLESS -ErrorAction SilentlyContinue',
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    '# if (Test-Path $x) is a comment',
    'Write-Host "  Get-Content $log -Tail 20 -Wait"',
    'Note "run: Test-Path $x"',
    '$s = "a cd to somewhere"',
    "'Bash(rm -rf:*)', 'Bash(git push --force:*)',",
    '$value = $env:CHEAP_MEM_ROOT -replace "dir", "x"',
  ];
  for (const l of good) assert.deepEqual(pathCallProblems(l), [], `flagged by mistake: ${l}`);
});

test('every line of every shipped .ps1 reads its paths with -LiteralPath (a folder called "notes [work]" is a folder)', () => {
  const files = powershellScripts();
  let seen = 0;
  const found = [];
  for (const { rel, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/^\s*#/.test(line) && !SAYS.test(line)) seen += [...line.matchAll(PATH_CMD_RE)].length;
      for (const p of pathCallProblems(line, lines[i + 1] ?? '')) found.push(`${rel}:${i + 1}: ${p}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(found, []);
  // A floor, not an equality: the walker reads the real scripts (about 120 path calls, the installer's here-strings included).
  assert.ok(seen >= 100, `only ${seen} path-cmdlet calls seen - the probe reads the wrong thing`);
  // The seven shim root searches and the facts file of the start hook: named, since they decide whether a hook is mute.
  const win = read('install/windows.ps1');
  assert.equal((win.match(/Test-Path -LiteralPath \(Join-Path `\$candidate '\.mem\\config\.json'\)\)/g) ?? []).length, 7);
  assert.match(win, /Test-Path -LiteralPath `\$facts/);
  assert.match(win, /Get-Content -LiteralPath `\$facts/);
});

// ---------------------------------------------------------------------------
// 4. Typographic quotes in what the installer bakes into the shims
// ---------------------------------------------------------------------------

/** The characters PowerShell reads as a single quote: the ASCII one and U+2018..U+201B (its tokenizer's list). */
const PS_SINGLE = new Set(["'", '\u2018', '\u2019', '\u201a', '\u201b']);

/** How PowerShell reads `'<body>'`: the string's value, or null when the quote ends early (the rest would be tokens). */
function readSingleQuoted(body) {
  const text = `'${body}'`;
  let value = '';
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (PS_SINGLE.has(ch)) {
      if (i + 1 < text.length && PS_SINGLE.has(text[i + 1])) { value += ch; i += 2; continue; }
      return i === text.length - 1 ? value : null;
    }
    value += ch; i += 1;
  }
  return null;
}

/** The quote characters the installer doubles, read from its own text: the class built in $SingleQuoteChars. */
function bakedQuoteSet(winText) {
  const m = /\$SingleQuoteChars = "\['" \+ ((?:\[char\]0x[0-9a-f]{4}(?: \+ )?)+) \+ "\]"/i.exec(winText);
  assert.ok(m, 'the installer does not build $SingleQuoteChars');
  return new Set(["'", ...[...m[1].matchAll(/0x([0-9a-f]{4})/gi)].map((x) => String.fromCharCode(parseInt(x[1], 16)))]);
}
const doubleWith = (set, p) => [...p].map((c) => (set.has(c) ? c + c : c)).join('');

test('the quote probe: PowerShell reads a curly apostrophe as a closing quote (the old rule fails, the new one holds)', () => {
  const folder = 'C:\\Users\\Sam\u2019s tools\\cheap-mem';
  const asciiOnly = new Set(["'"]);
  // The old rule (`-replace "'", "''"`): the string ends at the curly apostrophe.
  assert.equal(readSingleQuoted(doubleWith(asciiOnly, folder)), null, 'POSITIVE CONTROL: the old rule must fail on a curly apostrophe');
  assert.equal(readSingleQuoted(doubleWith(asciiOnly, "C:\\Users\\O'Brien")), 'C:\\Users\\O\'Brien', 'the old rule still handles the ASCII one');
  const set = bakedQuoteSet(read('install/windows.ps1'));
  for (const c of ["'", '\u2018', '\u2019', '\u201a', '\u201b']) assert.ok(set.has(c), `U+${c.codePointAt(0).toString(16)} is not doubled`);
  for (const p of [folder, "C:\\Users\\O'Brien\\m", 'C:\\a\u2018b\u2019c\u201ad\u201be', 'C:\\plain', "''", '\u2019\u2019']) {
    assert.equal(readSingleQuoted(doubleWith(set, p)), p, `not one string: ${p}`);
  }
});

test('the installer bakes both hints through that rule and writes every hook script with a byte-order mark', () => {
  const win = read('install/windows.ps1');
  assert.match(win, /\$CodeHint = \$RepoRoot -replace \$SingleQuoteChars, '\$0\$0'/);
  assert.match(win, /\$RootHint = \$env:CHEAP_MEM_ROOT -replace \$SingleQuoteChars, '\$0\$0'/);
  assert.doesNotMatch(win, /-replace "'", "''"/, 'the ASCII-only doubling is back');
  // Every generated hook goes through Out-HookScript; none through Set-Content -Encoding UTF8 (no mark on PowerShell 7).
  const sinks = [...win.matchAll(/\|\s*Out-HookScript\s+\$(\w+HookDst)/g)].map((m) => m[1]);
  assert.equal(new Set(sinks).size, 8, `hook scripts written through Out-HookScript: ${sinks.join(', ')}`);
  assert.doesNotMatch(win, /Set-Content\s+-LiteralPath\s+\$\w+HookDst/, 'a hook script is written without the mark again');
  assert.match(win, /New-Object System\.Text\.UTF8Encoding\(\$true\)/, 'the mark is switched off');
  // The file itself stays ASCII (the other ratchet holds that; here the characters are named, not typed).
  assert.ok(/^[\x00-\x7f]*$/.test(win), 'install/windows.ps1 holds a non-ASCII character');
});

test('the rule holds for every shipped .ps1: pure ASCII (no byte-order mark needed), including the curly quotes by name', () => {
  const bad = [];
  for (const { rel, text } of powershellScripts()) {
    for (const ch of text) {
      if (PS_SINGLE.has(ch) && ch !== "'" || ['\u201c', '\u201d', '\u201e'].includes(ch)) bad.push(`${rel}: U+${ch.codePointAt(0).toString(16)}`);
    }
    if (text.startsWith('\ufeff')) bad.push(`${rel}: byte-order mark in a script that is ASCII (the other ratchet would not see it)`);
  }
  assert.deepEqual(bad, []);
});
