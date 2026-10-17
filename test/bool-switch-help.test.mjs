// `-h` after a boolean switch is a help request, not the switch's value.
//
// **The finding (2026-10-17).** The argument parser reads `--key next` as "key is next" unless next starts with `--`.
// It does not know which names are switches. So `mem init --force -h`, `mem serve --readonly -h`,
// `mem epoch --force -h`, `mem raw delete <p> --yes -h`, `mem suggest rules --write -h` and `mem find x --json -h`
// took `-h` as the VALUE of the switch: the command ran (wrote, or started a server) instead of showing help. The sibling
// case, `-h` as a bare word, was fixed on 2026-10-13 (test/cli-contract.test.mjs) and left this one open.
//
// The fix is ONE register, `BOOL_SWITCHES` in src/cli/shell.mjs. This file holds three things against it:
//   1. the parser, directly: `-h` after a listed switch is help; after a value switch it is still the value;
//   2. the real program: for every (command, listed switch) pair the source declares, `<cmd> --<switch> -h` shows help,
//      exits 0 and leaves an initialised scratch memory byte-for-byte as it was;
//   3. the register against the source: every listed name is read somewhere, and none is read as a text or a number.
//
// Red proofs: (a) the parser of the commit before the fix (pinned, not a moving merge-base) eats `-h` after `--json`;
// (b) the sweep below is red against that parser too (run by hand with the old shell.mjs, see the commit message);
// positive controls: the probe sees a write, the pair list is large and holds the named cases, the source scan sees a
// value switch (`quiet`, `top`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { oldModuleCopy } from './helpers/old-source-copy.mjs';
import { BOOL_SWITCHES, parseArgs } from '../src/cli/shell.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const GROUPS = ['write', 'search', 'capture', 'agents', 'setup', 'admin'];
/** The commit before the fix: a FIXED hash, because a merge-base moves with the merge and would turn the proof red. */
const OLD_STATE = '9a10bf6940634d0b249f402139dbec1fed366ba5';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// --- 1. the parser ----------------------------------------------------------------------------------------------------

test('parser: -h after a listed switch is help and the switch stays a switch', () => {
  for (const name of ['json', 'force', 'readonly', 'shred', 'as-me', 'dry-run', 'yes', 'write', 'allow-writes']) {
    const { args, rest } = parseArgs([`--${name}`, '-h']);
    assert.equal(args.help, true, `--${name} -h: no help request`);
    assert.equal(args[name], true, `--${name} -h: the switch lost its meaning (${JSON.stringify(args[name])})`);
    assert.deepEqual(rest, [], `--${name} -h: a word is left over`);
  }
  // in the middle, and with a word after it
  const mid = parseArgs(['x', '--json', '-h', '--top', '5', 'y']);
  assert.equal(mid.args.help, true);
  assert.equal(mid.args.json, true);
  assert.equal(mid.args.top, '5');
  assert.deepEqual(mid.rest, ['x', 'y']);
});

test('parser: a value switch and every other reading are unchanged', () => {
  assert.deepEqual(parseArgs(['--text', '-h']).args, { text: '-h' });          // the documented value "-h"
  assert.deepEqual(parseArgs(['--title', '-h', '--text', 'b']).args, { title: '-h', text: 'b' });
  assert.deepEqual(parseArgs(['--top', '5']).args, { top: '5' });
  assert.deepEqual(parseArgs(['--root', 'x']).args, { root: 'x' });
  assert.deepEqual(parseArgs(['--text=-h']).args, { text: '-h' });
  assert.deepEqual(parseArgs(['--quiet', '-h']).args, { quiet: '-h' });         // `quiet` is a number in `digest due`: not listed
  assert.deepEqual(parseArgs(['--json', 'maybe']).args, { json: 'maybe' });     // another word is still the value (handlers refuse it)
  assert.deepEqual(parseArgs(['--json', '--top', '3']).args, { json: true, top: '3' });
  assert.deepEqual(parseArgs(['--json=false', '-h']).args, { json: 'false', help: true });
  assert.deepEqual(parseArgs(['-h']).args, { help: true });
});

test('parser: the register is closed and holds what the red findings named', () => {
  assert.ok(BOOL_SWITCHES.size >= 50, `only ${BOOL_SWITCHES.size} names`);
  for (const n of ['json', 'force', 'readonly', 'shred', 'as-me', 'yes', 'write', 'dry-run', 'automatic', 'without-scaffold', 'no-broadcast']) {
    assert.ok(BOOL_SWITCHES.has(n), `${n} is missing`);
  }
  for (const n of ['quiet', 'human', 'top', 'root', 'text', 'title', 'project']) {
    assert.ok(!BOOL_SWITCHES.has(n), `${n} takes a value somewhere and must not be listed`);
  }
  assert.throws(() => BOOL_SWITCHES.add('x'), TypeError);
});

test('RED on the old state: its parser reads -h after --json as the value of --json', async (t) => {
  let old;
  try {
    old = execFileSync('git', ['show', `${OLD_STATE}:src/cli/shell.mjs`], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    t.skip(`commit ${OLD_STATE.slice(0, 7)} not reachable (shallow clone?) - red proof unknown, not green`);
    return;
  }
  const copy = oldModuleCopy(path.join(REPO, 'src', 'cli'), 'shell-old.mjs', old);
  try {
    const mod = await import(pathToFileURL(copy.file).href);
    const o = mod.parseArgs(['--json', '-h']);
    assert.deepEqual(o.args, { json: '-h' }, 'the old parser no longer shows the defect: this proof is vacuous');
    assert.notEqual(o.args.help, true);
    assert.equal(parseArgs(['--json', '-h']).args.help, true, 'the new parser does');
  } finally { fs.rmSync(copy.dir, { recursive: true, force: true }); }
});

// --- 2. the real program ----------------------------------------------------------------------------------------------

/** Every file of the memory with its size and content hash, sorted: byte-for-byte, not just "same names". */
function fingerprint(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, r);
      if (fs.statSync(abs).isDirectory()) { out.push(`${r}/`); walk(r); continue; }
      out.push(`${r} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
    }
  };
  walk('');
  return out.join('\n');
}

/** A scratch HOME, so that no command - the old one included - can reach the real user's settings. */
function scratchEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['CHEAP_MEM_ROOT', 'CHEAP_MEM_AGENT', 'MEM_AGENT']) delete env[k];
  return env;
}

/** A small initialised scratch memory with one entry of each of a few kinds, so a write has something to touch. */
function scratchMemory() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-boolh-'));
  const root = path.join(base, 'mem');
  const home = path.join(base, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const env = scratchEnv(home);
  const run = (argv) => spawnSync(process.execPath, [MEM, ...argv, '--root', root], { encoding: 'utf8', cwd: root, env, timeout: 60000 });
  assert.equal(run(['init']).status, 0);
  assert.equal(run(['log', 'learning', '--title', 'seed one', '--text', 'first body']).status, 0);
  assert.equal(run(['log', 'decision', '--title', 'seed two', '--text', 'second body']).status, 0);
  return { base, root, home, env, run };
}

/** Run one command line with a timeout; resolves { status, stdout, stderr, timedOut }. */
function runAsync(argv, { root, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MEM, ...argv, '--root', root], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: String(e), timedOut }); });
  });
}

async function commandNames() {
  const names = new Set();
  for (const g of GROUPS) {
    const m = await import(pathToFileURL(path.join(REPO, 'src/cli/commands', `${g}.mjs`)).href);
    for (const k of Object.keys(m.COMMANDS)) names.add(k);
  }
  return names;
}

/**
 * Every (command words, switch) pair the source declares: `checkFlags(args, [ ...known ], 'words')` in the six groups.
 * Only the pairs whose switch is in the register and whose first word is a real command; the words are the argv.
 */
async function declaredPairs() {
  const commands = await commandNames();
  const pairs = [];
  const seen = new Set();
  for (const g of GROUPS) {
    const text = read(`src/cli/commands/${g}.mjs`);
    for (const m of text.matchAll(/checkFlags\(\s*args,\s*\[([^\]]*)\],\s*'([^']+)'/g)) {
      const words = m[2].split(' ');
      if (!commands.has(words[0])) continue;
      for (const sw of [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) {
        if (!BOOL_SWITCHES.has(sw)) continue;
        const key = `${m[2]} --${sw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ words, sw, key });
      }
    }
  }
  return pairs;
}

// `mem log` / `mem correction` take their switches as entry fields, not through checkFlags.
const EXTRA = [
  { words: ['log', 'learning'], sw: 'shred', key: 'log learning --shred' },
  { words: ['log', 'learning'], sw: 'automatic', key: 'log learning --automatic' },
  { words: ['log', 'learning'], sw: 'without-scaffold', key: 'log learning --without-scaffold' },
  { words: ['log', 'error'], sw: 'no-broadcast', key: 'log error --no-broadcast' },
  { words: ['log', 'learning'], sw: 'as-me', key: 'log learning --as-me' },
];

test('POSITIVE CONTROL: the probe sees a write, and the pair list is large and holds the named cases', async () => {
  const m = scratchMemory();
  try {
    const before = fingerprint(m.root);
    assert.equal(m.run(['log', 'learning', '--title', 'a third', '--text', 'body']).status, 0);
    assert.notEqual(fingerprint(m.root), before, 'a log write left the fingerprint as it was: the probe is blind');
  } finally { fs.rmSync(m.base, { recursive: true, force: true }); }
  const pairs = await declaredPairs();
  assert.ok(pairs.length >= 60, `only ${pairs.length} pairs read out of the source: the reader is broken`);
  const keys = new Set(pairs.map((p) => p.key));
  for (const k of ['init --force', 'serve --readonly', 'epoch --force', 'raw delete --yes', 'suggest rules --write', 'find --literal',
    'show --json', 'store list --all', 'inbox watch --skip-fetch', 'hooks install --pre-push', 'trust-own-tool --off']) {
    assert.ok(keys.has(k), `the pair "${k}" was not read out of the source`);
  }
});

test('every (command, switch) pair: <cmd> --<switch> -h shows help, exits 0 and leaves the memory byte-for-byte as it was', async () => {
  const m = scratchMemory();
  try {
    const pairs = [...await declaredPairs(), ...EXTRA];
    const before = fingerprint(m.root);
    const homeBefore = fingerprint(m.home);
    const failures = [];
    const queue = pairs.slice();
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const argv = [...p.words, `--${p.sw}`, '-h'];
        const r = await runAsync(argv, { root: m.root, env: m.env, timeoutMs: 20000 });
        if (r.timedOut) failures.push(`${argv.join(' ')}: did not end within 20 s`);
        else if (r.status !== 0) failures.push(`${argv.join(' ')}: exit ${r.status} (${(r.stderr || r.stdout).trim().slice(0, 160)})`);
        else if (!r.stdout.trim()) failures.push(`${argv.join(' ')}: printed nothing`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    assert.deepEqual(failures.sort(), [], `${failures.length} of ${pairs.length} pairs:\n${failures.sort().join('\n')}\n`);
    assert.equal(fingerprint(m.root), before, 'a help request changed the scratch memory');
    assert.equal(fingerprint(m.home), homeBefore, 'a help request wrote into HOME');
  } finally { fs.rmSync(m.base, { recursive: true, force: true }); }
});

test('a switch with a value still works: --top 5 and --root x are read as before, --json prints JSON', () => {
  const m = scratchMemory();
  try {
    const f = m.run(['find', 'seed', '--json', '--top', '5']);
    assert.equal(f.status, 0, f.stderr);
    assert.doesNotThrow(() => JSON.parse(f.stdout));
    const s = m.run(['status', '--json']);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(JSON.parse(s.stdout).broken, 0);
    // -h as the value of a text switch is still written as text
    assert.equal(m.run(['log', 'learning', '--title', 'dash h', '--text', '-h']).status, 0);
    const lines = fs.readFileSync(path.join(m.root, 'global', 'learnings.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.some((e) => e.text === '-h'), 'text "-h" was not written');
  } finally { fs.rmSync(m.base, { recursive: true, force: true }); }
});

// --- 3. the register against the source ------------------------------------------------------------------------------

/** The places that read a switch as a text or a number (not as yes/no). */
function valueReads(name, text) {
  const n = name.replace(/[-]/g, '\\-');
  const patterns = [
    new RegExp(`(?:String|Number|parseInt|parseFloat)\\(\\s*args(?:\\.${n}\\b|\\['${n}'\\])`),
    new RegExp(`(?:textFlag|one)\\(\\s*args,\\s*'${n}'`),
    new RegExp(`numberFlag\\(\\s*'${n}'`),
    new RegExp(`args(?:\\.${n}\\b|\\['${n}'\\])(?:\\.| *\\?\\?| *\\|\\| *['"0-9])`),
    new RegExp(`typeof args(?:\\.${n}\\b|\\['${n}'\\])`),
  ];
  return text.split('\n').filter((l) => patterns.some((p) => p.test(l)));
}

const SOURCE_FILES = [
  ...GROUPS.map((g) => `src/cli/commands/${g}.mjs`),
  'src/cli/appointments.mjs', 'src/cli/display.mjs', 'src/cli/shell.mjs', 'bin/mem',
];

test('POSITIVE CONTROL: the source scan sees a switch that takes a value', () => {
  const all = SOURCE_FILES.map(read).join('\n');
  assert.ok(valueReads('quiet', all).length > 0, '`quiet` is a number in `digest due`: the scan must see it');
  assert.ok(valueReads('top', all).length > 0, '`top` is a number: the scan must see it');
  assert.ok(valueReads('human', all).length > 0, '`human` is a name in `init`: the scan must see it');
});

test('the register: no listed name is read as a text or a number, and every listed name is read somewhere', () => {
  const all = SOURCE_FILES.map(read).join('\n');
  const asValue = [];
  const unread = [];
  for (const name of BOOL_SWITCHES) {
    const hits = valueReads(name, all);
    if (hits.length) asValue.push(`${name}: ${hits[0].trim().slice(0, 140)}`);
    if (!all.includes(`'${name}'`) && !new RegExp(`args\\.${name.replace(/-/g, '\\-')}\\b`).test(all)) unread.push(name);
  }
  assert.deepEqual(asValue, [], `listed names that some handler reads as a value:\n${asValue.join('\n')}`);
  assert.deepEqual(unread, [], `listed names no handler reads: ${unread.join(', ')}`);
});

test('the register: every switch the commands declare that is only ever yes/no is a candidate - none is left out by mistake', async () => {
  // A switch declared by `checkFlags` and read only as yes/no (never as a value) belongs in the register, unless it is named
  // here with its reason. This is what keeps the register from falling behind the next switch someone adds.
  // `quiet`: a number in `digest due`. `human`: a name in `init`. `key`: the fact key of `facts --key k`, read as `args.key` in a
  // comparison. `on-fail`: a mode word of `embed setup`, copied to the config.
  const LEFT_OUT = new Set(['quiet', 'human', 'key', 'on-fail']);
  const all = SOURCE_FILES.map(read).join('\n');
  const declared = new Set();
  for (const g of GROUPS) {
    for (const m of read(`src/cli/commands/${g}.mjs`).matchAll(/checkFlags\(\s*args,\s*\[([^\]]*)\]/g)) {
      for (const x of m[1].matchAll(/'([^']+)'/g)) declared.add(x[1]);
    }
  }
  const yesNoOnly = [];
  for (const name of declared) {
    if (BOOL_SWITCHES.has(name) || LEFT_OUT.has(name)) continue;
    const n = name.replace(/-/g, '\\-');
    // read as yes/no somewhere, and never as a value anywhere
    const asYesNo = new RegExp(`(?:Boolean\\(args(?:\\.${n}\\b|\\['${n}'\\])\\)|\\bif \\(!?args(?:\\.${n}\\b|\\['${n}'\\])\\)|!args(?:\\.${n}\\b|\\['${n}'\\])\\b)`).test(all);
    if (asYesNo && valueReads(name, all).length === 0 && !new RegExp(`[a-zA-Z]+\\([^)]*args(?:\\.${n}\\b|\\['${n}'\\])`).test(all.replace(/Boolean\([^)]*\)/g, ''))) {
      yesNoOnly.push(name);
    }
  }
  assert.deepEqual(yesNoOnly, [], `read as yes/no only but not in BOOL_SWITCHES (list them, or name them in LEFT_OUT with the reason): ${yesNoOnly.join(', ')}`);
  assert.ok(declared.size > 100, `only ${declared.size} declared switches read: the reader is broken`);
});
