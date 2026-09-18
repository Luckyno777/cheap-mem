// A log nobody can read is not an audit trail.
//
// **The finding, 2026-09-17.** The observation ledger shipped with a
// writer and no reader: `observations.record()` was called from `mem
// retrieve`, `readAll()` was exported, and nothing in the repo called
// it. The justification given for building it at all was "a pure audit
// trail" — but an audit trail that no command can show is a file that
// grows, not evidence anyone can use.
//
// This house already names the inverse defect: a field with no writer.
// The same day, another branch found `WAECHTER_LOCK` set and never
// read, and either read it or removed it. This is that shape, mirrored,
// and it slipped through the same review.
//
// **What this probe deliberately does NOT do:** it does not demand that
// every module be reachable from the CLI. It asks one narrow question
// about logs specifically — something that APPENDS lines to a file on
// every run must also have a way to show them, or it should not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as observations from '../src/observations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MEM = path.join(ROOT, 'bin', 'mem');

const run = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a],
  { encoding: 'utf8' });

function memory() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-obs-'));
  spawnSync(process.execPath, [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  return r;
}

test('the ledger has a reader, and it is reachable from the CLI', () => {
  const r = memory();
  try {
    observations.record(r, { lane: 'retrieve', ids: ['x1', 'x2'], query: 'a question' });
    const out = run(r, 'observations');
    assert.equal(out.status, 0, `the command failed: ${out.stderr}`);
    assert.match(out.stdout, /retrieve/, 'the reader does not show the lane');
    assert.match(out.stdout, /a question/, 'the reader does not show the query');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('THREE STATES: no ledger is not an empty ledger', () => {
  // The house invariant. "Nothing was observed" and "nothing has ever
  // run here" are different facts, and a reader that renders them the
  // same makes the second one unreportable.
  const r = memory();
  try {
    const nichts = run(r, 'observations');
    assert.equal(nichts.status, 0);
    assert.match(nichts.stdout, /no ledger yet/i, 'a missing ledger reads as an empty one');

    fs.mkdirSync(path.dirname(observations.ledgerPath(r)), { recursive: true });
    fs.writeFileSync(observations.ledgerPath(r), '');
    const leer = run(r, 'observations');
    assert.match(leer.stdout, /empty/i, 'an empty ledger reads as a missing one');
    assert.ok(!/no ledger yet/i.test(leer.stdout),
      'the two states are rendered identically');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a line that will not parse is SHOWN, not silently dropped', () => {
  const r = memory();
  try {
    observations.record(r, { lane: 'retrieve', ids: ['ok'], query: 'fine' });
    fs.appendFileSync(observations.ledgerPath(r), '{ this is not json\n');
    const out = run(r, 'observations');
    assert.match(out.stdout, /unreadable/i,
      'a corrupt line vanished — silence hides exactly what an audit trail is for');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NO LOG WITHOUT A READER: every appending log module is reachable', () => {
  // The rule, stated once, finding its own subjects: a module under
  // src/ that appends lines to a file must be reachable from bin/ --
  // something has to be able to show what it wrote.
  //
  // **The first version of this probe got the rule wrong, not the
  // house.** It looked for a reader named `read`, `all` or `entries`
  // and flagged four modules that are perfectly reachable under other
  // names: `board.report`, `console.collect`, `heartbeat.beat`,
  // `store.holdings`. A probe that only recognises one spelling reports
  // the spelling, not the defect.
  //
  // What it does NOT do: demand that every module be reachable. Only
  // the ones that APPEND -- those grow on disk, and something that
  // grows unread is a file, not evidence.
  //
  // **Where "reachable" is looked for moved on 2026-09-18.** The sixty
  // command handlers left `bin/mem` for six modules under
  // `src/cli/commands/`, and this probe went blind in the useful
  // direction: it still found the appending modules, but no longer
  // found anything calling them, so it reported the whole house as
  // unreachable. The rule did not change — the CLI is still what has
  // to be able to show a log — only where the CLI's code sits.
  const src = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.mjs'));
  const cliDateien = [
    ...fs.readdirSync(path.join(ROOT, 'bin')).map((f) => path.join(ROOT, 'bin', f)),
    ...fs.readdirSync(path.join(ROOT, 'src', 'cli'))
      .filter((f) => f.endsWith('.mjs')).map((f) => path.join(ROOT, 'src', 'cli', f)),
    ...fs.readdirSync(path.join(ROOT, 'src', 'cli', 'commands'))
      .map((f) => path.join(ROOT, 'src', 'cli', 'commands', f)),
  ];
  const binFiles = cliDateien
    .filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // A probe that reads an empty string reports every module unreachable
  // and looks like a catastrophe. This is the vacuity check for it.
  assert.ok(binFiles.length > 50_000,
    `only ${binFiles.length} characters of CLI source read — the probe is looking in the wrong place`);

  const anhaengend = [];
  for (const f of src) {
    const t = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    if (/appendFileSync|appendFile\(/.test(t)) anhaengend.push([f, t]);
  }
  assert.ok(anhaengend.length >= 5,
    `only ${anhaengend.length} appending modules found — the probe scans the wrong place`);

  const unerreichbar = [];
  for (const [f, t] of anhaengend) {
    const modul = f.replace('.mjs', '');
    const exporte = [...t.matchAll(/export function (\w+)/g)].map((m) => m[1]);
    const benutzt = exporte.some((fn) => new RegExp(`\\b${modul}\\.${fn}\\b`).test(binFiles));
    if (!benutzt) unerreichbar.push(f);
  }
  assert.deepEqual(unerreichbar, [],
    'These modules append lines to disk and nothing in bin/ calls into them. '
    + 'A log nobody can reach is a file that grows, not an audit trail.');
});
