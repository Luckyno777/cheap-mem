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

  // **Comments stripped before classifying. A mention is not a call.**
  //
  // Found on 2026-09-19: a docblock in `src/environment.mjs` explaining
  // why `fs.appendFileSync` is the relevant syscall was enough to file
  // that module under "appends to disk" — and since nothing in `bin/`
  // reaches it, the probe then reported a module that writes nothing as
  // an unreachable log. The house has a name for this shape and keeps
  // shipping it; here it made a guard report the innocent, which is the
  // fastest way to teach everyone to ignore the guard.
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');

  // **A log persists. A probe deletes itself. (2026-09-20)**
  //
  // `src/environment.mjs` started appending for real this day: the
  // append-atomicity check has several writers append marker lines to
  // one file and then looks for torn ones. It landed here as "a module
  // that appends and cannot be reached", and that is the wrong reading
  // — this file lives in a directory the module creates with `mkdtemp`
  // and removes in a `finally`. Nothing grows, so there is nothing to
  // show, so the rule does not apply.
  //
  // Second time this guard has flagged this module; the first was a
  // MENTION in a comment on 2026-09-19. Both times the defect was in
  // the classifier, not in the module — and a guard that keeps
  // reporting the innocent is the fastest way to teach everyone to
  // ignore it.
  //
  // Structural, not a name list: a module qualifies only if it BOTH
  // creates a throwaway directory and removes one. A module that
  // appends to a path it keeps still lands in `appending`, whatever it
  // is called.
  const selfCleaning = (t) => /mkdtempSync?\(/.test(t) && /rmSync\(|\brm\(/.test(t);

  // **The primitive is not a log. (2026-09-20)**
  //
  // `src/append.mjs` landed here the day the missing-newline repair was
  // centralised in one place: it is the append primitive itself. Every
  // path it writes to arrives as an argument, and the module that CHOSE
  // that path is in this list on its own account and is checked there.
  // Demanding a reader for `append.mjs` would demand a reader for a file
  // it does not own -- the third time this guard would have reported the
  // innocent.
  //
  // Structural, not a name list: a module is excused only if it builds
  // no path at all (no `node:path`, no `path.join`/`path.resolve`) AND
  // imports nothing from this house. A real log module always does one
  // or the other -- it either constructs the location it writes to or
  // reaches for a sibling that does. `src/chain.mjs` takes its path as
  // an argument too, but it imports `./append.mjs`, so it stays in
  // `appending` and keeps being checked.
  const primitive = (t) => !/from 'node:path'/.test(t)
    && !/path\.(join|resolve)\(/.test(t)
    && !/from '\.\/[^']+\.mjs'/.test(t);

  const appending = [];
  const probesOnly = [];
  const primitives = [];
  for (const f of src) {
    const t = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    if (!/appendFileSync|appendFile\(|appendLine\(/.test(code(t))) continue;
    if (selfCleaning(code(t))) { probesOnly.push(f); continue; }
    if (primitive(code(t))) { primitives.push(f); continue; }
    appending.push([f, t]);
  }
  // Same reasoning as the self-cleaning cap below: a carve-out that
  // grows is a hole.
  assert.ok(primitives.length <= 1,
    `${primitives.length} modules were excused as the append primitive (${primitives.join(', ')}). `
    + 'There is one append primitive in this house; more than one is the two-truths defect.');
  assert.ok(appending.length >= 5,
    `only ${appending.length} appending modules found — the probe scans the wrong place`);
  // The carve-out must stay small and named. If it starts absorbing
  // modules, the rule has quietly stopped applying to the house.
  assert.ok(probesOnly.length <= 2,
    `${probesOnly.length} modules were excused as self-cleaning probes (${probesOnly.join(', ')}). `
    + 'That is no longer a carve-out, it is a hole.');

  const unreachable = [];
  for (const [f, t] of appending) {
    const moduleName = f.replace('.mjs', '');
    const exportNames = [...t.matchAll(/export function (\w+)/g)].map((m) => m[1]);
    const benutzt = exportNames.some((fn) => new RegExp(`\\b${moduleName}\\.${fn}\\b`).test(binFiles));
    if (!benutzt) unreachable.push(f);
  }
  assert.deepEqual(unreachable, [],
    'These modules append lines to disk and nothing in bin/ calls into them. '
    + 'A log nobody can reach is a file that grows, not an audit trail.');
});

test('COUNTER-PROBE: the self-cleaning carve-out does not excuse a real log', () => {
  // Without this, `selfCleaning` could be widened until every appending
  // module slips through and the guarantee above passes forever.
  const selfCleaning = (t) => /mkdtempSync?\(/.test(t) && /rmSync\(|\brm\(/.test(t);

  // A real ledger: appends to a path it keeps, never cleans up.
  const echterLog = 'fs.appendFileSync(ledgerPath(root), line);';
  assert.equal(selfCleaning(echterLog), false,
    'a module that only appends was excused as a probe');

  // A ledger that happens to delete something ELSE is still a ledger:
  // both halves are required, and the temp-dir half is the load-bearing
  // one.
  const logMitAufraeumen = 'fs.appendFileSync(ledgerPath(root), line);\nfs.rmSync(oldBackup);';
  assert.equal(selfCleaning(logMitAufraeumen), false,
    'deleting something unrelated turned a ledger into a probe');

  // And the shape that IS a probe.
  const sonde = 'const dir = fs.mkdtempSync(p);\nfs.appendFileSync(f, l);\nfs.rmSync(dir, { recursive: true });';
  assert.equal(selfCleaning(sonde), true, 'a self-cleaning probe was not recognised');
});

test('COUNTER-PROBE: the append-primitive carve-out does not excuse a real log', () => {
  // Mirror of the test above, for the second carve-out. Widened far
  // enough, `primitive` would excuse every appending module and the
  // guarantee would pass forever while watching nothing.
  const primitive = (t) => !/from 'node:path'/.test(t)
    && !/path\.(join|resolve)\(/.test(t)
    && !/from '\.\/[^']+\.mjs'/.test(t);

  // The real thing: no path, no house import, just the append.
  assert.equal(primitive("import fs from 'node:fs';\nfs.appendFileSync(p, line);"), true,
    'the append primitive itself was not recognised');

  // A module that builds the location it writes to OWNS that log.
  assert.equal(primitive("import fs from 'node:fs';\nfs.appendFileSync(path.join(root, 'x.jsonl'), line);"), false,
    'a module that constructs its own drawer path was excused as a primitive');

  // A module that reaches for a sibling is not a leaf utility.
  assert.equal(primitive("import fs from 'node:fs';\nimport { appendLine } from './append.mjs';\nappendLine(p, line);"), false,
    'a module importing from the house was excused as a primitive');

  // And the import form the house actually uses for paths.
  assert.equal(primitive("import path from 'node:path';\nfs.appendFileSync(p, line);"), false,
    'importing node:path was not enough to disqualify');
});
