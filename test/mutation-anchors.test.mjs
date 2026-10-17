// A mutation anchor that no longer matches is a guarantee that stopped
// being checked — silently.
//
// **The finding, 2026-09-17.** Translating the German identifiers in
// this repo renamed `seite`, `exakte`, `exaktIds`, `gereiht` and
// `gefiltert`. Six mutants in `bench/mutation.mjs` were anchored on
// those exact lines. They did not fail — they stopped running:
//
//     61/61 applied mutants caught by tests (of 67 defined;
//     6 anchor gone, 0 ambiguous).
//
// The mutation runner says it plainly, and the CI job goes red, which
// is why it was caught at all. This probe puts the same check where a
// developer meets it: in the test suite, before the push.
//
// It is cheap — string containment, no mutation applied — so it can run
// with every `npm test` while the full mutation sweep stays a CI job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS, MIXED_SUITES, browserBound, browserOnly } from '../bench/mutation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');


// **The catalogue comes from the module, not from a parser of our own.**
//
// The first version of this probe read `bench/mutation.mjs` as text and
// rebuilt the entries with a regular expression. It found 3 of the 5
// broken anchors: the catalogue uses both quote styles, and a `\n`
// inside one anchor was two characters to it instead of one newline.
// A re-implemented parser is a second truth about the same file — and
// it gets things wrong in different places than the original.
//
// `bench/mutation.mjs` now exports the list, and its sweep sits behind
// a main guard so this import does not set the whole run going.

test('every mutation anchor still matches the code it guards', () => {
  const all = MUTANTS;
  assert.ok(all.length >= 40,
    `only ${all.length} anchors parsed — the catalogue changed shape and this probe reads it wrong`);

  const cache = new Map();
  const gone = [];
  for (const m of all) {
    const p = path.join(ROOT, m.file);
    if (!cache.has(p)) cache.set(p, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
    const text = cache.get(p);
    if (text === null) { gone.push(`${m.name} → missing file ${m.file}`); continue; }
    if (!text.includes(m.from)) gone.push(`${m.name} → ${m.file}: ${m.from.trim().slice(0, 60)}`);
  }
  assert.deepEqual(gone, [],
    'These mutants can no longer be applied. They do not fail — they stop running, '
    + 'and the guarantee behind each one quietly stops being checked.');
});

test('an anchor matches EXACTLY ONE place, or the mutant is ambiguous', () => {
  // The runner reports "ambiguous" separately, and for the same reason:
  // a mutant applied to the wrong one of two identical lines measures
  // something nobody chose.
  const cache = new Map();
  const repeated = [];
  for (const m of MUTANTS) {
    const p = path.join(ROOT, m.file);
    if (!cache.has(p)) cache.set(p, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    const text = cache.get(p);
    if (!text) continue;
    const n = text.split(m.from).length - 1;
    if (n > 1) repeated.push(`${m.name} → ${n}x in ${m.file}`);
  }
  assert.deepEqual(repeated, [],
    'These anchors match more than one line — which one gets mutated is then luck.');
});

// **Every mutant has a probe that runs without a browser (CI run 1180).**
//
// The guarantees job installs `npm ci --omit=optional`: no Playwright, so a browser probe skips. A mutant whose
// ONLY probes are browser probes then passes its suites "with N tests skipped" and the harness reports it NOT JUDGED
// HERE (CI run 1141 for card-byline-ui; run 1180 for the four "quiet AA" mutants, one red slice each). The cure is a
// logic half that runs everywhere - and this probe, so the next family cannot be added without one.
const readTest = (f) => { const p = path.join(ROOT, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };

test('every mutant names at least one test file that runs without a browser', () => {
  assert.deepEqual(browserOnly(MUTANTS, readTest), [],
    'These mutants are checked by browser probes alone; in the guarantees job (no Playwright) they are NOT JUDGED. '
    + 'Add the logic half of the probe to their test list (as test/quiet-aa-cm.test.mjs does for the quiet-AA family).');
});

test('every test file a mutant names exists', () => {
  const missing = [...new Set(MUTANTS.flatMap((m) => m.tests ?? []))].filter((f) => readTest(f) === null);
  assert.deepEqual(missing, []);
});

test('the browser-bound reader: a name with "browser", or the browser fixture without a reason to be mixed; red on a made-up catalogue', () => {
  const files = {
    'test/a-browser.test.mjs': "import { lazyBrowser } from './fixture/browser.mjs';",
    'test/b.test.mjs': "import { startView } from './fixture/browser.mjs';",
    'test/c.test.mjs': "import test from 'node:test';",
    'test/d.test.mjs': "import { chromium } from 'playwright';",
  };
  const read = (f) => files[f] ?? null;
  assert.equal(browserBound('test/a-browser.test.mjs', read), true, 'the name says it');
  assert.equal(browserBound('test/b.test.mjs', read), true, 'loads the browser fixture');
  assert.equal(browserBound('test/b.test.mjs', read, { 'test/b.test.mjs': 'mixed' }), false, 'named as mixed, with its reason');
  assert.equal(browserBound('test/c.test.mjs', read), false);
  assert.equal(browserBound('test/d.test.mjs', read), true, 'loads playwright');
  const list = [
    { name: 'only browser', tests: ['test/a-browser.test.mjs', 'test/b.test.mjs'] },
    { name: 'with a logic half', tests: ['test/c.test.mjs', 'test/a-browser.test.mjs'] },
    { name: 'playwright only', tests: ['test/d.test.mjs'] },
  ];
  assert.deepEqual(browserOnly(list, read), ['only browser', 'playwright only']);
  // The catalogue in its state before this fix (9a10bf6..): the four quiet-AA mutants with the browser probe alone are named.
  const old = MUTANTS.filter((m) => m.name.startsWith('quiet AA:')).map((m) => ({ ...m, tests: ['test/quiet-aa-cm-browser.test.mjs'] }));
  assert.equal(old.length, 4);
  assert.equal(browserOnly(old, readTest).length, 4, 'red: the four mutants as run 1180 saw them');
});

test('each reason to be mixed still holds: the file exists and loads the browser fixture (a stale entry would hide a browser-only mutant)', () => {
  for (const f of Object.keys(MIXED_SUITES)) {
    const text = readTest(f);
    assert.ok(text !== null, `${f} exists`);
    assert.match(text, /fixture\/browser\.mjs/, `${f} no longer loads the browser fixture - drop it from MIXED_SUITES`);
    assert.ok(MUTANTS.some((m) => (m.tests ?? []).includes(f)), `${f} is named by no mutant - drop it from MIXED_SUITES`);
  }
});
