import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIndex, buildIndex, search } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inc-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  return r;
}
const ids = (hits) => hits.map((h) => h.entry.id);

test('an appended entry is findable without a rebuild', () => {
  const r = root();
  try {
    // Enough base entries that one more stays well under the rebuild
    // threshold — otherwise the append correctly turns into a rebuild
    // and the test measures the threshold rather than the append.
    for (let i = 0; i < 20; i += 1) {
      memory.logEntry(r, 'decision', { title: `chose postgres for service ${i}`, why: 'transactions' });
    }
    loadIndex(r, { language: 'en' });                       // full build, cache written
    const { entry: fresh } = memory.logEntry(r, 'error', { title: 'the kafka consumer stalled', text: 'rebalance loop' });

    const idx = loadIndex(r, { language: 'en' });
    assert.equal(idx.fromCache, true, 'this must not have been a rebuild');
    assert.equal(idx.appended, 1);
    assert.deepEqual(ids(search(idx, 'kafka consumer stalled', { top: 3 })), [fresh.id]);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the appended index matches a full rebuild, document for document', () => {
  // The whole risk of appending is drifting away from what a build would
  // have produced. This compares the two directly.
  const r = root();
  try {
    for (let i = 0; i < 30; i += 1) {
      memory.logEntry(r, 'decision', { title: `decision ${i} about the cache layer`, why: 'load' });
    }
    loadIndex(r, { language: 'en' });
    for (let i = 0; i < 12; i += 1) {
      memory.logEntry(r, 'error', { title: `outage ${i} in the payment path`, text: 'timeout' });
    }
    const inc = loadIndex(r, { language: 'en' });
    const full = buildIndex(r, { language: 'en' });

    assert.equal(inc.N, full.N, 'document count drifted');
    assert.ok(Math.abs(inc.avgLength - full.avgLength) < 1e-9, 'average length drifted');
    const key = (d) => `${d.source}:${d.line}`;
    assert.deepEqual(inc.documents.map(key).sort(), full.documents.map(key).sort());
    for (const t of ['outag', 'payment', 'cach']) {
      assert.equal(inc.docFreq.get(t) ?? 0, full.docFreq.get(t) ?? 0, `docFreq drifted for '${t}'`);
    }
    const q = 'outage in the payment path';
    assert.deepEqual(ids(search(inc, q, { top: 5 })), ids(search(full, q, { top: 5 })),
      'the appended index ranks differently than a rebuilt one');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('line numbers keep counting from the start of the file', () => {
  // The appended lines are read from a byte offset, so the line number
  // has to come from the stored count. Get this wrong and every
  // `source:line` the search prints points at the wrong line.
  const r = root();
  try {
    for (let i = 0; i < 5; i += 1) memory.logEntry(r, 'decision', { title: `early ${i}` });
    loadIndex(r, { language: 'en' });
    memory.logEntry(r, 'decision', { title: 'the appended one, on line six' });
    const idx = loadIndex(r, { language: 'en' });
    const hit = search(idx, 'appended one line six', { top: 1 })[0];
    assert.equal(hit.line, 6, 'the appended entry reports the wrong line number');
    assert.equal(hit.source, path.join('global', 'decisions.jsonl'));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a tombstone in the appended lines retires an already-indexed entry', () => {
  // The retired map is built from the WHOLE corpus on a build. When only
  // the tail is read, a tombstone would otherwise apply to nothing, and a
  // discarded entry would keep answering searches until the next rebuild.
  const r = root();
  try {
    const { entry: d } = memory.logEntry(r, 'decision', { title: 'use vendor X for hosting', choice: 'X' });
    for (let i = 0; i < 20; i += 1) memory.logEntry(r, 'event', { title: `unrelated ${i}` });
    loadIndex(r, { language: 'en' });
    assert.equal(search(loadIndex(r, { language: 'en' }), 'vendor X hosting', { top: 3 }).length, 1);

    memory.retireEntry(r, 'decision', d.id, { state: 'discarded', why: 'vendor X shut down' });
    const idx = loadIndex(r, { language: 'en' });
    assert.equal(idx.fromCache, true, 'this should still have been an append');
    assert.deepEqual(search(idx, 'vendor X hosting', { top: 3 }), [],
      'the retired entry is still answering searches');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a line inserted in the middle forces a full rebuild', () => {
  // This is the case that makes size-only tracking wrong, and it is not
  // hypothetical: `git pull --rebase` replays a local commit on top of a
  // remote one, so a line appears in the MIDDLE of a file that is only
  // ever appended to locally. Reading the tail by size alone would index
  // one line twice and miss another.
  const r = root();
  try {
    memory.logEntry(r, 'decision', { title: 'first, written locally' });
    memory.logEntry(r, 'decision', { title: 'second, written locally' });
    for (let i = 0; i < 20; i += 1) memory.logEntry(r, 'event', { title: `padding ${i}` });
    loadIndex(r, { language: 'en' });

    const p = path.join(r, 'global', 'decisions.jsonl');
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    const remote = JSON.stringify({ id: 'remote1', ts: '2026-09-05T00:00:00Z', title: 'from a colleague, rebased in' });
    fs.writeFileSync(p, `${[lines[0], remote, lines[1]].join('\n')}\n`);

    const idx = loadIndex(r, { language: 'en' });
    assert.equal(idx.fromCache, false, 'a rewritten prefix must force a rebuild, not an append');
    assert.equal(idx.N, 23);
    assert.equal(search(idx, 'colleague rebased', { top: 1 }).length, 1);
    // And the entry that moved must still report its NEW line.
    const moved = search(idx, 'second written locally', { top: 1 })[0];
    assert.equal(moved.line, 3);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a shrunk or deleted file forces a full rebuild', () => {
  const r = root();
  try {
    memory.logEntry(r, 'decision', { title: 'one' });
    memory.logEntry(r, 'decision', { title: 'two' });
    loadIndex(r, { language: 'en' });
    const p = path.join(r, 'global', 'decisions.jsonl');
    fs.writeFileSync(p, `${fs.readFileSync(p, 'utf8').trim().split('\n')[0]}\n`);
    const idx = loadIndex(r, { language: 'en' });
    assert.equal(idx.fromCache, false);
    assert.equal(idx.N, 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('nothing changed means nothing is appended and nothing is rebuilt', () => {
  const r = root();
  try {
    memory.logEntry(r, 'decision', { title: 'stable' });
    loadIndex(r, { language: 'en' });
    const idx = loadIndex(r, { language: 'en' });
    assert.equal(idx.fromCache, true);
    assert.equal(idx.appended, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('--fresh always rebuilds, whatever the cache says', () => {
  const r = root();
  try {
    memory.logEntry(r, 'decision', { title: 'one' });
    loadIndex(r, { language: 'en' });
    assert.equal(loadIndex(r, { fresh: true, language: 'en' }).fromCache, false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('enough new entries eventually force a real rebuild', () => {
  // Appending never recomputes the compound lexicon or the learned
  // graphs — those are corpus-wide statistics. The threshold is what
  // stops them drifting indefinitely.
  const r = root();
  try {
    for (let i = 0; i < 10; i += 1) memory.logEntry(r, 'decision', { title: `base ${i}` });
    loadIndex(r, { language: 'en' });
    let rebuilt = false;
    for (let i = 0; i < 10 && !rebuilt; i += 1) {
      memory.logEntry(r, 'event', { title: `later ${i}` });
      if (loadIndex(r, { language: 'en' }).fromCache === false) rebuilt = true;
    }
    assert.ok(rebuilt, 'the corpus doubled and the index was never rebuilt');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
