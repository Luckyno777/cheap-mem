// test/statequestion.test.mjs — M9 parity with lucky-mem's freshness for
// state questions (src/statequestion.mjs, wired into `search()`).
//
// The fixture: two decisions share a topic, the OLDER one carries more
// of the query's terms and therefore outscores the newer one on plain
// relevance. PROBE: a question with a state signal word ("current",
// "status", ...) flips the order to the newer entry; the SAME question
// without a signal word — the control — does not, proving the probe
// actually distinguishes triggered from untriggered rather than always
// passing. Red on the tree before this file's module existed (verified
// by hand against `git show HEAD:src/search.mjs` while building this
// test: the old `search()` ranked the older entry first regardless of
// the query's wording).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { loadIndex, search } from '../src/search.mjs';
import * as sq from '../src/statequestion.mjs';

function memoryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-statequestion-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ version: 1, language: 'en', participants: { user: 'u' } }));
  return root;
}

const FIXED_NOW = Date.parse('2026-09-27T00:00:00Z');

function sameTopicFixture(root) {
  memory.logEntry(root, 'decision', {
    id: 'dold00000001', topic: 'infra/db',
    title: 'database database database migrated', choice: 'postgres', why: 'x',
  }, { now: new Date('2026-01-01T00:00:00Z') });
  memory.logEntry(root, 'decision', {
    id: 'dnew00000001', topic: 'infra/db',
    title: 'database migrated to mysql', choice: 'mysql', why: 'y',
  }, { now: new Date('2026-06-01T00:00:00Z') });
}

test('PROBE: a state question dampens the older same-topic hit; a plain one does not', () => {
  const root = memoryRoot();
  try {
    sameTopicFixture(root);
    const idx = loadIndex(root, { fresh: true });

    const control = search(idx, 'database migrated', { top: 5, now: FIXED_NOW });
    assert.equal(control[0].entry.id, 'dold00000001',
      'control: the older entry wins on plain relevance (more of the query repeated)');

    const probe = search(idx, 'what is the current database migrated status', { top: 5, now: FIXED_NOW });
    assert.equal(probe[0].entry.id, 'dnew00000001',
      'a state signal word dampens the older same-topic hit, so the newer one now leads');

    // Isolate the damping factor from coverage/recency: same query text,
    // damping switched off, so the only difference left is the factor
    // itself — comparing against `control` above would also be
    // comparing two DIFFERENT queries' coverage terms.
    const probeOff = search(idx, 'what is the current database migrated status', {
      top: 5, now: FIXED_NOW, stateWords: null,
    });
    const older = probe.find((h) => h.entry.id === 'dold00000001');
    const newer = probe.find((h) => h.entry.id === 'dnew00000001');
    const olderUndamped = probeOff.find((h) => h.entry.id === 'dold00000001');
    const newerUndamped = probeOff.find((h) => h.entry.id === 'dnew00000001');
    assert.ok(Math.abs(older.score - olderUndamped.score * sq.DAMPEN_FACTOR) < 1e-9,
      'the older hit is scaled by exactly DAMPEN_FACTOR, nothing more');
    assert.ok(Math.abs(newer.score - newerUndamped.score) < 1e-9,
      'the newest of the topic keeps full strength, untouched by the factor');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stateWords: null switches the mechanism off for one call', () => {
  const root = memoryRoot();
  try {
    sameTopicFixture(root);
    const idx = loadIndex(root, { fresh: true });
    const off = search(idx, 'what is the current database migrated status', {
      top: 5, now: FIXED_NOW, stateWords: null,
    });
    assert.equal(off[0].entry.id, 'dold00000001', 'switched off, plain relevance decides again');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('entries without a readable ts are never treated as older or younger', () => {
  const root = memoryRoot();
  try {
    memory.logEntry(root, 'decision', {
      id: 'dold00000001', topic: 'infra/db',
      title: 'database database database migrated', choice: 'postgres', why: 'x',
    }, { now: new Date('2026-01-01T00:00:00Z') });
    memory.logEntry(root, 'decision', {
      id: 'dnts00000001', topic: 'infra/db',
      title: 'database migrated to mysql', choice: 'mysql', why: 'y',
    }, { now: new Date('2026-06-01T00:00:00Z') });
    const idx = loadIndex(root, { fresh: true });
    // Strip the timestamp off the newer document the way an entry with
    // no readable `ts` would look — it must NOT become the anchor, and
    // it must not dampen the other one either.
    const untimed = idx.documents.find((d) => d.entry?.id === 'dnts00000001');
    untimed.entry = { ...untimed.entry, ts: 'not-a-date' };
    const probe = search(idx, 'what is the current database migrated status', { top: 5, now: FIXED_NOW });
    const old = probe.find((h) => h.entry.id === 'dold00000001');
    const undamped = search(idx, 'what is the current database migrated status', {
      top: 5, now: FIXED_NOW, stateWords: null,
    }).find((h) => h.entry.id === 'dold00000001');
    assert.ok(Math.abs(old.score - undamped.score) < 1e-9,
      'the only entry with a readable ts has no partner to compare against — untouched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- statequestion.mjs on its own -------------------------------------

test('loadWords: the shipped English defaults recognise the spec examples', () => {
  const m = sq.loadWords();
  for (const w of ['current', 'now', 'still', 'currently', 'latest', 'status']) {
    assert.ok(sq.isStateQuestion(`what is the ${w} state`, m), `'${w}' should trigger`);
  }
  assert.ok(!sq.isStateQuestion('why did we choose postgres', m), 'an ordinary question does not trigger');
});

test('loadWords: a custom file overrides the defaults, and a broken one fails loudly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-statewords-'));
  try {
    const custom = path.join(dir, 'words.json');
    fs.writeFileSync(custom, JSON.stringify({ words: ['todavía'] }));
    const m = sq.loadWords(custom);
    assert.ok(sq.isStateQuestion('¿todavía usamos postgres?', m));
    assert.ok(!sq.isStateQuestion('current status', m), 'the English default is gone once overridden');

    fs.writeFileSync(custom, '{ not json');
    assert.throws(() => sq.loadWords(custom), /not valid JSON/);

    fs.writeFileSync(custom, JSON.stringify({ notWords: [] }));
    assert.throws(() => sq.loadWords(custom), /'words' array/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveWordsPath: env wins over config, both absent means the shipped defaults', () => {
  const root = memoryRoot();
  try {
    assert.equal(sq.resolveWordsPath(root, { env: {} }), null);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mem', 'config.json'), 'utf8'));
    fs.writeFileSync(path.join(root, '.mem', 'config.json'),
      JSON.stringify({ ...cfg, stateSignalWords: 'my-words.json' }));
    assert.equal(sq.resolveWordsPath(root, { env: {} }), path.resolve(root, 'my-words.json'));
    assert.equal(
      sq.resolveWordsPath(root, { env: { CHEAP_MEM_STATE_SIGNAL_WORDS: '/elsewhere/words.json' } }),
      path.resolve('/elsewhere/words.json'),
      'the env var wins over the config key',
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applyTopicFreshness: a topic of one hit has nothing to compare against', () => {
  const hits = [{ score: 1, entry: { topic: 'lonely', ts: '2026-01-01T00:00:00Z' } }];
  sq.applyTopicFreshness(hits);
  assert.equal(hits[0].score, 1);
});

test('applyTopicFreshness: hits without a topic are left alone', () => {
  const hits = [
    { score: 1, entry: { ts: '2026-01-01T00:00:00Z' } },
    { score: 2, entry: { ts: '2026-06-01T00:00:00Z' } },
  ];
  sq.applyTopicFreshness(hits);
  assert.deepEqual(hits.map((h) => h.score), [1, 2]);
});

test('applyTopicFreshness: a tie at the newest timestamp keeps both at full strength', () => {
  const hits = [
    { score: 1, entry: { topic: 't', ts: '2026-06-01T00:00:00Z' } },
    { score: 2, entry: { topic: 't', ts: '2026-06-01T00:00:00Z' } },
    { score: 3, entry: { topic: 't', ts: '2025-01-01T00:00:00Z' } },
  ];
  sq.applyTopicFreshness(hits);
  assert.deepEqual(hits.map((h) => h.score), [1, 2, 3 * sq.DAMPEN_FACTOR]);
});

test('applyTopicFreshness: never mutates hits of a DIFFERENT topic', () => {
  const hits = [
    { score: 1, entry: { topic: 'a', ts: '2020-01-01T00:00:00Z' } },
    { score: 1, entry: { topic: 'b', ts: '2026-01-01T00:00:00Z' } },
  ];
  sq.applyTopicFreshness(hits);
  assert.deepEqual(hits.map((h) => h.score), [1, 1], 'one entry per topic here — nothing to dampen');
});
