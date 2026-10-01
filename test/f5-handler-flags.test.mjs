// F5 / suggestion list item 5: every command handler checks its flags
// (`checkFlags`) and asks for help through `isHelp(args)` -- never through
// `args.help`.
//
// The anchor: `heartbeat`, `when`, `guard` read `args.help` (truthy test,
// so `--help foo` and `--help` behaved differently from every other
// command), and `heartbeat`, `chain`, `archive`, `status`, `guard run`,
// `hooks check` accepted any flag silently (`--gapp 5` meant the default).
//
// The guard reads the six `COMMANDS` tables in src/cli/commands/ from the
// source text and counts per handler. Exceptions are NAMED, with a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, files, read, stripComments } from './f5-source.mjs';

const NO_CHECK = {
  log: 'free-form fields: every other switch becomes a JSONL field; typos are caught by refuseNearReserved()',
  discard: 'delegates to retireCmd() in display.mjs, which calls checkFlags and isHelp itself',
  done: 'delegates to retireCmd() in display.mjs, which calls checkFlags and isHelp itself',
};
const NO_HELP = {
  discard: NO_CHECK.discard,
  done: NO_CHECK.done,
};

/** {file:name -> body} of every handler in the `COMMANDS` tables. */
export function handlers(sources) {
  const found = {};
  for (const [file, text] of Object.entries(sources)) {
    const t = stripComments(text).split('\n');
    const start = t.findIndex((l) => l.startsWith('export const COMMANDS = {'));
    if (start < 0) continue;
    const marks = [];
    for (let i = start + 1; i < t.length; i += 1) {
      if (t[i] === '};') { marks.push([null, i]); break; }
      const m = /^ {2}('[a-z0-9-]+'|[A-Za-z0-9_]+): /.exec(t[i]);
      if (m) marks.push([m[1].replace(/'/g, ''), i]);
    }
    for (let k = 0; k < marks.length - 1; k += 1) {
      found[`${file}:${marks[k][0]}`] = t.slice(marks[k][1], marks[k + 1][1]).join('\n');
    }
  }
  return found;
}

export function violations(bodies, noCheck = NO_CHECK, noHelp = NO_HELP) {
  const check = []; const help = [];
  for (const [key, body] of Object.entries(bodies)) {
    const name = key.split(':')[1];
    if (!/\bcheckFlags\(/.test(body) && !(name in noCheck)) check.push(key);
    if (!/\bisHelp\(/.test(body) && !(name in noHelp)) help.push(key);
  }
  return { check, help };
}

const SOURCES = () => Object.fromEntries(
  files('src/cli/commands', (n) => n.endsWith('.mjs')).map((r) => [r, read(r)]));

test('positive control: the reader finds handlers and flags violations', () => {
  const probe = [
    'export const COMMANDS = {',
    '  good: async ({ args }) => {',
    '    if (isHelp(args)) return;',
    "    checkFlags(args, ['a'], 'good');",
    '  },',
    "  'bad-one': async ({ args }) => {",
    '    if (args.help) return;',
    '  },',
    '};',
  ].join('\n');
  const h = handlers({ 'x.mjs': probe });
  assert.deepEqual(Object.keys(h), ['x.mjs:good', 'x.mjs:bad-one']);
  assert.deepEqual(violations(h, {}, {}), { check: ['x.mjs:bad-one'], help: ['x.mjs:bad-one'] });
});

test('every handler calls checkFlags and isHelp (named exceptions aside)', () => {
  const h = handlers(SOURCES());
  assert.ok(Object.keys(h).length > 80, `read only ${Object.keys(h).length} handlers -- reader broken?`);
  const v = violations(h);
  assert.deepEqual(v.check, [], `without checkFlags: ${v.check.join(', ')}`);
  assert.deepEqual(v.help, [], `without isHelp: ${v.help.join(', ')}`);
  const names = new Set(Object.keys(h).map((k) => k.split(':')[1]));
  for (const n of Object.keys(NO_CHECK)) assert.ok(names.has(n), `exception '${n}' no longer exists -- drop it`);
});

test('args.help appears nowhere in src/ or bin/ outside isHelp itself', () => {
  const where = [];
  for (const rel of [...files('src', (n) => n.endsWith('.mjs')), ...files('bin', (n) => n === 'mem' || n.endsWith('.mjs'))]) {
    stripComments(read(rel)).split('\n').forEach((l, i) => {
      if (/\bargs\.help\b/.test(l) && !/function isHelp/.test(l)) where.push(`${rel}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(where, [], `args.help instead of isHelp(args):\n${where.join('\n')}`);
});

test('behaviour: a misspelt flag on heartbeat/chain is refused, not ignored', () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-flags-'));
  try {
    const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'mem'), '--root', w, ...a], { encoding: 'utf8' });
    assert.equal(run('init').status, 0);
    for (const cmd of [['heartbeat', '--gapp', '5'], ['chain', '--jsno'], ['hooks', 'check', '--x', '1']]) {
      const r = run(...cmd);
      assert.notEqual(r.status, 0, `${cmd.join(' ')} went through`);
      assert.match(r.stderr, /unknown flag/);
    }
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});
