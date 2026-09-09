// The agent path must not be worse than the human path.
//
// Finding from 2026-09-06: `search()` has `mmr: false` as its default.
// `bin/mem find` turns the diversity re-ranking on, `src/retrieval.mjs`
// did not — so `mem retrieve` and the MCP tool `mem_retrieve`, the ones
// an agent uses, got plain BM25 order. Near-identical entries on one
// topic fill the hit list, and the answer to the actual question sits
// underneath them.
//
// Measured on the eval corpus (189 documents, 18 tasks with known
// gold): the wanted claim was in the top 5 for 7 of 18 tasks without
// MMR and for 9 of 18 with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';

// Large enough that idf means something. A first version of this test
// used 13 documents — there the shared word sits in 12 of them, carries
// almost no weight, and the duplicates never reached the hit list. The
// test would then have measured the size of the corpus, not the code.
function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-div-'));
  fs.mkdirSync(path.join(r, 'projects', 'p'), { recursive: true });
  const log = (d) => memory.logEntry(r, 'decision', { ...d, author: 'lucky', authority: 'user', project: 'p' }, { project: 'p' });

  // 15 near-identical entries that match the question lexically.
  for (let i = 0; i < 15; i += 1) {
    log({ id: `DUP-${i}`, topic: 'pakete',
      choice: `Abhaengigkeiten im Repository nachvollziehbar festnageln, Runde ${i}`,
      why: 'das Bild des Laufwerks driftete zweimal in einem Monat und kostete jedes Mal einen halben Tag Arbeit',
      tags: ['pakete'] });
  }
  // 24 unrelated entries, so the corpus is not made of two topics.
  const rest = ['protokollierung', 'tests', 'suchfeld', 'rechte', 'bilder', 'benachrichtigung', 'zeitplan', 'fehlerbilder'];
  rest.forEach((topic, k) => {
    for (let i = 0; i < 3; i += 1) {
      log({ id: `X-${topic}-${i}`, topic,
        choice: `zu ${topic} gilt Fassung ${i}`,
        why: `entschieden bei Vorgang ${500 + k * 10 + i}, und seitdem unveraendert geblieben`,
        tags: [topic] });
    }
  });
  // Exactly ONE entry answers the question, under a different topic.
  log({ id: 'ANTWORT', topic: 'ablage',
    choice: 'Dateien im Repository statt einer externen Datenbank',
    why: 'ein Dienst, den niemand wartet, ist teurer als eine Datei, und die Ablage bleibt nachvollziehbar',
    tags: ['ablage'] });
  return r;
}

const QUESTION = 'Wie halten wir die Ablage im Repository nachvollziehbar?';

test('the gateway default is the same one `mem find` uses', () => {
  // The finding was not a ranking problem but a DIVERGENCE: two
  // retrieval paths with different defaults, and the agent path had the
  // worse one. That is what gets pinned here — not through a behavioural
  // symptom that depends on the fixture, but directly.
  //
  // A first version of this test checked whether near-duplicates fill
  // the hit list. It was green with the OLD default too and would not
  // have caught the regression.
  const r = build();
  try {
    const byDefault = retrieve(r, QUESTION, grantProject('p'), { top: 5 });
    const withMmr = retrieve(r, QUESTION, grantProject('p'), { top: 5, mmr: true });
    const withoutMmr = retrieve(r, QUESTION, grantProject('p'), { top: 5, mmr: false });
    const ids = (x) => x.claims.map((c) => c.id);
    assert.deepEqual(ids(byDefault), ids(withMmr),
      'the default does not match `mem find` (mmr on)');
    assert.notDeepEqual(ids(withoutMmr), ids(withMmr),
      'on this fixture MMR changes nothing — then the comparison above proves nothing');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('MMR changes the SELECTION, and without it the selection is flatter', () => {
  // Without this comparison the test above could also be green if MMR
  // does nothing at all and BM25 happens to answer diversely already.
  const r = build();
  try {
    const without = retrieve(r, QUESTION, grantProject('p'), { top: 5, mmr: false });
    const with_ = retrieve(r, QUESTION, grantProject('p'), { top: 5, mmr: true });
    const topics = (x) => new Set(x.claims.map((c) => c.topic)).size;
    assert.ok(topics(with_) >= topics(without),
      `MMR makes diversity worse: without ${topics(without)} topics, with ${topics(with_)}`);
    assert.notDeepEqual(without.claims.map((c) => c.id), with_.claims.map((c) => c.id),
      'MMR does not change the selection — then the fixture is inert and the test has no teeth');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
