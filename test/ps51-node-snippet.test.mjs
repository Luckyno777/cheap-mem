// CI run 1180 - two Windows twins delivered ZERO bytes, with nothing on stderr.
//
// **The finding.** test/installed-hooks-run.test.mjs starts the installed .ps1 hooks bare on windows-latest. After the
// BOM repair of run 1141, three of the five lanes delivered (user-prompt, pre-edit, after-failure); catch-fail and
// subagent-start stayed mute with an empty stderr. Line for line against the three that work, the shims are the
// same (install/windows.ps1 writes them from one pattern), stdin is read the same way and the encodings are set the
// same way. One thing differs: the three that work hand their stdin to a node FILE (`node <core>.mjs`), the two
// that are mute hand it to a `node -e <snippet>` - and both snippets carried double quotes.
//
// Windows PowerShell 5.1 passes an argument to a native command by wrapping it in double quotes when it holds a
// blank (NativeCommandParameterBinder, `NeedQuotes`), and it does not escape the double quotes inside it. node's
// command line is split by the C runtime's rules, where the inner double quotes toggle quoting: the snippet arrives
// mangled (both twins' first line `let d = "";` became `let d = ";`), node stops at a SyntaxError (exit 1), and the
// twin threw that stderr away (`2>$null`) and exited 0 with nothing. PowerShell 7.3 and later escape the inner quotes; 5.1, the host
// install/windows.ps1 registers (`powershell -NoProfile -File`), does not.
//
// What this file holds, without a Windows machine:
//   - a model of the two halves of that hand-over (5.1's quoting, the C runtime's splitting), with a positive
//     control: the documented 5.1 case `& node -e 'console.log("hi")'` arrives as `console.log(hi)`;
//   - THE RULE: every `node -e` snippet in a shipped .ps1 (the twins and the hooks install/windows.ps1 writes)
//     arrives as ONE argument, byte for byte - no double quote, no trailing backslash - and the list of snippets is
//     fixed here, so a new one is a decision;
//   - the two snippets end to end through the model: at the base (f059670, main at run 1180) node got the mangled
//     text and printed nothing; now the catch-fail snippet prints the signature and the subagent snippet the block;
//   - the trace of both twins (MEM_CATCH_FAIL_TRACE, MEM_SUBAGENT_START_TRACE, the way MEM_BEFORE_EDIT_TRACE works):
//     every exit names itself, on stderr only, with lengths and exit codes and never a hook JSON or an answer, and
//     the installed-hooks probe switches both on.
// What only the next Windows CI run shows: that 5.1 on the runner behaves as modelled here. If a lane is still mute,
// its trace line now says where it stopped.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
// main at CI run 1180 (run id 39036354164): the last commit with the double-quoted snippets.
const BASE = 'f0596700daf13244a021dc715abb5bffdfcb5820';

// ---- the model -------------------------------------------------------------------------------------------------

/**
 * One argument as Windows PowerShell 5.1 writes it into a native command line (legacy argument passing): wrapped in
 * double quotes when it holds a blank outside an even count of quotes, inner double quotes left as they are.
 */
export function ps51Arg(arg) {
  let quotes = 0;
  let afterBackslash = false;
  let need = false;
  for (const ch of arg) {
    if (ch === '"' && !afterBackslash) quotes += 1;
    else if (/\s/.test(ch) && quotes % 2 === 0) need = true;
    afterBackslash = ch === '\\';
  }
  return need ? `"${arg}"` : arg;
}

/**
 * A command line split into arguments by the C runtime's rules (what node.exe's `wmain` receives): blanks and tabs
 * outside quotes separate; 2n backslashes before a quote give n and the quote toggles, 2n+1 give n and a literal
 * quote; `""` inside quotes is one literal quote; other backslashes are literal; a line end is an ordinary character.
 */
export function crtSplit(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  let has = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i] === '\\') { n += 1; i += 1; }
      if (line[i] === '"') {
        cur += '\\'.repeat(n >> 1);
        if (n % 2) { cur += '"'; i += 1; }
      } else {
        cur += '\\'.repeat(n);
      }
      has = true;
      continue;
    }
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i += 2; has = true; continue; }
      inQuote = !inQuote;
      has = true;
      i += 1;
      continue;
    }
    if ((c === ' ' || c === '\t') && !inQuote) {
      if (has) { out.push(cur); cur = ''; has = false; }
      i += 1;
      continue;
    }
    cur += c;
    has = true;
    i += 1;
  }
  if (has) out.push(cur);
  return out;
}

/** The arguments node receives for `& node <args...>` under Windows PowerShell 5.1. */
const throughPs51 = (args) => crtSplit(args.map(ps51Arg).join(' '));

test('the model: the documented 5.1 cases, and an argument with blanks but no quote arrives whole', () => {
  // PowerShell issue 1995, the case everyone meets: the inner quotes are gone.
  assert.deepEqual(throughPs51(['-e', 'console.log("hi")']), ['-e', 'console.log(hi)']);
  // With a blank, the argument is cut where the quotes toggle.
  assert.deepEqual(throughPs51(['-e', 'let d = ""; f("a b")']), ['-e', 'let d = "; f(a', 'b)']);
  // The shapes the repaired snippets use survive: blanks, single quotes, template literals, regex backslashes,
  // line ends.
  const ok = "let d = '';\nconst q = `${a} ${b}`; d.replace(/^[\\uFEFF\\s]+/, '');\n";
  assert.deepEqual(throughPs51(['-e', ok, 'file:///C:/x/y.mjs']), ['-e', ok, 'file:///C:/x/y.mjs']);
});

// ---- the rule over every shipped .ps1 ------------------------------------------------------------------------

/** Every `node -e $Var` in a .ps1 text with the value its variable is given (here-string or single-quoted string). */
function snippets(text) {
  const out = [];
  const calls = /&\s*node\s+-e\s+`?\$(\w+)/g;
  let m;
  while ((m = calls.exec(text))) {
    const name = m[1];
    const here = new RegExp(`\`?\\$${name} = @'\\r?\\n([\\s\\S]*?)\\r?\\n'@`).exec(text);
    const single = new RegExp(`\`?\\$${name} = '((?:[^']|'')*)'`).exec(text);
    const value = here ? here[1] : single ? single[1].replace(/''/g, "'") : null;
    assert.ok(value !== null, `$${name}: a node -e snippet whose value this probe cannot find - the extraction needs updating`);
    out.push({ name, value });
  }
  return out;
}

const PS1_FILES = () => [
  ...fs.readdirSync(path.join(REPO, 'bin')).filter((f) => f.endsWith('.ps1')).map((f) => `bin/${f}`),
  ...fs.readdirSync(path.join(REPO, 'install')).filter((f) => f.endsWith('.ps1')).map((f) => `install/${f}`),
];

test('THE RULE: every node -e snippet in a shipped .ps1 reaches node as one argument, byte for byte (5.1 included)', () => {
  const found = [];
  for (const rel of PS1_FILES()) {
    const text = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');
    for (const s of snippets(text)) {
      found.push(`${rel} $${s.name}`);
      assert.ok(!s.value.includes('"'), `${rel} $${s.name}: a double quote in a node -e snippet - Windows PowerShell 5.1 passes it unescaped and node cuts the snippet apart there`);
      assert.ok(!s.value.endsWith('\\'), `${rel} $${s.name}: ends in a backslash, which escapes the closing quote 5.1 adds`);
      assert.deepEqual(throughPs51(['-e', s.value, 'file:///C:/m.mjs']), ['-e', s.value, 'file:///C:/m.mjs'],
        `${rel} $${s.name}: does not arrive whole`);
    }
  }
  // The list, so a new snippet (or one that went away) is a decision, not an accident.
  assert.deepEqual([...new Set(found)].sort(), [
    'bin/mem-catch-fail.ps1 $CheckScript', 'bin/mem-digest.ps1 $CountScript', 'bin/mem-digest.ps1 $SelectScript',
    'bin/mem-stop.ps1 $CheckScript', 'bin/mem-stop.ps1 $ReportScript', 'bin/mem-subagent-start.ps1 $Script',
    'install/windows.ps1 $bookScript', 'install/windows.ps1 $provScript',
  ]);
});

// ---- the two mute lanes, end to end through the model ---------------------------------------------------------

function world(t) {
  const root = tempDir('cm-ps51-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  memory.logEntry(root, 'error', { class: 'race', title: 'lockfile race - two runs overwrote the lock file',
    text: 'the sperrdatei-rennen probe failed: two test runs overwrote the same lock file at once' });
  return root;
}

const snippetOf = (tree, rel, name) => {
  const s = snippets(fs.readFileSync(path.join(tree, ...rel.split('/')), 'utf8')).find((x) => x.name === name);
  assert.ok(s, `${rel}: no $${name}`);
  return s.value;
};

/** node started with the arguments 5.1 makes of `& node -e <snippet> <extra...>`. */
const nodeVia51 = (snippet, extra, stdin, env) => spawnSync(process.execPath, throughPs51(['-e', snippet, ...extra]), {
  input: stdin, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env },
});

let baseTree = null;
function base() {
  if (!baseTree) {
    baseTree = tempDir('cm-ps51-base-', null);
    process.on('exit', () => fs.rmSync(baseTree, { recursive: true, force: true }));
    exportCommit(REPO, BASE, ['bin/mem-catch-fail.ps1', 'bin/mem-subagent-start.ps1'], baseTree);
  }
  return baseTree;
}

test('catch-fail: the check snippet through 5.1 prints the signature; at the base node got a mangled text and printed nothing', () => {
  const json = JSON.stringify({ session_id: 'ps51-1', tool_name: 'Bash', tool_input: { command: 'npm test 2>&1 | tail -20' },
    tool_response: { stdout: 'TAP version 13\nok 1 - reading works\nnot ok 2 - lockfile race: two runs overwrote the lock file\n# fail 1', stderr: '' } });
  const env = { MEM_ERRSIG: path.join(REPO, 'src', 'errorsignature.mjs') };
  const now = snippetOf(REPO, 'bin/mem-catch-fail.ps1', 'CheckScript');
  const direct = spawnSync(process.execPath, ['-e', now], { input: json, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /"sig":"not ok 2 - lockfile race/, 'the snippet finds no signature at all - the comparison would hold nothing');
  const via = nodeVia51(now, [], json, env);
  assert.equal(via.status, 0, via.stderr);
  assert.equal(via.stdout, direct.stdout, 'through 5.1 the snippet answers differently');

  // RED PROOF: the base's snippet, the same hand-over.
  const old = snippetOf(base(), 'bin/mem-catch-fail.ps1', 'CheckScript');
  const oldDirect = spawnSync(process.execPath, ['-e', old], { input: json, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(oldDirect.stdout, direct.stdout, 'positive control: the base snippet, handed over whole, answers the same');
  assert.notDeepEqual(throughPs51(['-e', old]), ['-e', old], 'the base snippet already arrived whole');
  const oldVia = nodeVia51(old, [], json, env);
  assert.equal(oldVia.stdout, '', 'the base snippet already answered through 5.1');
  assert.notEqual(oldVia.status, 0, 'node ran the mangled base snippet without an error - the model does not show the defect');
});

test('subagent-start: the snippet through 5.1 prints the block; at the base node got a mangled text and printed nothing', (t) => {
  const root = world(t);
  const url = pathToFileURL(path.join(REPO, 'src', 'subagentstart.mjs')).href;
  const json = JSON.stringify({ session_id: 'ps51-2', hook_event_name: 'SubagentStart', agent_type: 'general-purpose', cwd: root });
  const env = { CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '' };
  const now = snippetOf(REPO, 'bin/mem-subagent-start.ps1', 'Script');
  const via = nodeVia51(now, [url], json, env);
  assert.equal(via.status, 0, via.stderr);
  assert.match(JSON.parse(via.stdout).hookSpecificOutput.additionalContext, /lockfile race/, 'the block lacks the fixture entry');

  const old = snippetOf(base(), 'bin/mem-subagent-start.ps1', 'Script');
  const oldDirect = spawnSync(process.execPath, ['-e', old, url], { input: json, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(oldDirect.stdout, /lockfile race/, 'positive control: the base snippet, handed over whole, answers');
  const oldVia = nodeVia51(old, [url], json, env);
  assert.equal(oldVia.stdout, '', 'the base snippet already answered through 5.1');
  assert.notEqual(oldVia.status, 0, 'node ran the mangled base snippet without an error - the model does not show the defect');
});

// ---- the trace of the two twins ------------------------------------------------------------------------------

/** The code lines of a .ps1: comments and the bodies of here-strings left out. */
function codeLines(text) {
  const out = [];
  let inHere = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (inHere) { if (/^'@/.test(line)) inHere = false; continue; }
    if (/@'\s*$/.test(line)) { inHere = true; out.push(line); continue; }
    if (/^\s*#/.test(line) || !line.trim()) continue;
    out.push(line);
  }
  return out;
}

const TWINS = [
  { rel: 'bin/mem-catch-fail.ps1', sw: 'MEM_CATCH_FAIL_TRACE', tag: 'mem-catch-fail' },
  { rel: 'bin/mem-subagent-start.ps1', sw: 'MEM_SUBAGENT_START_TRACE', tag: 'mem-subagent-start' },
];
// What a trace line may say of these only as a length: what came in, what node answered, what goes out.
const CONTENT = /\$(In|Parsed|Fields|Sig|Query|SessionId|Hits|Block|Out)\b(?!\.Length)/;

for (const tw of TWINS) {
  test(`${tw.rel}: every exit names itself under ${tw.sw}, on stderr only, and never with content`, () => {
    const text = fs.readFileSync(path.join(REPO, ...tw.rel.split('/')), 'utf8');
    const lines = codeLines(text);
    // Both helpers write to stderr and only behind the switch.
    for (const fn of ['Write-Trace', 'Write-Note']) {
      const at = lines.findIndex((l) => l.startsWith(`function ${fn} `));
      assert.ok(at >= 0, `${tw.rel}: no ${fn}`);
      assert.equal(lines[at + 1].trim(), `if ($env:${tw.sw} -eq '1') { [Console]::Error.WriteLine("${tw.tag}: ${fn === 'Write-Trace' ? 'exit at $where' : '$msg'}") }`,
        `${tw.rel}: ${fn} is not "stderr, behind ${tw.sw}"`);
    }
    const first = lines.findIndex((l) => l.startsWith('function Write-Note '));
    let exits = 0;
    lines.forEach((l, i) => {
      if (i <= first) return;
      if (/(^|[\s;{])exit\b/.test(l)) {
        exits += 1;
        assert.ok(/Write-Trace\b/.test(l) || /^\s*Write-Trace\b/.test(lines[i - 1]), `${tw.rel}: an exit without its trace line: ${l.trim()}`);
      }
      if (/Write-(Trace|Note)\b/.test(l) && !l.startsWith('function ')) {
        const said = l.slice(l.search(/Write-(Trace|Note)\b/));
        assert.doesNotMatch(said, CONTENT, `${tw.rel}: a trace line that carries content, not a length: ${l.trim()}`);
      }
    });
    assert.ok(exits >= 5, `${tw.rel}: only ${exits} exits seen - the reader lost the file`);
    assert.match(lines.at(-2), /^Write-Trace "delivered \(\$\(\$\w+\.Length\) chars\)"$/, `${tw.rel}: the delivering end does not name itself`);
  });
}

test('the installed-hooks probe switches both traces on (it is the run that shows them on Windows)', () => {
  const probe = fs.readFileSync(path.join(REPO, 'test', 'installed-hooks-run.test.mjs'), 'utf8');
  for (const tw of TWINS) assert.match(probe, new RegExp(`${tw.sw}: '1'`), `the probe does not set ${tw.sw}`);
});
