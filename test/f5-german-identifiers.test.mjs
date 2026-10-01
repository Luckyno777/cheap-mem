// F5 / suggestion list item 23 (cheap-mem half): German IDENTIFIERS in the
// English-only product.
//
// **What the two existing probes do, and the gap.** `english-only.test.mjs`
// reads COMMENT lines of src/, bin/, test/, bench/ and flags a line with two
// distinct German function words; `english-ratchet.test.mjs` runs the same
// two-word rule over EVERY line of every tracked text file and ratchets the
// count per file. Both look for German SENTENCES. An identifier carries no
// function word: `const zaehler = 0`, `kurzhash`, `ablage`, `FELD_KANTEN`
// pass both, however German they are (audit 2026-09-30).
//
// **This probe.** It takes the identifiers out of CODE (comments and
// string/template literals removed, so test fixtures and the synonym lists
// in src/thesaurus.mjs -- German on purpose -- are not read), splits them
// at camelCase / snake_case boundaries, and flags an identifier that holds a
// word from GERMAN_IDENTIFIER_WORDS (test/english-dictionary.mjs, shared
// with the file-name and comment checks of english-ratchet.test.mjs).
// Shell, PowerShell and the CI workflow are read too: there the identifiers
// are the variables (`$kandidat`, `${datei}`), assignments, `for x in`
// loops and function names -- the places install/ and .github/ hid German
// names until 2026-10-01.
//
// **The list is a list of unmistakable German code words, not a language
// detector.** Words that are also English ("probe", "agent", "stand", "text",
// "rest", "minute", "hole", ...) are NOT on it; a German identifier built
// from other words slips through. That is the cost of a rule that never
// flags English.
//
// **Zero, with named exceptions -- no longer a ceiling (2026-10-01).** The
// first version capped the old stock per file (38 files, 64 identifiers).
// The English pass of 2026-10-01 renamed that stock, so the cap became a
// list: every German identifier still in the code is named in ALLOWED with
// the file it lives in and the reason it must stay -- a persisted record
// field, a key the sibling house writes, the frozen eval's own module.
// Anything else, in any file, fails. An entry that no longer matches fails
// too, so the list can only shrink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { files, read, stripComments, ROOT } from './f5-source.mjs';
import { GERMAN_IDENTIFIER_WORDS } from './english-dictionary.mjs';

export { GERMAN_IDENTIFIER_WORDS };

function isGerman(id) {
  const parts = id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_$]+/).filter(Boolean);
  const whole = id.toLowerCase().replace(/[_$]/g, '');
  return parts.some((p) => GERMAN_IDENTIFIER_WORDS.has(p)) || GERMAN_IDENTIFIER_WORDS.has(whole);
}

/** Identifiers of a JavaScript text that contain a German word (distinct). */
export function germanIdentifiers(text) {
  // One pass over strings, template literals and regex literals, so a
  // quote inside a regex or a slash inside a string cannot derail the
  // other: a regex literal is data (the frozen eval grades German
  // answers with `/nicht eindeutig/`), not a name.
  const code = stripComments(text)
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|([(\[,=:!&|?{};]|\breturn)\s*\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[a-z]*/g,
      (m, lead) => (lead === undefined ? ' ' : `${lead} `))
    .replace(/\/\/.*$/gm, ''); // trailing line comments (whole-line ones are gone already)
  const found = new Set();
  for (const id of new Set(code.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [])) if (isGerman(id)) found.add(id);
  return [...found].sort();
}

/**
 * Identifiers of a shell, PowerShell or workflow text: variables
 * (`$x`, `${x}`, `$env:x`), assignments (`x=`), `for x in`, `foreach ($x`,
 * function names (`x()`, `function x`), and -- for the JavaScript a
 * workflow step embeds -- `const|let|var x`. `#` comments are dropped
 * first; quoted strings are NOT, because `"$kandidat/.mem"` is code.
 */
export function germanShellIdentifiers(text) {
  const code = text.split('\n').map((l) => l.replace(/(^|\s)#(?![!{]).*$/, '$1')).join('\n');
  const found = new Set();
  const take = (re) => { for (const m of code.matchAll(re)) if (isGerman(m[1])) found.add(m[1]); };
  take(/\$\{?(?:env:)?([A-Za-z_][A-Za-z0-9_]*)/g);
  take(/(?:^|[\s;(])([A-Za-z_][A-Za-z0-9_]*)=/gm);
  take(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g);
  take(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{/gm);
  take(/\bfunction\s+([A-Za-z_][A-Za-z0-9_-]*)/g);
  take(/\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g);
  return [...found].sort();
}

/**
 * The German identifiers that STAY, each with its reason. Keyed by file,
 * then identifier. Not a count: a new German name next to an allowed one
 * fails just the same.
 */
const PERSISTED_RELEASE = 'field of the release records `mem release` has written since 2026-09 (history.jsonl, current.json); renaming it would orphan every existing release history';
const SIBLING_MAP = "key of shared/finding-map.jsonl, which is byte-identical with lucky-mem's geteilt/befund-zuordnung.jsonl (never edited here)";
const SIBLING_INVARIANTS = 'key of the cross-house invariants file (shared/invariants.jsonl), written in the sibling house\'s spelling';
const SIBLING_DOCTOR = "key of lucky-mem's `mem doktor --json` summary, which the real-corpus phase measures";
const SIBLING_ENTRY = "field name of lucky-mem's entries, which this bench reads from a real sibling corpus";
const LEGACY_DOCS_STATE = 'the pre-2026-10-01 key of docs/images/.state.json, still read so an older state file stays good';
const EVAL_RECORD = 'key of the German-language eval\'s run records (eval/runs/*.jsonl, exempt measurement records carry it); renaming it splits the record format';
const EVAL_WORLD = 'field of the German-language eval world the frozen tasks are graded against';
const FROZEN_EVAL = "eval/tasks.mjs's exported metric of the frozen eval (sha256-pinned split, test/eval-frozen.test.mjs)";
export const ALLOWED = Object.freeze({
  'src/release.mjs': { kurzhash: PERSISTED_RELEASE },
  'src/dashboard-data.mjs': { kurzhash: PERSISTED_RELEASE },
  'assets/dashboard/dashboard.js': { kurzhash: PERSISTED_RELEASE },
  'test/release.test.mjs': { kurzhash: PERSISTED_RELEASE },
  'test/release-dashboard-wiring.test.mjs': { kurzhash: PERSISTED_RELEASE },
  'src/findingmirror.mjs': { warum: SIBLING_MAP, luecke: SIBLING_MAP },
  'test/finding-mirror.test.mjs': { befund: SIBLING_MAP, warum: SIBLING_MAP },
  'test/integration-contract.test.mjs': { befund: SIBLING_MAP, warum: SIBLING_MAP },
  'test/invariants.test.mjs': { warum: SIBLING_INVARIANTS, pruefung: SIBLING_INVARIANTS },
  'bench/atlas/phase-real.mjs': { fehler: SIBLING_DOCTOR, kontextMs: 'field of a measurement pinned in bench/atlas-baseline.json (real.cli.kontext, named after the sibling CLI command it times)' },
  'bench/duplicate-rate.mjs': { warum: SIBLING_ENTRY },
  'test/audit-edges.test.mjs': { herkunft: 'fixture: a sibling-style provenance key the net must NOT read as a link' },
  'test/entry-content.test.mjs': { hilfe: 'fixture: the swallowed `--hilfe` flag a user typed, which must not count as content' },
  'test/docs-images-fresh.test.mjs': { oberflaeche: LEGACY_DOCS_STATE, erzeugt_am: LEGACY_DOCS_STATE },
  'eval/pair.mjs': Object.fromEntries(['lauf', 'schwelle', 'fehler', 'antwort', 'zahlen', 'gesamt', 'ohne'].map((k) => [k, EVAL_RECORD]).concat([['erfundeneZahlen', FROZEN_EVAL]])),
  'eval/pair-evaluate.mjs': { fehler: EVAL_RECORD },
  'eval/world.mjs': { grund: EVAL_WORLD, ziel: EVAL_WORLD },
  'src/docimages-state.mjs': { oberflaeche: LEGACY_DOCS_STATE, erzeugt_am: LEGACY_DOCS_STATE },
  'eval/tasks.mjs': { erfundeneZahlen: FROZEN_EVAL, gesamt: FROZEN_EVAL },
  'test/eval-frozen.test.mjs': { erfundeneZahlen: FROZEN_EVAL },
});

const JS = /\.(mjs|js|cjs)$/;
const SHELL = /\.(sh|ps1|ya?ml)$/;
const isNodeBin = (rel) => /^bin\/[^.]+$/.test(rel) && read(rel).startsWith('#!/usr/bin/env node');

/** Every file the probe reads, with the reader it needs. */
export function candidates() {
  const out = [];
  for (const d of ['src', 'bin', 'test', 'bench', 'eval', 'install', 'hooks', 'assets/dashboard', '.github']) {
    for (const rel of files(d, (n) => JS.test(n) || SHELL.test(n) || !n.includes('.'))) {
      const r = rel.split('\\').join('/');
      // The dictionary and this probe hold German words as DATA (the lists
      // and the planted controls above); eval/runs/ is measurement records.
      if (r.startsWith('eval/runs/') || r.endsWith('english-dictionary.mjs') || r.endsWith('f5-german-identifiers.test.mjs')) continue;
      if (JS.test(r) || isNodeBin(r)) out.push([r, 'js']);
      else out.push([r, 'shell']);
    }
  }
  return out;
}

function scan() {
  const seen = {};
  for (const [rel, kind] of candidates()) {
    const ids = kind === 'js' ? germanIdentifiers(read(rel)) : germanShellIdentifiers(read(rel));
    if (ids.length) seen[rel] = ids;
  }
  return seen;
}

test('positive control: German identifiers are seen, English ones and strings are not', () => {
  assert.deepEqual(germanIdentifiers('const zaehler = 0; let kurzHash = x;'), ['kurzHash', 'zaehler']);
  assert.deepEqual(germanIdentifiers('const FELD_KANTEN = 1; function holeEintrag() {}'), ['FELD_KANTEN', 'holeEintrag']);
  assert.deepEqual(germanIdentifiers("const probe = 'zaehler'; // ablage\nconst agent = `kurzhash`;"), []);
  assert.deepEqual(germanIdentifiers('const sleeper = 1; const rest = 2; const stand = 3;'), []);
  // The single short words the 2026-10-01 pass found, and English that
  // shares their letters (hierId, ssTot, FROZEN_WITH_HOLE, muster-free):
  assert.deepEqual(germanIdentifiers('const ohneKommentare = 1; let welt; const roh = 2;'), ['ohneKommentare', 'roh', 'welt']);
  assert.deepEqual(germanIdentifiers('const hierId = 1; const ssTot = 2; const FROZEN_WITH_HOLE = 3; const lanePatterns = [];'), []);
  // A regex literal is data, a division is not a regex:
  assert.deepEqual(germanIdentifiers('const ok = /nicht eindeutig|zwei/i.test(x);'), []);
  assert.deepEqual(germanIdentifiers('const r = a / zeile / b;'), ['zeile']);
});

test('positive control: shell, PowerShell and workflow names are seen, prose and English are not', () => {
  assert.deepEqual(germanShellIdentifiers('for kandidat in a b; do\n  [ -f "$kandidat/x" ]\ndone'), ['kandidat']);
  assert.deepEqual(germanShellIdentifiers('$eintrag = @{ a = 1 }\nforeach ($e in $erwartet) { $fehlt += $e }'), ['eintrag', 'erwartet', 'fehlt']);
  assert.deepEqual(germanShellIdentifiers('entrutscht() { printf x; }\nconst behauptet = 1;'), ['behauptet', 'entrutscht']);
  assert.deepEqual(germanShellIdentifiers('# kandidat und eintrag in a comment\necho "no fehler here"\nfor candidate in a; do :; done'), []);
});

test('a German identifier planted in a scanned file turns the probe red (sabotage)', () => {
  // The whole-repo scan below is only worth something if a NEW German
  // name in a real file is caught. Plant one into a copy of a real
  // source and a real installer, the way an edit would.
  const src = read('src/archive.mjs') + '\nconst ablageNeu = 1;\n';
  assert.ok(germanIdentifiers(src).includes('ablageNeu'));
  const sh = read('install/hooks/session-start.sh') + '\nfor kandidat in a; do echo "$kandidat"; done\n';
  assert.ok(germanShellIdentifiers(sh).includes('kandidat'));
});

test('red proof: at the fixed commit 73969cc (before the English pass) the probe was red', (t) => {
  // House rule 12: pinned to a fixed commit, never a moving merge-base.
  let ps1;
  try {
    ps1 = execFileSync('git', ['show', '73969cc:install/windows.ps1'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { t.skip('commit 73969cc is not in this clone'); return; }
  assert.ok(germanShellIdentifiers(ps1).includes('kandidat'), 'the probe does not see the old installer loop variable');
  const old = execFileSync('git', ['show', '73969cc:src/net.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(germanIdentifiers(old).includes('FELD_KANTEN'));
});

test('the probe reads code in every area, not an empty list', () => {
  const c = candidates();
  for (const area of ['src/', 'bin/', 'test/', 'bench/', 'eval/', 'install/', '.github/']) {
    assert.ok(c.some(([r]) => r.startsWith(area)), `no file read under ${area}`);
  }
  assert.ok(c.filter(([, k]) => k === 'shell').length >= 15, 'the shell reader saw almost nothing');
  assert.ok(c.length >= 500, `only ${c.length} files read`);
});

test('no German identifier outside the named exceptions', () => {
  const seen = scan();
  const bad = [];
  for (const [rel, ids] of Object.entries(seen)) {
    const extra = ids.filter((id) => !(ALLOWED[rel] && id in ALLOWED[rel]));
    if (extra.length) bad.push(`${rel}: ${extra.join(', ')}`);
  }
  assert.deepEqual(bad, [], `German identifiers in an English-only product -- rename them:\n${bad.join('\n')}`);
});

test('every named exception still names a German identifier in its file', () => {
  // A reason for something that is gone is not a safe leftover, it is a
  // hole the next German name can walk through unnoticed.
  const seen = scan();
  const stale = [];
  for (const [rel, ids] of Object.entries(ALLOWED)) {
    for (const id of Object.keys(ids)) if (!(seen[rel] ?? []).includes(id)) stale.push(`${rel}: ${id}`);
  }
  assert.deepEqual(stale, [], `ALLOWED entries that no longer match -- remove them:\n${stale.join('\n')}`);
});
