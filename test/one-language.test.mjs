// One vocabulary, in the pages a user actually sees.
//
// **The decision this guards (duty yokytyr8yst5, decided 2026-09-17).**
// Two deliberate deviations from the integration brief were made when
// the desk was built, both named at the end of PR #3 so a reviewer would
// not have to hunt for them. They are kept, and this file is the reason
// they are a decision rather than an opinion:
//
//   1. The navigation reads Overview / Knowledge / Work / Sources /
//      Operations / Settings, not Übersicht / Wissen / Arbeit / … (the
//      desk's tabs were Desk / Knowledge / Projects / Agents / Net; since
//      2026-09-28 the dashboard is the only UI, and the rule carries over). cheap-mem is the
//      public tool and is English throughout — docs say so explicitly,
//      the console, the viewer, the CLI help and the entry type names
//      are English. German tabs over an English console would be the two
//      vocabularies this codebase fights everywhere else.
//   2. The detail label is "built on", not "Provenance". In cheap-mem
//      `src/provenance.mjs` is a FRESHNESS state over the whole memory,
//      not something per entry; what exists per entry is
//      `origin.derived_from`, and that is what is shown. Using the word
//      "Provenance" for both would be one word for two things — the same
//      defect class, one level down.
//
// A decision without a guard is an opinion, and the next session
// translating one label back would be doing a reasonable thing for a
// reasonable reason. So: the closed list below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as config from '../src/config.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as dashboardPage from '../src/dashboard-page.mjs';
import * as viewer from '../src/viewer.mjs';

// The dashboard's words live in its script: the page shell plus the
// script the browser runs are what a user reads.
const SCRIPT = fs.readFileSync(new URL('../assets/dashboard/dashboard.js', import.meta.url), 'utf8');

const away = (r) => fs.rmSync(r, { recursive: true, force: true });

/** A memory with English content, so a hit below is the UI's own word. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sprache-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  config.writeConfig(root, config.DEFAULT_CONFIG);
  const ts = '2026-09-01T10:00:00Z';
  memory.logEntry(root, 'error', { id: 'err00001', title: 'the pipeline stalled', ts });
  memory.logEntry(root, 'learning', {
    id: 'les00001', learning: 'restart the worker first', ts,
    origin: { derived_from: ['err00001'] },
  });
  memory.logEntry(root, 'decision', { id: 'dec00001', choice: 'keep it', why: 'measured', ts });
  return root;
}

/**
 * Words that would betray a mixed vocabulary in a rendered page.
 *
 * Closed and small on purpose: a list that tried to catch "German" in
 * general would catch a person's name or a project called `Kolibri`.
 * These are the labels a translation pass would actually produce.
 */
const GERMAN_LABELS = Object.freeze([
  'Pult', 'Wissen', 'Projekte', 'Agenten', 'Netz', 'Einstellungen',
  'Herkunft', 'Entscheidung', 'Fehler', 'Erkenntnis', 'Pflicht', 'Frage',
  'Zurück', 'Übersicht', 'Suche', 'Speichern', 'Löschen',
]);

const pages = () => {
  const root = world();
  try {
    return {
      desk: dashboardPage.asHtml({ title: 'x' }) + SCRIPT,
      viewer: viewer.build([root], { title: 'x' }).html,
    };
  } finally { away(root); }
};

test('POSITIVE: the probe really reads pages with navigation in them', () => {
  // Without this, "no German label" would hold against an empty string.
  const s = pages();
  assert.ok(s.desk.length > 5000, `desk page only ${s.desk.length} characters`);
  assert.ok(s.viewer.length > 5000, `viewer page only ${s.viewer.length} characters`);
  for (const word of ['Knowledge', 'Projects', 'Agents', 'Overview']) {
    assert.ok(s.desk.includes(word), `the desk has no '${word}' tab — wrong page?`);
  }
});

test('no rendered page carries a German label', () => {
  const s = pages();
  for (const [name, html] of Object.entries(s)) {
    for (const word of GERMAN_LABELS) {
      // Word boundary, so 'Fehler' does not hit inside a URL or an id.
      const re = new RegExp(`(^|[>\\s"'(])${word}($|[<\\s"'.,:;)])`);
      assert.equal(re.test(html), false,
        `the ${name} page says '${word}' — cheap-mem is English throughout, `
        + 'and half-translated navigation is the two vocabularies this repo fights');
    }
  }
});

test('the detail label is "built on", and deliberately not "Provenance"', () => {
  // `src/provenance.mjs` is a freshness state over the whole memory. The
  // per-entry thing shown here is `origin.derived_from`. One word for
  // both would be the same defect one level down.
  const html = pages().desk;
  assert.match(html, /built on<\/span>/,
    'the "built on" label is gone — if it was renamed, the reason above has to be re-read');
  assert.equal(/<span>[^<]*Provenance[^<]*<\/span>/i.test(html), false,
    'the per-entry field is now called Provenance, which is what the whole-memory '
    + 'freshness state in src/provenance.mjs is called');
});

test('the tab names come from ONE place, not from each page', () => {
  // The decision is only enforceable while there is a single list. Two
  // lists would let a rename land in one page and not the other, which
  // is exactly how a half-translated UI happens.
  // Not the exact list — that grows, and a probe pinned to today's
  // seven breaks on every honest addition. What must hold is that every
  // name is an English lower-case identifier and that there IS only one
  // list.
  assert.ok(dashboard.VIEWS.length >= 5, `only ${dashboard.VIEWS.length} views`);
  for (const v of dashboard.VIEWS) {
    assert.match(v, /^[a-z][a-z0-9-]*$/, `view name '${v}' is not a plain identifier`);
    assert.equal(GERMAN_LABELS.some((w) => w.toLowerCase() === v), false,
      `view '${v}' is a German label`);
  }
  const src = fs.readFileSync(new URL('../src/dashboard.mjs', import.meta.url), 'utf8');
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  assert.equal((withoutComments.match(/export const VIEWS = /g) || []).length, 1,
    'VIEWS is declared more or less than once');
});
