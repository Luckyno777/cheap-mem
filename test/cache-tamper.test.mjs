// The search cache may decide what is FAST to find. Never what is TRUE.
//
// **Why this exists.** `loadIndex` serves `.mem/search-index.json` when
// the log files on disk have not moved since it was written. That check
// compares BYTES of the logs — it never looks at the documents the cache
// is carrying. So an edit made inside the cache file itself, leaving
// every log untouched, was invisible: `appendToIndex` compares
// `before[rel].bytes` against `now`, sees no change, and hands the
// cached `documents` array straight to `search()`.
//
// Two edits of that kind were found on 2026-09-19, and both are real
// losses rather than curiosities — the cache is a plain file in a
// directory a memory's own agents write to:
//
//   A  cut one document out and shrink `index.N` to match. The entry is
//      still in the log, `mem find` reports one fewer entry and zero
//      hits for its own anchor text, and nothing anywhere says so.
//   B  delete the `retired` field from a cached document. A retired
//      entry comes back as live in the ranked lane. (`mem retrieve`
//      never had this hole: retrieval.mjs asks `state.deriveState`,
//      which reads the log, every call.)
//
// Each is pinned here together with the control that gives it meaning:
// the same tamper against the code WITHOUT the guard has to produce the
// loss, or a green test proves only that the experiment was too weak.
// Rather than editing src to run that control, each control drives the
// same tamper one step further, into the shape the guard provably
// cannot see — which is both the proof that the guard is load-bearing
// and an honest statement of where it stops.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

/** A memory with `n` learnings, each carrying its own unique anchor word. */
function seeded(n = 6) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-tamper-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user', 'agent'], language: 'en' }));
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const e = memory.logEntry(root, 'learning', {
      title: `entry ${i} tamperanchor${i}`,
      text: `body of entry ${i} tamperanchor${i} written for this probe`,
    });
    ids.push(e.entry.id);
  }
  return { root, ids };
}

const cachePath = (root) => path.join(root, search.CACHE_FILE);
const readCache = (root) => JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
const writeCache = (root, c) => fs.writeFileSync(cachePath(root), JSON.stringify(c));

/** How many documents does a fresh ranked search find for this word? */
function hits(root, word, opt = {}) {
  const index = search.loadIndex(root);
  return search.search(index, word, { top: 10, ...opt }).length;
}

/** Which source file a document came from, and where it sits in the array. */
function findDoc(cache, word) {
  return cache.index.documents.findIndex((d) => JSON.stringify(d).includes(word));
}

test('A the cache cannot lose a document while the log still holds it', () => {
  const { root } = seeded();
  search.loadIndex(root, { fresh: true });

  // Positive control for the probe itself: the anchor is findable
  // before anything is touched. Without this, "found after the tamper"
  // could mean the word was never findable and the probe measures air.
  assert.equal(hits(root, 'tamperanchor3'), 1, 'anchor not findable before the tamper');

  const c = readCache(root);
  const i = findDoc(c, 'tamperanchor3');
  assert.ok(i >= 0, 'the cache does not carry the document this probe edits');
  c.index.documents.splice(i, 1);
  c.index.N -= 1;                       // internally consistent, and a lie
  writeCache(root, c);

  assert.equal(hits(root, 'tamperanchor3'), 1,
    'a document cut from the cache stayed cut — the log says otherwise');
});

test('A the guard is what catches it: the same tamper with the counts fixed is NOT caught', () => {
  // The control. `docCountsMatch` compares the documents the cache
  // carries against the per-file `docs` count the cache itself records.
  // Repair that count as well and the two halves agree with each other
  // again — the cache is then internally consistent and merely wrong,
  // and nothing short of re-reading the log could tell.
  //
  // This is deliberately a statement of the guard's LIMIT, not a
  // decoration: it fails the moment the cut document reappears, which
  // is what would happen if the guard had been strengthened to read the
  // log — at which point this test is the one that must be rewritten,
  // and its `docs` bookkeeping is the thing to delete.
  const { root } = seeded();
  search.loadIndex(root, { fresh: true });
  assert.equal(hits(root, 'tamperanchor4'), 1);

  const c = readCache(root);
  const i = findDoc(c, 'tamperanchor4');
  const rel = c.index.documents[i].source;
  assert.ok(rel, 'document carries no source — the control cannot fix the count');
  c.index.documents.splice(i, 1);
  c.index.N -= 1;
  c.files[rel].docs -= 1;               // the half the guard reads
  writeCache(root, c);

  assert.equal(hits(root, 'tamperanchor4'), 0,
    'the fully consistent tamper was caught — the guard now reads more than its own bookkeeping, '
    + 'and this control has outlived its purpose');
});

test('B a retired entry cannot be revived by editing the cache', () => {
  const { root, ids } = seeded();
  // Retired through the same call `mem done` makes, so the tombstone has
  // the shape the real one has — and carries no title or text, which
  // also keeps it from matching the anchor and being counted as the
  // revived entry itself.
  memory.retireEntry(root, 'learning', ids[2], { state: 'done', why: 'probe' });
  search.loadIndex(root, { fresh: true });

  // Positive control: it really is hidden before the tamper.
  assert.equal(hits(root, 'tamperanchor2'), 0, 'the entry was not retired to begin with');

  const c = readCache(root);
  let stripped = 0;
  for (const d of c.index.documents) {
    if (JSON.stringify(d).includes('tamperanchor2') && d.retired) { delete d.retired; stripped += 1; }
  }
  assert.ok(stripped > 0, 'no cached document carried `retired` — the probe edited nothing');
  writeCache(root, c);

  assert.equal(hits(root, 'tamperanchor2'), 0,
    'stripping `retired` from the cache brought a retired entry back into the ranked lane');
});

test('B the other direction too: a forged `retired` cannot hide a live entry', () => {
  // The same reconciliation, measured from the opposite side. A guard
  // that only ever ADDS retirement would let the cheaper attack through:
  // mark a live entry retired and it disappears from every ranked
  // search while the log still holds it, active.
  const { root } = seeded();
  search.loadIndex(root, { fresh: true });
  assert.equal(hits(root, 'tamperanchor1'), 1);

  const c = readCache(root);
  const i = findDoc(c, 'tamperanchor1');
  c.index.documents[i].retired = { state: 'done', why: 'forged', by: null, ts: null };
  writeCache(root, c);

  assert.equal(hits(root, 'tamperanchor1'), 1,
    'a forged `retired` in the cache hid an entry the log still calls active');
});

test('the cache version moved, so no cache written before these guards is trusted', () => {
  // `docs` is new per-file bookkeeping. An older cache does not carry
  // it, `docCountsMatch` would read every count as 0, and every load
  // would throw its way into a full rebuild — correct, but silently
  // expensive forever. The version bump is what turns that into one
  // rebuild instead of one per call.
  assert.ok(search.CACHE_VERSION >= 8,
    'CACHE_VERSION was not raised for the `docs` field the guard depends on');
  const { root } = seeded(3);
  search.loadIndex(root, { fresh: true });
  const c = readCache(root);
  assert.equal(c.version, search.CACHE_VERSION);
  for (const [rel, info] of Object.entries(c.files)) {
    assert.equal(typeof info.docs, 'number', `${rel} carries no docs count`);
  }
  const total = Object.values(c.files).reduce((a, f) => a + f.docs, 0);
  assert.equal(total, c.index.documents.length,
    'the per-file docs counts do not add up to the documents the cache holds');
});
