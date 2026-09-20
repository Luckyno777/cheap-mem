// The measuring apparatus was measuring with the wrong vocabulary.
//
// **The finding (2026-09-20).** `bench/atlas/phase-real.mjs` compares
// lucky-mem's real corpus against a synthetic one built by
// `buildCorpus`, and one of the five comparisons is "how many entries
// are too thin to ever be found". Both sides were counted with ONE
// field list — lucky-mem's German one. The synthetic corpus is
// cheap-mem's, in English. Of seventeen German names, three (`topic`,
// `tags`, `text`) also exist on an English entry; `title`, `class`,
// `choice` and `why` were never read on the generated side at all.
//
// Measured after the fix: the English list finds on average 36.8 more
// weighted words per generated entry than the German one did. The
// reachability PERCENTAGE happened not to move, because the corpus's
// unreachable entries are thin in every field by construction — but
// that is a property of how `buildCorpus` shapes them today, not a
// reason the wrong list was safe. Change the shaping and the number
// silently becomes fiction again.
//
// This file pins three things: each corpus is measured by its own
// house's vocabulary, the English list is derived rather than copied,
// and the German copy is checked against the sister checkout instead of
// being trusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCorpus } from '../bench/atlas/core.mjs';
import { FIELD_WEIGHTS } from '../src/search.mjs';
import {
  WEIGHTED_FIELDS_DE, WEIGHTED_FIELDS_EN, weightedWordCount,
} from '../bench/atlas/phase-real.mjs';

/** Every entry of a freshly built synthetic corpus. */
function generatedEntries(count = 600) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-real-fields-'));
  try {
    buildCorpus(root, count);
    const rows = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) { walk(p); continue; }
        if (!name.endsWith('.jsonl')) continue;
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (!line) continue;
          try { rows.push(JSON.parse(line)); } catch { /* counted elsewhere */ }
        }
      }
    };
    walk(root);
    return rows;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the English list is derived from the search weights, not copied beside them', () => {
  assert.deepEqual([...WEIGHTED_FIELDS_EN], Object.keys(FIELD_WEIGHTS));
  // A copy would pass the line above on the day it was written. This is
  // the part that stays true later: the two objects are the same list
  // because one is built from the other, so a field that gains a weight
  // cannot be missing here.
  assert.ok(WEIGHTED_FIELDS_EN.length >= 15,
    'the search ranks on far more than a handful of fields');
});

test('the two vocabularies are NOT interchangeable on the generated corpus', () => {
  const rows = generatedEntries();
  assert.ok(rows.length > 100, 'corpus built');

  let gained = 0;
  for (const entry of rows) {
    gained += weightedWordCount(entry, WEIGHTED_FIELDS_EN)
      - weightedWordCount(entry, WEIGHTED_FIELDS_DE);
  }
  const mean = gained / rows.length;

  // The defect in one number. If a later edit merges the two lists back
  // into one, or points the generated side at the German names again,
  // this drops to zero and the test says so.
  assert.ok(mean > 10,
    `the English fields must carry substantially more of a generated entry than the German ones do; measured ${mean.toFixed(2)} words`);
});

test('every content field the generator writes is one this house ranks on', () => {
  const rows = generatedEntries();
  // `id` and `ts` are bookkeeping, not content: search does not rank
  // them and they carry no words anyone would ask with.
  const bookkeeping = new Set(['id', 'ts', 'v']);
  const seen = new Set();
  for (const entry of rows) for (const key of Object.keys(entry)) seen.add(key);

  const unrankable = [...seen]
    .filter((k) => !bookkeeping.has(k) && !WEIGHTED_FIELDS_EN.includes(k));
  // A field the generator fills but search cannot rank is content that
  // exists and is unreachable — the corpus would then be modelling a
  // defect it never meant to model, and every recall number taken
  // against it would be pessimistic for a reason nobody wrote down.
  assert.deepEqual(unrankable, [],
    'the generated corpus writes a field the search does not weight');
});

test('the German mirror still matches what lucky-mem actually ranks on', (t) => {
  const suche = '/home/user/lucky-mem/src/suche.mjs';
  if (!fs.existsSync(suche)) {
    // Third state, not a pass: on a machine without the sister checkout
    // this question cannot be answered, and answering it green anyway
    // is the class of defect this whole file is about.
    t.skip('lucky-mem is not present in this environment; the mirror cannot be checked here');
    return;
  }
  const src = fs.readFileSync(suche, 'utf8');
  const start = src.indexOf('FELDGEWICHT = Object.freeze({');
  assert.ok(start >= 0, 'the sister checkout still declares its field weights the way we parse them');
  const body = src.slice(start, src.indexOf('});', start));
  const keys = [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*):\s*[\d.]+\s*,/gmi)].map((m) => m[1]);

  assert.ok(keys.length > 0, 'at least one weighted field parsed out of the sister source');
  assert.deepEqual(
    [...WEIGHTED_FIELDS_DE].sort(), [...keys].sort(),
    'the German field list in phase-real.mjs has drifted from lucky-mem/src/suche.mjs',
  );
});
