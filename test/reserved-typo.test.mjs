// A switch that narrowly misses a reserved name is a typo, not a field.
//
// **The incident (2026-09-17, sibling house, produced by hand.)** A
// `log` command was typed with `--projekt` instead of `--project`. The
// CLI said nothing. `projekt` is not a reserved switch, so the open
// field vocabulary took it as a FIELD; and since no project had been
// named, the entry was filed globally rather than in the project. One
// keystroke, two wrong outcomes, exit 0, no message. It surfaced only
// because the success line prints the path and somebody read it.
//
// The open vocabulary is not the bug and is not touched here: any
// `--name value` still becomes a field, which is what lets this store
// fit a domain it has never met. What is refused is the NARROW MISS of
// a reserved name — never what anybody meant.
//
// Five assertions, one per requirement:
//
//   A  the typo that caused this is refused, end to end, and writes nothing
//   B  the correct spelling still does what it always did
//   C  an ordinary field one step further away is still a field
//   D  the threshold costs nothing on the switch names this repo really
//      uses — measured over the corpus, not asserted from memory
//   E  the measurement is a measurement: a corpus that vanished, or a
//      rule loosened, is not a pass
//
// invariant: reservierter-schalter-vertipper
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nearReserved, editDistance, nearMissThreshold, RESERVED_SWITCHES }
  from '../src/switches.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

/**
 * Run the real CLI and carry the cause.
 *
 * Exit status, signal, spawn error and stderr all travel into the
 * assertion message. A probe that asserts on stdout alone reports
 * "nothing came back" when it fails, and the reason sits in the
 * output it threw away.
 */
function mem(root, ...args) {
  const r = spawnSync(process.execPath, [MEM, '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHEAP_MEM_ROOT: root },
  });
  const why = [
    `exit=${r.status} signal=${r.signal}`,
    r.error ? `spawn=${r.error.message}` : '',
    `stdout=${(r.stdout || '').trim()}`,
    `stderr=${(r.stderr || '').trim()}`,
  ].filter(Boolean).join('\n');
  return { ...r, why, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reserved-typo-'));
  const r = mem(root, 'init');
  assert.equal(r.status, 0, `init failed:\n${r.why}`);
  return root;
}

/** Every line of every file under these, so the corpus cannot be one file. */
const CORPUS_ROOTS = Object.freeze([
  'README.md', 'docs', 'test', 'bin', 'hooks', 'install', 'eval', 'src',
]);

/**
 * The switch names this repository actually uses.
 *
 * `src/switches.mjs` is excluded on purpose: it is the one file that
 * spells the typo out, in the comment explaining the rule. Counting it
 * would make the guard find itself.
 */
function corpusSwitches() {
  const names = new Map();
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    else files.push(p);
  };
  for (const r of CORPUS_ROOTS) {
    const p = path.join(REPO, r);
    if (fs.existsSync(p)) walk(p);
  }
  const SELF = [path.join(REPO, 'src', 'switches.mjs'),
    path.join(REPO, 'test', 'reserved-typo.test.mjs')];
  for (const f of files) {
    if (SELF.includes(f)) continue;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/--([a-z][a-z0-9-]{1,24})\b/g)) {
      const n = m[1];
      if (!names.has(n)) names.set(n, new Set());
      names.get(n).add(path.relative(REPO, f));
    }
  }
  return names;
}

test('A the typo that caused this is refused, and nothing is written', () => {
  const root = freshRoot();
  const r = mem(root, 'log', 'decision', '--projekt', 'alpha',
    '--choice', 'x', '--why', 'y');

  assert.notEqual(r.status, 0, `the typo was accepted:\n${r.why}`);
  assert.match(r.out, /--projekt/, `the message does not name the typo:\n${r.why}`);
  assert.match(r.out, /--project/, `the message does not name the meant switch:\n${r.why}`);

  // The second half of the original damage: the entry was FILED. A
  // refusal that still wrote the line would look identical in the
  // message and be just as wrong.
  const global = path.join(root, 'global', 'decisions.jsonl');
  const filed = fs.existsSync(global) ? fs.readFileSync(global, 'utf8').trim() : '';
  assert.equal(filed, '', `the refused entry was filed anyway:\n${filed}`);
});

test('B the correct spelling still files into the project', () => {
  const root = freshRoot();
  const r = mem(root, 'log', 'decision', '--project', 'alpha',
    '--choice', 'x', '--why', 'y');
  assert.equal(r.status, 0, `the correct spelling was refused:\n${r.why}`);
  assert.match(r.out, /projects[/\\]alpha[/\\]decisions\.jsonl/,
    `filed somewhere unexpected:\n${r.why}`);
});

test('C an ordinary field is still a field — the vocabulary stays open', () => {
  const root = freshRoot();
  // `ticket` is nobody's near miss and nothing in the CLI knows it.
  assert.equal(nearReserved('ticket'), null);
  const r = mem(root, 'log', 'decision', '--project', 'alpha',
    '--choice', 'x', '--why', 'y', '--ticket', 'AB-12');
  assert.equal(r.status, 0, `an open field was refused:\n${r.why}`);
  const line = fs.readFileSync(
    path.join(root, 'projects', 'alpha', 'decisions.jsonl'), 'utf8').trim();
  assert.equal(JSON.parse(line).ticket, 'AB-12',
    `the field did not survive:\n${line}`);
});

test('D the threshold costs nothing on the switch names this repo uses', () => {
  const names = corpusSwitches();

  // E, first half: an empty corpus is not a pass. The number is a
  // floor, not the measurement — it only has to be too large for a
  // broken walk to slip through.
  assert.ok(names.size >= 100,
    `only ${names.size} switch names found — the corpus walk is broken, ` +
    'and a guard measured against nothing always looks clean');

  const caught = [...names.keys()].filter((n) => nearReserved(n)).sort();
  assert.deepEqual(caught, [],
    'the guard would eat switch names this repo really uses: ' +
    caught.map((c) => `--${c} (read as --${nearReserved(c)}, in ` +
      `${[...names.get(c)][0]})`).join(', '));
});

test('E the measurement is a measurement, not a shape', () => {
  const names = corpusSwitches();

  // A rule loosened by one step is what this costs. The numbers are
  // from 2026-09-17 and are written in src/switches.mjs beside the
  // rule; if they move, the comment is wrong and has to be re-measured.
  const wouldCatch = (reserved, threshold) => [...names.keys()]
    .filter((n) => { const d = editDistance(n, reserved); return d > 0 && d <= threshold; });

  assert.ok(wouldCatch('root', 2).length >= 4,
    'at distance 2 the four-character reserved name used to eat real ' +
    'switches (font, host, out, port, role, tool). If it no longer ' +
    'does, the corpus changed and the length rule needs re-deciding, ' +
    `not keeping on trust: ${JSON.stringify(wouldCatch('root', 2))}`);
  assert.equal(nearMissThreshold('root'), 1,
    'which is exactly why a short reserved name tolerates only 1');

  // And the guard must still be able to catch something: a rule that
  // catches nothing at all passes every corpus test ever written.
  const REAL_TYPOS = ['projekt', 'porject', 'prject', 'projects', 'rot', 'roots'];
  const missed = REAL_TYPOS.filter((t) => !nearReserved(t));
  assert.deepEqual(missed, [],
    `typos a fast typist makes went through: ${missed.join(', ')}`);

  // The reserved names themselves are not typos of themselves.
  for (const r of RESERVED_SWITCHES) {
    assert.equal(nearReserved(r), null, `'${r}' reads as a typo of itself`);
  }
});
