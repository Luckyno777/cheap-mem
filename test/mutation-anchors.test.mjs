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
import { MUTANTS } from '../bench/mutation.mjs';

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
  const mehrfach = [];
  for (const m of MUTANTS) {
    const p = path.join(ROOT, m.file);
    if (!cache.has(p)) cache.set(p, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    const text = cache.get(p);
    if (!text) continue;
    const n = text.split(m.from).length - 1;
    if (n > 1) mehrfach.push(`${m.name} → ${n}x in ${m.file}`);
  }
  assert.deepEqual(mehrfach, [],
    'These anchors match more than one line — which one gets mutated is then luck.');
});
