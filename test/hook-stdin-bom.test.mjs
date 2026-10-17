// CI run 1141 - Windows PowerShell 5.1 put a UTF-8 byte order mark in front of the hook JSON it piped to node.
//
// The diagnosis came from the twin's own trace on the windows-latest runner: `mem-before-edit: stdin: 103 chars`,
// then the core: `exit at no-readable-path (input 108 bytes, not JSON: SyntaxError)`; the installed-hooks probe saw
// 288 chars become 293 bytes. Five bytes every time: EF BB BF in front, CR LF behind. The CR LF is harmless to
// JSON.parse, the BOM is not - and every hook that hands its JSON to node answered with nothing, exit 0
// (before-edit, recall, catch-fail, after-failure, subagent-start). Where the mark comes from and why
// `$OutputEncoding` did not stop it: src/hookstdin.mjs.
//
// Two halves, as the repair has two:
//   - the cores: BOM + CR LF in, the same answer as without. Driven as processes, the way the twins start them,
//     and against the base commit (2f0981b, CI run 1141) for the red proof: there the same bytes gave nothing,
//     while the plain input answered (positive control: the world is one that answers at all);
//   - the twins: every .ps1 that pipes into node sets a preamble-free console input encoding and a BOM-free
//     $OutputEncoding before its first pipe, and no node snippet in a twin parses its stdin raw. That half is read,
//     not run: there is no Windows PowerShell 5.1 here. What it does on the runner, the next CI run's Windows jobs
//     show (test/before-edit-twin.test.mjs and test/installed-hooks-run.test.mjs run the twins there).
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import { hookText, readHookStdin } from '../src/hookstdin.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
// main at CI run 1141: the last commit without the repair.
const BASE = '2f0981b0a6992fc7402b088653253642ce5d3a18';

/** What PowerShell 5.1 delivered: the mark in front, the line end it appends to every piped string behind. */
const asPs51 = (text) => `\uFEFF${text}\r\n`;

/** The base commit's src/ and bin/ in a directory of this test (red proof). */
function base(t) {
  const dir = tempDir('cm-bom-base-', t);
  exportCommit(REPO, BASE, ['src', 'bin', 'package.json'], dir);
  return dir;
}

function world(t) {
  const root = tempDir('cm-bom-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  memory.logEntry(root, 'error', { class: 'race', title: 'lockfile race - two runs overwrote install/claude-code.sh',
    text: 'install/claude-code.sh: two test runs overwrote the same lock file at once' });
  return root;
}

/** Start one core of `tree` (this checkout or the base) with `stdin`; its stdout. */
function core(tree, rel, args, stdin, env) {
  const r = spawnSync(process.execPath, [path.join(tree, ...rel.split('/')), ...args], {
    input: stdin, encoding: 'utf8', timeout: 60000, env: { ...process.env, MEM_HOOK_OFF: '', ...env },
  });
  assert.equal(r.status, 0, `${rel} ${args.join(' ')}: exit ${r.status}\n${r.stderr}`);
  return r.stdout;
}

/** The hits a recall hook pipes on: `mem find --recall --json` on the world. */
function hits(root) {
  const r = spawnSync(process.execPath, [MEM, '--root', root, 'find', 'lockfile race install/claude-code.sh', '--top', '3', '--recall', '--json'],
    { encoding: 'utf8', env: { ...process.env, MEM_RECALL_SERVER: '0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).hits.length > 0, 'the world finds nothing - every comparison below would be empty against empty');
  return r.stdout;
}

/**
 * The cores the twins pipe into, each with the input its twin hands it and the environment that makes it answer.
 * `fresh(t)` gives each start its own once-per-turn and once-per-file state, so the two starts compared are alike.
 */
const CORES = [
  {
    name: 'before-edit core (bin/mem-before-edit-core.mjs)', rel: 'bin/mem-before-edit-core.mjs', args: [],
    input: () => JSON.stringify({ session_id: 'bom-1', tool_name: 'Edit', tool_input: { file_path: 'C:\\proj\\install\\claude-code.sh' } }),
    env: (root, t) => ({ CHEAP_MEM_ROOT: root, MEM_BEFORE_EDIT_MARKS: tempDir('cm-bom-marks-', t), MEM_BE_ASCII: '1' }),
  },
  {
    name: 'recall (src/recallhook.mjs recall)', rel: 'src/recallhook.mjs', args: ['recall'],
    input: (root) => hits(root),
    env: (root, t) => ({ CHEAP_MEM_ROOT: root, MEM_RH_MIN: '0', MEM_RH_SESSION: '', MEM_RH_TURNS: tempDir('cm-bom-turns-', t) }),
  },
  {
    name: 'catch-fail (src/recallhook.mjs catch)', rel: 'src/recallhook.mjs', args: ['catch'],
    input: (root) => hits(root),
    env: (root) => ({ CHEAP_MEM_ROOT: root, MEM_RH_MIN: '0' }),
  },
  {
    name: 'after-failure (src/afterfailure.mjs parse)', rel: 'src/afterfailure.mjs', args: ['parse'],
    input: () => JSON.stringify({ session_id: 'bom-3', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'lockfile race: two runs overwrote the lock file' }),
    env: (root) => ({ CHEAP_MEM_ROOT: root }),
  },
];

test('hookText: the marks and the blanks in front go, nothing else; what is not a string reads as empty', () => {
  assert.equal(hookText('\uFEFF{"a":1}\r\n'), '{"a":1}\r\n');
  assert.equal(hookText('\uFEFF\uFEFF \r\n\t{"a":1}'), '{"a":1}');
  assert.equal(hookText('{"a":"\uFEFF x"}'), '{"a":"\uFEFF x"}', 'a mark inside the document is content');
  assert.equal(hookText(''), '');
  for (const v of [undefined, null, 7, {}, Buffer.from('x')]) assert.equal(hookText(v), '');
  assert.deepEqual(JSON.parse(hookText(asPs51('{"tool_name":"Edit"}'))), { tool_name: 'Edit' });
  // Positive control of the experiment: the raw PowerShell 5.1 bytes do not parse.
  assert.throws(() => JSON.parse(asPs51('{"tool_name":"Edit"}')), SyntaxError);
});

test('readHookStdin: bytes, decoded once - a character cut by a chunk boundary stays whole, the mark goes', async () => {
  const text = '{"title":"caf\u00e9 \u21b3"}';
  const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
  const cut = bytes.indexOf(0xA9); // the second byte of the e-acute: the chunk ends inside it
  const got = await readHookStdin(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)], { objectMode: false }));
  assert.equal(got, text);
  // The way each core used to read (`d += chunk`) tears it: the control that the cut is real.
  let d = '';
  for (const c of [bytes.subarray(0, cut), bytes.subarray(cut)]) d += c;
  assert.notEqual(d.replace(/^\uFEFF/, ''), text);
});

for (const c of CORES) {
  test(`${c.name}: BOM + CR LF in, the same answer as without; at the base the same bytes gave nothing`, (t) => {
    const root = world(t);
    const plain = c.input(root);
    const want = core(REPO, c.rel, c.args, plain, c.env(root, t));
    assert.ok(want.trim(), `${c.name}: the plain input gives no answer - the comparison would hold nothing`);
    const got = core(REPO, c.rel, c.args, asPs51(plain), c.env(root, t));
    assert.deepEqual(JSON.parse(got || 'null'), JSON.parse(want), `${c.name}: the PowerShell 5.1 bytes changed the answer`);

    // RED PROOF against the base: same world, same bytes.
    const old = base(t);
    assert.ok(core(old, c.rel, c.args, plain, c.env(root, t)).trim(), `${c.name}: the base gives no answer to the plain input - no red proof`);
    assert.equal(core(old, c.rel, c.args, asPs51(plain), c.env(root, t)), '', `${c.name}: the base already answered the PowerShell 5.1 bytes`);
  });
}

test('subagent-start (hookResultFor, the module the twin imports): BOM + CR LF read like the plain JSON', async (t) => {
  const root = world(t);
  const j = JSON.stringify({ session_id: 'bom-4', hook_event_name: 'SubagentStart', agent_id: 'x1', prompt: 'lockfile race in install/claude-code.sh' });
  const env = { ...process.env, MEM_RETRIEVE_MIN: '0.5' };
  const now = await import('../src/subagentstart.mjs');
  const want = JSON.stringify(await now.hookResultFor(root, j, { env }));
  // The block for the TASK (the recap below it names the error either way).
  const forTask = /For your assignment, from cheap-mem/;
  assert.match(want, forTask, 'the plain input brings no block for the task - the comparison would hold nothing');
  assert.equal(JSON.stringify(await now.hookResultFor(root, asPs51(j), { env })), want);
  const old = await import(pathToFileURL(path.join(base(t), 'src', 'subagentstart.mjs')).href);
  assert.match(JSON.stringify(await old.hookResultFor(root, j, { env })), forTask, 'positive control at the base');
  assert.doesNotMatch(JSON.stringify(await old.hookResultFor(root, asPs51(j), { env })), forTask, 'the base already read the PowerShell 5.1 bytes');
});

/** The check snippet of a mem-catch-fail.ps1 text, as the twin hands it to `node -e`. */
function checkSnippet(ps1) {
  const m = /\$CheckScript = @'\r?\n([\s\S]*?)\r?\n'@/.exec(ps1);
  assert.ok(m, 'the check snippet moved - the probe cannot cut it out');
  return m[1];
}

test('the node snippet cut out of mem-catch-fail.ps1 parses the PowerShell 5.1 bytes (the snippet as the twin carries it)', (t) => {
  const snippet = checkSnippet(fs.readFileSync(path.join(REPO, 'bin', 'mem-catch-fail.ps1'), 'utf8'));
  const json = JSON.stringify({ session_id: 'bom-5', tool_name: 'Bash', tool_input: { command: 'npm test' },
    tool_response: { stdout: 'TAP version 13\nnot ok 2 - lockfile race: two runs overwrote the lock file\n# fail 1', stderr: '' } });
  const run = (code, stdin) => spawnSync(process.execPath, ['-e', code], {
    input: stdin, encoding: 'utf8', env: { ...process.env, MEM_ERRSIG: path.join(REPO, 'src', 'errorsignature.mjs') },
  });
  const want = run(snippet, json);
  assert.equal(want.status, 0, want.stderr);
  assert.match(want.stdout, /"sig"/, 'the plain input gives no signature - the comparison would hold nothing');
  assert.equal(run(snippet, asPs51(json)).stdout, want.stdout);
  // RED PROOF: the base's snippet, same bytes.
  const old = checkSnippet(fs.readFileSync(path.join(base(t), 'bin', 'mem-catch-fail.ps1'), 'utf8'));
  assert.equal(run(old, json).stdout, want.stdout, 'positive control: the base snippet reads the plain input');
  assert.equal(run(old, asPs51(json)).stdout, '', 'the base snippet already read the PowerShell 5.1 bytes');
});

test('every hook core that reads stdin reads it through src/hookstdin.mjs, and keeps no reader of its own', () => {
  const STDIN_CORES = ['bin/mem-before-edit-core.mjs', 'src/recallhook.mjs', 'src/afterfailure.mjs', 'src/commandguard.mjs', 'src/workflowdetect.mjs'];
  for (const rel of STDIN_CORES) {
    const text = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');
    assert.match(text, /import \{ readHookStdin(?:Sync)? \} from '\.\.?\/(?:src\/)?hookstdin\.mjs';/, `${rel} does not read through hookstdin`);
    assert.match(text, /readHookStdin(?:Sync)?\(\)/, `${rel} imports the reader but does not call it`);
    assert.doesNotMatch(text, /process\.stdin\.on\(|readFileSync\(0\b/, `${rel} reads stdin past hookstdin again`);
  }
  // The two that take the raw text through a function the twin's snippet calls.
  assert.match(fs.readFileSync(path.join(REPO, 'src', 'subagentstart.mjs'), 'utf8'), /JSON\.parse\(hookText\(/);
  assert.match(fs.readFileSync(path.join(REPO, 'src', 'beforeedit.mjs'), 'utf8'), /input: hookText\(o\.input\)/);
});

/** A .ps1 file without its comment lines. */
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('every .ps1 that pipes into a native command sets both encodings before its first pipe; no snippet parses stdin raw', () => {
  const INPUT = /\[Console\]::InputEncoding\.CodePage -eq 65001 -and \[Console\]::InputEncoding\.GetPreamble\(\)\.Length -gt 0\) \{ \[Console\]::InputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\) \}/;
  const OUTPUT = /^\s*\$OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)\s*$/m;
  const PIPE = /\|\s*&\s*(?:node\b|\$HostExe\b)/;
  const piping = [];
  for (const n of fs.readdirSync(path.join(REPO, 'bin')).filter((f) => f.endsWith('.ps1'))) {
    const text = code(fs.readFileSync(path.join(REPO, 'bin', n), 'utf8'));
    const first = text.search(PIPE);
    if (first < 0) continue;
    piping.push(n);
    const before = text.slice(0, first);
    assert.match(before, INPUT, `${n}: pipes into a native command without a preamble-free console input encoding first`);
    assert.match(before, OUTPUT, `${n}: pipes into a native command without a BOM-free $OutputEncoding first`);
    assert.doesNotMatch(text, /JSON\.parse\((?:d|raw)\)/, `${n}: a node snippet parses what the twin piped without dropping a BOM`);
  }
  // The list the rule covers, so a twin that stops piping (or a new one) is a decision, not an accident.
  assert.deepEqual(piping.sort(), ['_headless.ps1', 'mem-after-failure.ps1', 'mem-before-edit.ps1', 'mem-catch-fail.ps1',
    'mem-digest.ps1', 'mem-retrieve.ps1', 'mem-stop.ps1', 'mem-subagent-start.ps1']);
});
