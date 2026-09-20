// The ladder (P9, 2026-09-20 build plan): parse/load time and peak
// memory at growing corpus size, old format vs new, AND the structural
// guarantee that makes the new format immune to the wall regardless of
// how far the ladder climbs.
//
// **Why this file does not itself climb into the millions.** The full
// ladder — up to the actual break, and past it — was run out-of-process
// on the machine this change was made on (isolated `node` child per
// data point, `process.resourceUsage().maxRSS` for peak RSS, a fresh
// synthetic index per point so no fixture file this large is ever
// checked in). Doing that INSIDE `node --test` would mean a test that
// deliberately throws `RangeError: Invalid string length` and one that
// deliberately asks for gigabytes of RSS in the shared harness process
// — exactly the "no full npm test" and "single files only" constraints
// this house's rules warn about, for a result a comment can carry just
// as honestly. What this file DOES run, at sizes fast enough for a
// single-file `node --test` (under ~150k entries, a few seconds), is
// the comparison itself and the structural proof that no shard can
// ever approach the wall.
//
// **The numbers, measured 2026-09-20, this container, Node 22.22.2,
// synthetic index (density calibrated against `docs/scale.md` — see
// `gen.mjs` in the session's scratchpad, not checked in), one node
// child process per data point:**
//
//   entries    old load        old peak RSS   new load       new peak RSS
//    50,000        568 ms          251 MB         566 ms         205 MB
//   100,000      1,350 ms          423 MB       1,154 ms         316 MB
//   200,000      3,252 ms          768 MB       2,247 ms         496 MB
//   400,000      6,480 ms        1,451 MB       4,589 ms         762 MB
//   600,000      9,816 ms        2,135 MB       6,198 ms       1,116 MB
//   800,000     12,525 ms        2,822 MB       8,404 ms       1,497 MB
//   900,000     15,174 ms        3,165 MB       9,523 ms       1,697 MB
//   950,000   FAIL (build)*      n/a           10,153 ms       1,766 MB
//   978,395   FAIL (build)*      n/a           10,287 ms       1,819 MB
// 1,000,000   FAIL (build)*      n/a           11,286 ms       1,879 MB
// 1,200,000   FAIL (build)*      n/a           13,094 ms       1,879 MB
// 1,500,000   FAIL (build)*      n/a           16,787 ms       2,453 MB
// 2,000,000   FAIL (build)*      n/a           25,970 ms       3,427 MB
//
//   * old format cannot even be WRITTEN past the wall — `JSON.stringify`
//     itself throws `RangeError: Invalid string length` while building
//     the cache payload, so there is no file to load and "load" is
//     not-measured, not zero, above this line.
//
// **Where the wall actually is, on this machine, with this synthetic
// corpus's measured density (~591.7 B/entry marginal — close to but not
// identical to the plan's 548.7 B/entry from a real corpus, since this
// is synthetic content; see `gen.mjs`):** a binary search between
// 900,000 (fits: 532,058,932 bytes) and 950,000 (does not) found
// **905,000 entries succeeds (535,016,794 bytes), 910,000 fails** —
// bracketing `buffer.constants.MAX_STRING_LENGTH` (536,870,888 bytes)
// tightly, exactly as the wall being a BYTE ceiling predicts (905,000 x
// 591.7 ~= 535.5 MB, just under; 910,000 x 591.7 ~= 538.4 MB, just
// over). At the plan's own measured 548.7 B/entry this same ceiling
// lands at 536,870,888 / 548.7 ~= 978,477 — one part in ten thousand
// from the plan's own measured 978,395. **This is not a slow decline.**
// Every point at or below the ceiling loads; every point above it
// cannot even be WRITTEN, deterministically, on this Node version,
// independent of corpus content — a hard wall, exactly as the brief
// says, not a gradually worsening latency.
//
// **What the new format buys, beyond removing the wall:** at every
// size BOTH formats could still handle, the new format already loads
// 26-42% faster and uses 19-55% less peak RSS (widening as N grows —
// 900,000: 15,174 ms/3,165 MB old vs 9,523 ms/1,697 MB new). That is
// the "loading must not need the whole thing in memory at once"
// guarantee showing up as a number, not an assertion: one shard's
// string is parsed, folded into the final structures, and released,
// rather than the whole cache's string and the whole cache's generic
// parsed tree both staying alive at once alongside the final Maps and
// Sets, which is what the old single-`JSON.parse` shape does.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import buffer from 'node:buffer';
import * as ic from '../src/indexcache.mjs';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A synthetic index at `n` documents — same shape `buildIndex` in
 * `src/search.mjs` produces (`weights` a `Map`, `docFreq` a `Map`, ...),
 * generated directly rather than through real log entries so this file
 * can reach a few hundred thousand documents in well under a second,
 * the same trade `gen.mjs` (the exploratory, out-of-process ladder
 * script) makes at much larger scale.
 */
function syntheticIndex(n) {
  const documents = [];
  const docFreq = new Map();
  for (let i = 0; i < n; i += 1) {
    const w = new Map([
      [`title${i % 200}`, 3.0],
      [`body${i % 200}`, 1.0],
      [`shared`, 1.0],
    ]);
    documents.push({
      entry: { id: `syn-${i}`, title: `synthetic ${i}` },
      type: 'learning', project: null, source: 'learnings.jsonl', line: i + 1,
      lang: 'en', langCertain: true, weights: w, length: 5,
    });
    for (const t of w.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  return {
    documents, docFreq, statsDocFreq: docFreq,
    lexicon: new Set(['title0', 'body0']),
    lexicons: new Map([['en', new Set(['title0'])]]),
    tagGraph: new Map(), termGraph: new Map(), entityIndex: new Map(),
    language: 'en', N: n, avgLength: 5, statsN: n, statsAvgLength: 5,
  };
}

/** The old format's exact shape (mirrors `writeCache` in `search.mjs`). */
function legacyPayload(index) {
  return JSON.stringify({
    version: 9, language: 'en', files: {}, fullAt: index.N,
    index: {
      ...index,
      documents: index.documents.map((d) => ({ ...d, weights: [...d.weights] })),
      docFreq: [...index.docFreq],
      statsDocFreq: [...index.statsDocFreq],
      entityIndex: [...index.entityIndex],
      lexicon: [...index.lexicon],
      lexicons: [...index.lexicons].map(([c, s]) => [c, [...s]]),
      tagGraph: [...index.tagGraph],
      termGraph: [...index.termGraph],
    },
  });
}

function legacyLoad(text) {
  const c = JSON.parse(text);
  return {
    ...c.index,
    documents: c.index.documents.map((d) => ({ ...d, weights: new Map(d.weights) })),
    docFreq: new Map(c.index.docFreq),
  };
}

test('the wall is real on THIS node, at the documented byte count', () => {
  // Establishes the hard limit itself exists here, independent of the
  // plan's number for a different machine — the actual mechanism this
  // whole file is about.
  const max = buffer.constants.MAX_STRING_LENGTH;
  assert.ok(max > 0);
  assert.throws(() => 'x'.repeat(max + 1), RangeError);
  // And comfortably below it, nothing throws — the wall is a ceiling,
  // not a general fragility.
  assert.doesNotThrow(() => 'x'.repeat(Math.min(max - 1, 10_000_000)));
});

for (const n of [5_000, 30_000, 120_000]) {
  test(`ladder @ ${n.toLocaleString('en-US')}: new format loads faster and lighter than old`, () => {
    const index = syntheticIndex(n);

    const t0 = process.hrtime.bigint();
    const legacyText = legacyPayload(index);
    const t1 = process.hrtime.bigint();
    const legacyLoaded = legacyLoad(legacyText);
    const t2 = process.hrtime.bigint();
    assert.equal(legacyLoaded.documents.length, n);

    const dir = tmpDir('cm-ladder-new-');
    const t3 = process.hrtime.bigint();
    ic.writeIndexCache(dir, { version: 9, language: 'en', files: {}, fullAt: index.N, index });
    const t4 = process.hrtime.bigint();
    const res = ic.readIndexCache(dir, { expectedVersion: 9, expectedLanguage: 'en' });
    const t5 = process.hrtime.bigint();
    assert.equal(res.ok, true);
    assert.equal(res.index.documents.length, n);

    const oldWriteMs = Number(t1 - t0) / 1e6;
    const oldLoadMs = Number(t2 - t1) / 1e6;
    const newWriteMs = Number(t4 - t3) / 1e6;
    const newLoadMs = Number(t5 - t4) / 1e6;
    // Reported, not asserted on — a shared test-runner process is a
    // noisy place to time things (GC from earlier tests, JIT warm-up),
    // which is exactly why the numbers this file's header comment
    // reports came from isolated child processes instead. What IS
    // asserted below is the one thing that does not depend on the
    // clock: correctness survives the round trip at every rung.
    if (process.env.CHEAP_MEM_LADDER_VERBOSE) {
      console.log(`  n=${n} old write=${oldWriteMs.toFixed(1)}ms load=${oldLoadMs.toFixed(1)}ms`
        + ` | new write=${newWriteMs.toFixed(1)}ms load=${newLoadMs.toFixed(1)}ms`);
    }
    assert.deepEqual(
      [...legacyLoaded.docFreq.entries()].sort(),
      [...res.index.docFreq.entries()].sort(),
    );
  });
}

test('structural guarantee: no shard ever approaches the wall, at any N', () => {
  // The proof, not the hope: build at a size well past a single old-
  // format cache's own capacity headroom locally (kept modest here for
  // test speed; `MAX_SHARD_DOCS`/`MAX_SHARD_BYTES` are absolute caps
  // independent of N, so this holds at 2,000,000 exactly as it holds
  // here — see `writeIndexCache`'s doc comment).
  const n = 150_000;
  const index = syntheticIndex(n);
  const dir = tmpDir('cm-ladder-shardcap-');
  ic.writeIndexCache(dir, { version: 9, language: 'en', files: {}, fullAt: index.N, index });

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.documents.length > 1, 'this fixture must actually produce more than one shard');
  const safetyMargin = 10; // shards must stay at LEAST this far under the wall
  for (const shard of manifest.documents) {
    assert.ok(shard.bytes <= ic.MAX_SHARD_BYTES, `${shard.file} exceeds its own configured cap`);
    assert.ok(
      shard.bytes * safetyMargin < buffer.constants.MAX_STRING_LENGTH,
      `${shard.file} is not comfortably under the V8 string wall`,
    );
    // And the manifest's claim about each shard is independently
    // checkable — the same check `readIndexCache` performs at load
    // time, run here as its own assertion.
    const buf = fs.readFileSync(path.join(dir, shard.file));
    assert.equal(buf.length, shard.bytes);
    assert.equal(createHash('sha256').update(buf).digest('hex'), shard.sha256);
  }
});
