// One vocabulary for the edges, one reader for provenance, and a
// withdrawn edge that stops holding.
//
// **Where this comes from.** The external audit of 2026-09-17 found
// three ways a real, written relation became invisible or refused to go
// away:
//
//   - `memory.LINK_KINDS` spells the relation `generalizes`; `net.mjs`
//     spelled it `generalises`. A valid edge through the public writer
//     produced zero edges in the net.
//   - Provenance is written in two shapes in this repo,
//     `origin.derived_from` and `provenance.derived_from`. `net.mjs`
//     read only the second.
//   - A `resolves` link retired as `discarded` went on closing its
//     question: retiring it marked the entry and changed nothing.
//
// The positive control the audit itself ran matters as much: a `causes`
// edge came out correctly. So the graph was not broken in general — one
// spelling, one shape and one state were.
//
// invariant: eine-regel-eine-stelle
// invariant: zwei-wahrheiten
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as net from '../src/net.mjs';
import * as memory from '../src/memory.mjs';
import * as question from '../src/question.mjs';
import * as config from '../src/config.mjs';

const away = (r) => fs.rmSync(r, { recursive: true, force: true });

test('POSITIVE: the edge the audit got right still works', () => {
  const k = net.linksOf({ id: 'edge2', kind: 'causes', from: 'error1', to: 'error2' });
  assert.equal(k.length, 1, 'even causes stopped producing an edge');
  assert.equal(k[0].kind, 'causes');
});

test('the net spells the relations the way the writer validates them', () => {
  // Not "generalizes is in the list" — the whole vocabulary, so the next
  // verb added to `memory.LINK_KINDS` cannot be forgotten here.
  for (const kind of Object.keys(memory.LINK_KINDS)) {
    assert.ok(net.LINK_KINDS.includes(kind),
      `the writer accepts '${kind}', the net does not know it`);
    const k = net.linksOf({ id: 'e', kind, from: 'a', to: 'b' });
    assert.equal(k.length, 1, `a valid '${kind}' edge produces no edge in the net`);
  }
  // And nothing in the net's list that the writer would refuse, other
  // than the structural field edges.
  const erfunden = net.LINK_KINDS
    .filter((k) => !net.FELD_KANTEN.includes(k) && !(k in memory.LINK_KINDS));
  assert.deepEqual(erfunden, [],
    `the net knows verbs the writer refuses: ${erfunden.join(', ')}`);
});

test('both shapes of written provenance become edges', () => {
  for (const e of [
    { id: 'lesson1', origin: { derived_from: ['error1'] } },
    { id: 'lesson1', provenance: { derived_from: ['error1'] } },
    { id: 'lesson1', provenance: { inferred_from: ['error1'] } },
  ]) {
    const k = net.linksOf(e);
    assert.deepEqual(k, [{ kind: 'derived_from', from: 'lesson1', to: 'error1' }],
      `this shape produced no edge: ${JSON.stringify(e)}`);
  }
  // Not "any structure counts as provenance" — the list is closed.
  assert.deepEqual(net.linksOf({ id: 'x', herkunft: { derived_from: ['y'] } }), [],
    'an unknown shape was read as provenance');
  // The same reader, not a second list: this is what keeps them equal.
  assert.deepEqual(memory.derivedFrom({ origin: { derived_from: ['a'] } }), ['a']);
  assert.deepEqual(memory.derivedFrom({ provenance: { derived_from: ['a'] } }), ['a']);
  // A duplicate across shapes is one reference, not two.
  assert.deepEqual(memory.derivedFrom({
    origin: { derived_from: ['a'] }, provenance: { derived_from: ['a', 'b'] },
  }), ['a', 'b']);
});

test('a discarded answer re-opens its question', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-kanten-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    config.writeConfig(root, config.DEFAULT_CONFIG);
    const ts = '2026-09-01T10:00:00Z';
    memory.logEntry(root, 'question', { id: 'question1', question: 'Where is quartz?', ts }, { project: 'alpha' });
    memory.logEntry(root, 'learning', { id: 'answer001', text: 'Quartz is here', ts }, { project: 'alpha' });
    memory.logEntry(root, 'link', { id: 'link00001', from: 'answer001', to: 'question1', kind: 'resolves', ts }, { project: 'alpha' });

    // Positive control first: while the edge stands, the question is closed.
    assert.equal(question.all(root)[0].open, false,
      'the resolves edge never closed the question — the probe below would prove nothing');

    memory.retireEntry(root, 'link', 'link00001', { state: 'discarded', project: 'alpha' });
    const q = question.all(root)[0];
    assert.equal(q.open, true, 'a withdrawn answer goes on closing the question');
    assert.deepEqual(q.answers, [], `the withdrawn answer is still listed: ${JSON.stringify(q.answers)}`);

    // And it is not gone from the record — asked for, it comes back.
    const mit = memory.linksOf(root, 'question1', { withRetired: true });
    assert.equal(mit.incoming.length, 1, 'the withdrawn edge is unrecoverable');
  } finally { away(root); }
});

test('the entry index is built once per listing, not once per question', () => {
  // A code finding, not a measured production latency: `question.all`
  // called `linksOf` per question and each call re-read the whole
  // memory. The probe measures the SHAPE (linksOf accepts a prebuilt
  // index and question.all passes one), because a timing assertion on a
  // small fixture would be noise.
  const src = fs.readFileSync(new URL('../src/question.mjs', import.meta.url), 'utf8');
  const ohneKommentare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  assert.match(ohneKommentare, /const byId = memory\.entriesById\(root\);/,
    'question.all no longer builds the index itself');
  assert.match(ohneKommentare, /memory\.linksOf\(root, e\.id, \{ byId \}\)/,
    'question.all stopped passing the index it built');
  // And the default still works without one, so no caller has to know.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-kanten2-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    config.writeConfig(root, config.DEFAULT_CONFIG);
    memory.logEntry(root, 'learning', { id: 'alleine', text: 'x', ts: '2026-09-01T10:00:00Z' });
    assert.deepEqual(memory.linksOf(root, 'alleine').out, []);
  } finally { away(root); }
});
