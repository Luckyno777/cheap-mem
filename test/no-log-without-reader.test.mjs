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
import { NOT_YET_WIRED, TTL_DAYS, isExpired } from './not-yet-wired.mjs';

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

// --- Shared with the general reachability rule below --------------------
//
// Hoisted out of the tests that used to hold private copies. B7 of the
// 2026-09-20 build plan asks for the log-reader rule below to be
// GENERALISED, not duplicated next to a second copy of its own
// machinery -- so `code`, `selfCleaning` and `primitive` now live once,
// and both the narrow rule (append-logs need a reader) and the general
// one (every src/ module needs a caller or a declaration) call the same
// functions. The two COUNTER-PROBE tests further down now exercise
// these exact functions too, instead of private copies that could
// silently drift from what the guard actually runs.

/** Comments stripped before classifying. A mention is not a call. */
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');

/**
 * Structural, not a name list: a module qualifies only if it BOTH
 * creates a throwaway directory and removes one. See the 2026-09-20
 * comment on the original finding for the incident this guards.
 */
const selfCleaning = (t) => /mkdtempSync?\(/.test(t) && /rmSync\(|\brm\(/.test(t);

/**
 * Structural, not a name list: a module is excused only if it builds no
 * path at all (no `node:path`, no `path.join`/`path.resolve`) AND
 * imports nothing from this house. See the 2026-09-20 comment on the
 * original finding for why this is the append PRIMITIVE's carve-out,
 * not a general "leaf module" excuse -- reused below for the general
 * rule because the same shape also describes a pure test-helper module
 * that takes its I/O as arguments and calls into nothing of its own.
 */
const primitive = (t) => !/from 'node:path'/.test(t)
  && !/path\.(join|resolve)\(/.test(t)
  && !/from '\.\/[^']+\.mjs'/.test(t);

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
  // (`code` now lives at module scope, above -- see the note there.)

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
  // (`selfCleaning` now lives at module scope, above -- see the note there.)

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
  // (`primitive` now lives at module scope, above -- see the note there.)

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
  // module slips through and the guarantee above passes forever. Tests
  // the module-scope function directly now, not a private copy that
  // could drift from what the guard actually runs.

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
  // guarantee would pass forever while watching nothing. Tests the
  // module-scope function directly (see the note where it is defined) --
  // it is the same function the general reachability rule below uses to
  // excuse test-helper modules like `clihelp.mjs`.

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

// =========================================================================
// REACHABLE OR DECLARED — the general rule (B7, 2026-09-20 build plan)
// =========================================================================
//
// The rule above catches one specific defect: an append-log with no
// reader. The house has a wider one, `built-but-out-of-reach`, logged
// twelve times: a module built, tested and documented that nothing in
// operation ever reaches. B7 asks for that general case, stated once:
//
//   every src/ module is reachable from a CLI entry point, OR it is
//   explicitly declared "not yet wired", with a date and a reason.
//
// This does NOT replace the log-reader rule above. They check different
// GRAIN: the log rule asks whether one specific export (the reader) of
// an already-reachable module is ever called; a module can pass "the
// file is reached" while its reader export specifically sits dead next
// to a writer export that runs constantly -- which is exactly the
// `observations.mjs` incident this whole file opens with. Collapsing
// the two into one check would stop seeing that shape. Keeping the
// second, coarser check IN THE SAME FILE, sharing its comment-stripping
// and its `primitive` carve-out with the first, is what "generalise, do
// not duplicate" means here: one file, one set of building blocks, two
// grains of the same question.
//
// **Decision 1 -- what "reachable" means, and what it does NOT see.**
// An import graph out of the CLI entry points (bin/*, src/cli/*.mjs,
// src/cli/commands/*.mjs), following both static `from '...'` and
// dynamic `import('...')` edges. A module is reachable if the graph
// walk reaches its file.
//
//   - This is FILE-grain, like the log rule is EXPORT-grain reversed:
//     it proves the file is loaded somewhere real, not that any
//     particular export of it is ever called. A module reachable only
//     because one small helper is imported, while its main exported
//     function is dead code nobody calls, reads as fully wired here.
//     `indexcache.mjs` does not have this problem (it has zero
//     importers, not zero call-sites on an importer it has) -- but a
//     future module built the same way could, and this rule would not
//     catch it.
//   - A literal-specifier requirement misses ONE real shape this house
//     already ships: `bin/mem-before-edit` builds a `file://` URL out
//     of a shell variable and hands it to `node -e` as `argv[1]` --
//     `pointer.mjs` is reached that way, and no `from`/`import()`
//     literal names it. `literalPathReachable` below is the deliberate
//     patch for exactly this one shape (a real path substring, comments
//     stripped, in a bin/ file); it does not generalise to specifiers
//     built any other way (string concatenation across variables,
//     `path.join` at runtime, a config value). Any module reached only
//     through one of THOSE would be invisible to both checks and would
//     have to be found by hand, the way this one was.
//
// **Decision 2 -- how the declaration does not become a permanent
// excuse.** Two independent expirations, not one:
//
//   - TIME: `isExpired` in test/not-yet-wired.mjs, 14 days per the
//     build plan. The SABOTAGE block below proves a backdated
//     declaration goes red again, not just that the function returns
//     the right boolean.
//   - TRUTH: a declaration for a module that is ALREADY reachable is
//     stale the moment it becomes true, not 14 days later -- the "the
//     module is already wired" check below fires immediately once B8
//     (or whoever) finishes wiring `indexcache` in, rather than
//     leaving the excuse sitting there correctly-dated but wrong.
//
// **Decision 3 -- avoiding false alarms.** Reuses the SAME `primitive`
// carve-out from the log rule above, unchanged, rather than inventing a
// name list of "test helpers". `clihelp.mjs` (a pure parsing module used
// only by test files, with no relative import and no path-building of
// its own) matches the identical structural shape append.mjs already
// used to earn its carve-out: it imports nothing from this house. The
// COUNTER-PROBE tests above already prove this predicate cannot be
// widened for free.

/** Every file directly under `bin/`, plus src/cli and src/cli/commands. */
function cliEntryFiles(root) {
  const out = [];
  const binDir = path.join(root, 'bin');
  if (fs.existsSync(binDir)) {
    for (const f of fs.readdirSync(binDir)) {
      const full = path.join(binDir, f);
      if (fs.statSync(full).isFile()) out.push(full);
    }
  }
  for (const sub of ['src/cli', 'src/cli/commands']) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mjs')) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).isFile()) out.push(full);
    }
  }
  return out;
}

/**
 * `.mjs`/`.js` get the JS-only comment rules already used above (`code`)
 * -- stripping `#` there would corrupt embedded CSS (`src/astra.mjs` and
 * `src/viewer.mjs` both contain literal `#id{...}` selectors) and private
 * class fields. Everything else under bin/ (the bash and .ps1 hooks) has
 * no such content, and DOES use `#` and `<# #>` for real comments.
 */
function stripForKind(file, raw) {
  if (/\.mjs$|\.js$/.test(file)) return code(raw);
  return raw.replace(/<#[\s\S]*?#>/g, ' ').replace(/(^|\n)\s*#[^\n]*/g, '$1');
}

/** Static `from '...'` and dynamic `import('...')` edges, literal specifiers only. */
function relativeImportTargets(file) {
  const t = stripForKind(file, fs.readFileSync(file, 'utf8'));
  const specs = [
    ...[...t.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...t.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  const out = [];
  for (const spec of specs) {
    let p = path.resolve(path.dirname(file), spec);
    if (!p.endsWith('.mjs') && !p.endsWith('.js')) {
      if (fs.existsSync(`${p}.mjs`)) p += '.mjs';
      else if (fs.existsSync(path.join(p, 'index.mjs'))) p = path.join(p, 'index.mjs');
    }
    out.push(p);
  }
  return out;
}

/** Every file reached from the CLI entry points, transitively. */
function importGraphReachable(root) {
  const seen = new Set();
  const queue = cliEntryFiles(root);
  while (queue.length) {
    const f = queue.pop();
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
    const real = fs.realpathSync(f);
    if (seen.has(real)) continue;
    seen.add(real);
    for (const dep of relativeImportTargets(f)) {
      if (fs.existsSync(dep) && fs.statSync(dep).isFile()) queue.push(dep);
    }
  }
  return seen;
}

/**
 * The one disclosed patch for a shape the graph above cannot see: a
 * bin/ shell script builds the module's path in a variable and hands it
 * to `node -e` as an argv string (`bin/mem-before-edit` does this for
 * `pointer.mjs`). A real, executed mention of `src/<name>.mjs` — not a
 * comment — is treated as a live wire.
 */
function literalPathReachable(root, moduleFileName) {
  const binDir = path.join(root, 'bin');
  if (!fs.existsSync(binDir)) return false;
  const needle = new RegExp(`src[\\\\/]${moduleFileName.replace('.', '\\.')}\\b`);
  for (const f of fs.readdirSync(binDir)) {
    const full = path.join(binDir, f);
    if (!fs.statSync(full).isFile()) continue;
    if (needle.test(stripForKind(full, fs.readFileSync(full, 'utf8')))) return true;
  }
  return false;
}

/**
 * The whole verdict for one root: which src/ modules are reachable,
 * which are excused as the primitive/test-helper shape, which are
 * covered by a live declaration, which are covered by an EXPIRED one,
 * and which are neither reachable nor declared at all.
 */
function reachabilityReport(root, { declarations = {}, today = new Date() } = {}) {
  const srcDir = path.join(root, 'src');
  const files = fs.existsSync(srcDir)
    ? fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs')) : [];
  const graphSeen = importGraphReachable(root);
  const result = {
    checked: files.length, graphSize: graphSeen.size,
    reachable: [], excusedPrimitive: [], declaredValid: [], declaredExpired: [], unreachable: [],
  };
  for (const f of files) {
    const full = path.join(srcDir, f);
    const real = fs.realpathSync(full);
    if (graphSeen.has(real) || literalPathReachable(root, f)) { result.reachable.push(f); continue; }
    if (primitive(code(fs.readFileSync(full, 'utf8')))) { result.excusedPrimitive.push(f); continue; }
    const name = f.replace(/\.mjs$/, '');
    const decl = declarations[name];
    if (decl) {
      if (isExpired(decl, today)) { result.declaredExpired.push(f); result.unreachable.push(f); }
      else result.declaredValid.push(f);
      continue;
    }
    result.unreachable.push(f);
  }
  return result;
}

test('REACHABLE OR DECLARED: every src module is callable from a CLI entry point, or declared not-yet-wired', () => {
  const r = reachabilityReport(ROOT, { declarations: NOT_YET_WIRED });
  // Leerlauf-Sperre / idle-lock, same pattern as the appending-modules
  // floor above: if the graph walk or the directory read is looking in
  // the wrong place, it returns something small and clean instead of
  // failing loudly. Refuse to call that a pass.
  assert.ok(r.checked >= 40, `only ${r.checked} src modules found — the probe scans the wrong place`);
  assert.ok(r.graphSize >= 40,
    `the import graph out of bin/ only reached ${r.graphSize} files — the probe scans the wrong place`);
  assert.deepEqual(r.unreachable, [],
    'these src modules have no caller reachable from bin/, no literal wiring in a hook script, '
    + `and no not-yet-wired declaration in test/not-yet-wired.mjs: ${r.unreachable.join(', ')}. `
    + '`built-but-out-of-reach` — either wire them in, or declare them with a date and a reason.');
});

test('CONTROL: the primitive/test-helper carve-out used here stays small', () => {
  // Mirrors the cap on the append-primitive carve-out above. The same
  // predicate now excuses a second category (leaf test-helpers); if it
  // starts absorbing real, unwired production modules, the rule has
  // quietly stopped applying to the house.
  const r = reachabilityReport(ROOT, { declarations: NOT_YET_WIRED });
  assert.ok(r.excusedPrimitive.length <= 2,
    `${r.excusedPrimitive.length} modules excused as primitive/test-helper `
    + `(${r.excusedPrimitive.join(', ')}) — that is no longer a carve-out, it is a hole`);
});

test('POSITIVE CONTROL: real modules wired in different ways are not reported', () => {
  // The most important probe here. Six modules, four different wiring
  // shapes, so the guard is proven against the house as it actually is,
  // not against one convenient case:
  //
  //   memory, chain     static `import * as X from '...'`, called as X.fn()
  //   gauges, injection,
  //   pathcheck, shred,
  //   teach             `const x = await import('../../x.mjs')` from a
  //                     command handler (admin/setup/capture/write.mjs)
  //   pointer           NOT an ESM import at all — a bin/ shell script
  //                     builds a file:// URL from a shell variable and
  //                     hands it to `node -e` as argv[1]
  const r = reachabilityReport(ROOT, { declarations: NOT_YET_WIRED });
  const flagged = new Set([...r.unreachable, ...r.excusedPrimitive]);
  for (const m of ['memory.mjs', 'chain.mjs', 'gauges.mjs', 'injection.mjs',
    'pathcheck.mjs', 'shred.mjs', 'teach.mjs', 'pointer.mjs']) {
    assert.ok(!flagged.has(m), `${m} is genuinely wired and must not be reported`);
  }
});

test('DECLARATIONS: every not-yet-wired entry names a real module that is still actually unreachable', () => {
  // Two ways a declaration rots that are NOT the 14-day clock:
  //   - the key no longer names a file in src/ (renamed or deleted)
  //   - the module it names has since been wired in for real, and the
  //     declaration is now a stale excuse sitting next to a truth it
  //     contradicts -- this fires the moment that happens, not 14 days
  //     later.
  const graphSeen = importGraphReachable(ROOT);
  for (const [name, decl] of Object.entries(NOT_YET_WIRED)) {
    const file = `${name}.mjs`;
    const full = path.join(ROOT, 'src', file);
    assert.ok(fs.existsSync(full), `declared module '${name}' does not exist at src/${file}`);
    const real = fs.realpathSync(full);
    assert.ok(!graphSeen.has(real) && !literalPathReachable(ROOT, file),
      `'${name}' is declared not-yet-wired but is already reachable — remove the declaration, not the guard`);
    assert.ok(typeof decl.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(decl.since),
      `declaration for '${name}' has no valid ISO date`);
  }
});

test('DECLARATIONS: every reason argues, it does not label', () => {
  // Same floor as doctor.OK_OVER_ZERO's exemptions (test/doctor-exemptions.test.mjs):
  // a label excuses everyone forever, an argument can be checked and disagreed with.
  for (const [name, decl] of Object.entries(NOT_YET_WIRED)) {
    assert.ok(typeof decl.reason === 'string' && decl.reason.length >= 40,
      `the declaration for '${name}' has no real reason: ${JSON.stringify(decl.reason)}`);
    assert.match(decl.reason, /which|because|and |—|-{2}/,
      `the declaration for '${name}' states a category, not an argument: ${decl.reason}`);
  }
});

test('SABOTAGE / CONTROL: the guard on a synthetic house, red -> green -> red again', () => {
  // Builds a minimal root with its own bin/ and src/ rather than
  // touching this repo's actual src/, so the sequence below can create
  // and later mis-date an "unwired module" without going anywhere near
  // the files this task is not allowed to edit.
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reach-'));
  try {
    fs.mkdirSync(path.join(w, 'bin'));
    fs.mkdirSync(path.join(w, 'src'));
    // A module that IS wired, so the sabotage below has a positive
    // control living right next to it.
    fs.writeFileSync(path.join(w, 'src', 'wired.mjs'),
      "import path from 'node:path';\nexport function foo(p) { return path.join(p, 'x'); }\n");
    fs.writeFileSync(path.join(w, 'bin', 'mem'),
      "import * as wired from '../src/wired.mjs';\nwired.foo('.');\n");
    // The sabotage target: real shape (imports node:path, so it is NOT
    // excused as a primitive), never imported anywhere.
    fs.writeFileSync(path.join(w, 'src', 'orphan.mjs'),
      "import path from 'node:path';\nexport function bar(p) { return path.join(p, 'y'); }\n");

    // RED: new module, not wired, not declared.
    let r = reachabilityReport(w, { declarations: {} });
    assert.deepEqual(r.unreachable, ['orphan.mjs'], 'the new module should turn the guard red');
    assert.ok(!r.unreachable.includes('wired.mjs'), 'the wired sibling must not be flagged');

    // GREEN: declare it, dated today.
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);
    r = reachabilityReport(w, {
      declarations: { orphan: { since: iso, reason: 'declared for the sabotage probe, dated today' } },
    });
    assert.deepEqual(r.unreachable, [], 'a fresh declaration should clear the module');
    assert.deepEqual(r.declaredValid, ['orphan.mjs']);

    // RED again: same declaration, backdated 15 days -- the excuse expires.
    const old = new Date(today.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    r = reachabilityReport(w, {
      declarations: { orphan: { since: old, reason: 'declared for the sabotage probe, dated 15 days ago' } },
    });
    assert.deepEqual(r.unreachable, ['orphan.mjs'],
      'a declaration older than the TTL must not excuse the module forever');
    assert.deepEqual(r.declaredExpired, ['orphan.mjs']);

    // And the boundary: 13 days back is still inside the 14-day TTL.
    const almost = new Date(today.getTime() - (TTL_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    r = reachabilityReport(w, {
      declarations: { orphan: { since: almost, reason: 'declared for the sabotage probe, one day inside the TTL' } },
    });
    assert.deepEqual(r.unreachable, [], `${TTL_DAYS - 1} days old should still be inside the ${TTL_DAYS}-day TTL`);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('SABOTAGE CONTROL: a declaration naming a module that does not exist is caught', () => {
  // Mirrors doctor-exemptions.test.mjs's staleness check. Without this,
  // the "names a real module" assertion above could be vacuously true
  // forever (e.g. if the loop body were accidentally skipped).
  const fake = { ...NOT_YET_WIRED, 'a-module-that-does-not-exist': { since: '2026-01-01', reason: 'x' } };
  const stale = Object.keys(fake).filter((n) => !fs.existsSync(path.join(ROOT, 'src', `${n}.mjs`)));
  assert.deepEqual(stale, ['a-module-that-does-not-exist'],
    'the existence check cannot see a declared name that matches no file');
});
