// test/dashboard-knowledge-types.test.mjs — D3: the knowledge view's
// type filter comes from ONE place, `memory.TYPES`, never from which
// types happen to appear in an entry list. English mirror of
// lucky-mem's own D3 latch for its knowledge view: plan D3, one truth
// for the type list.
//
// **The defect this replaces.** Before this task, `astra/knowledge.mjs`
// built its chip list with `[...new Set(d.entries.map(e => e.type))]` —
// derived from whichever types happened to have at least one entry. A
// type nobody has written to yet, or one whose every entry got retired
// away later, would then lose its chip SILENTLY: nothing on the page
// says "this type does not exist" apart from "this type is empty right
// now", and a person filtering by it could not tell the two apart.
//
// **The latch.** `dashboard.collect(root).types` must equal
// `Object.keys(memory.TYPES)` exactly — same members, same order —
// regardless of what is actually in the memory. `knowledgeView`'s own
// rendered chip list (its `data-type` attributes, minus the
// hand-written "all" chip, which is not a memory type) must equal that
// same set. Sabotaging either back to an entries-derived list — the
// regression this file exists to catch — is demonstrated directly
// below: the same fixture run through the OLD derivation rule produces
// a strictly smaller list than `memory.TYPES`, which is exactly the
// silent narrowing this task removes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as astra from '../src/astra.mjs';
import { knowledgeView } from '../src/astra/knowledge.mjs';

function empty() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-d3-types-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'd3', participants: ['someone'], language: 'en' }));
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

/** The chip types the page actually renders, minus the hand-written "all" one. */
function renderedChipTypes(html) {
  return [...html.matchAll(/class="chip" data-type="([^"]*)"/g)]
    .map((m) => m[1]).filter((t) => t !== '');
}

test('an EMPTY memory still carries every known type — nothing is derived from entries', () => {
  const r = empty();
  try {
    const d = dashboard.collect(r);
    assert.equal(d.entries.length, 0, 'this probe is vacuous if the fixture has entries');
    assert.deepEqual(d.types.map((t) => t.type), Object.keys(memory.TYPES),
      'an empty memory reported fewer types than memory.TYPES knows about');
    const { html } = astra.build(r, { title: 'd3' });
    assert.deepEqual(renderedChipTypes(html).sort(), Object.keys(memory.TYPES).sort(),
      'the rendered page is missing a chip for a type with zero entries');
  } finally { away(r); }
});

test('a memory with entries of only SOME types still shows a chip for every type', () => {
  // The direct sabotage check: populate fewer than half of memory.TYPES
  // and confirm the missing ones are not silently missing from the page.
  const r = empty();
  try {
    memory.logEntry(r, 'learning', { title: 'a learning', text: 'x' });
    memory.logEntry(r, 'decision', { choice: 'a decision', why: 'y' });
    const present = new Set(['learning', 'decision']);
    const missing = Object.keys(memory.TYPES).filter((t) => !present.has(t));
    assert.ok(missing.length > 0, 'fixture setup error: nothing is actually missing');

    const d = dashboard.collect(r);
    assert.deepEqual(d.types.map((t) => t.type), Object.keys(memory.TYPES));

    const { html } = astra.build(r, { title: 'd3' });
    const chips = new Set(renderedChipTypes(html));
    for (const t of missing) {
      assert.ok(chips.has(t), `type '${t}' has zero entries and lost its chip`);
    }
    assert.deepEqual([...chips].sort(), Object.keys(memory.TYPES).sort(),
      'the page renders a type outside memory.TYPES, or is missing one inside it');
  } finally { away(r); }
});

test('LATCH: the entries-derived rule this task removed would fail the same fixture', () => {
  // Not a hypothetical — literally the old expression from
  // `astra/knowledge.mjs` before D3, run against the same fixture, to
  // show what "removing a type" actually looked like before this latch
  // existed: a chip list strictly smaller than memory.TYPES, with no
  // signal that anything was left out.
  const r = empty();
  try {
    memory.logEntry(r, 'learning', { title: 'a learning', text: 'x' });
    memory.logEntry(r, 'decision', { choice: 'a decision', why: 'y' });
    const d = dashboard.collect(r);
    const oldDerivation = [...new Set(d.entries.map((e) => e.type))].sort();
    assert.ok(oldDerivation.length < Object.keys(memory.TYPES).length,
      'the old, entries-derived rule no longer under-counts on this fixture — '
        + 'the fixture needs a wider gap between "written" and "known" types');
    // And the CURRENT view does not repeat that mistake on the same data.
    assert.equal(knowledgeView(d).match(/class="chip" data-type="[a-z]/g).length,
      Object.keys(memory.TYPES).length);
  } finally { away(r); }
});

test('dashboard.collect().types carries the label memory.TYPES/viewer.TYPE_LABEL name, not a second guess', () => {
  const r = empty();
  try {
    const d = dashboard.collect(r);
    const byType = new Map(d.types.map((t) => [t.type, t.label]));
    assert.equal(byType.get('decision'), 'Decisions');
    assert.equal(byType.get('duty'), 'Duties');
    // Every type gets SOME label, even one with no entry in TYPE_LABEL
    // (the view falls back to the raw key rather than dropping it).
    for (const t of Object.keys(memory.TYPES)) {
      assert.ok(byType.get(t), `type '${t}' carries no label at all`);
    }
  } finally { away(r); }
});
