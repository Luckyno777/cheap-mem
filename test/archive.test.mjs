// The raw capture no longer lives in the repository.
//
// **Why (2026-09-08.)** Reported from a Windows install: 9.17 MB of git
// pack in 75 minutes, ~50 MB per working day extrapolated, and git
// deletes nothing. Three compression routes were measured first, on
// real captures, and all three were single-digit: word codes 6.8%, a
// shared gzip dictionary 1.9%, exact duplicate lines 0.4%. After gzip
// there is nothing left to squeeze, so what remains is: put it
// somewhere else.
//
// **Why an expiry date alone would not have done it:** a removed file
// is gone from the working tree and still in the pack. The move stops
// the GROWTH; it reclaims nothing. `archive.mjs` says that in its
// header and the migrate command says it out loud, so nobody believes
// the megabytes vanished after a `git rm`.
//
// The tests below are built around the mistakes this rebuild is likely
// to make, not around the functions it adds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as archive from '../src/archive.mjs';
import * as raw from '../src/raw.mjs';
import * as search from '../src/search.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-archive-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  return r;
}

function transcript(dir, word = 'zeppelinhall', n = 60, name = 'transcript.jsonl') {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: `2026-09-08T1${i % 10}:00:00Z`,
      message: { content: [{ type: 'text', text: `line ${i} about the ${word} and what happened there` }] },
    }));
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('a capture lands in the archive and NOT in the repository', () => {
  const r = root();
  const e = raw.capture(r, transcript(r), { minBytes: 50 });
  assert.equal(e.status, 'captured');

  const store = archive.readConfig(process.env, r);
  assert.ok(fs.existsSync(path.join(store.location, archive.pathInArchive(e.path))),
    'not in the archive');
  assert.equal(fs.existsSync(path.join(r, e.path)), false,
    'in the repository anyway — then the whole rebuild was pointless');
});

test('the record stays in the repo: one line instead of a megabyte', () => {
  const r = root();
  const e = raw.capture(r, transcript(r), { minBytes: 50 });
  const rows = archive.records(r);
  assert.equal(rows.length, 1);

  const rec = rows[0];
  assert.equal(rec.path, e.path);
  assert.equal(rec.sha256, e.sha256);
  assert.ok(rec.bytes > 0);
  assert.ok(rec.lines > 0);
  // It has to answer, without the archive: did this exist, when, how big.
  assert.ok(rec.ts_to || rec.captured_at);

  const size = fs.statSync(path.join(r, archive.RECORD_FILE)).size;
  assert.ok(size < 2000, `the record is ${size} bytes — that is not a record any more`);
});

test('the search finds the capture although it is not in the repo', () => {
  const r = root();
  raw.capture(r, transcript(r, 'zeppelinhall'), { minBytes: 50 });
  const hits = search.search(search.buildIndex(r), 'zeppelinhall', { top: 5, minScore: 0 });
  assert.ok(hits.length > 0,
    'the capture dropped out of the search — exactly the outage a move produces');
});

test('the index CACHE notices a new capture in the archive', () => {
  // **Why this is separate from the test above.** That one exercises
  // `buildIndex`, and `buildIndex` reads through `listCaptures` /
  // `readCapture`, both already archive-aware. It stayed GREEN when the
  // archive resolution in the search module was deliberately destroyed.
  // A test that survives sabotage is testing nothing.
  //
  // The door that actually broke is another one: `loadIndex` decides via
  // `statSync` and a tail hash whether its cache still holds. Both went
  // through `path.join(root, rel)` — after the move each failed, with
  // `continue` and no message. The cache would never have gone stale,
  // new captures would never have appeared, and the search would have
  // quietly served yesterday.
  const r = root();
  raw.capture(r, transcript(r, 'zeppelinhall'), { minBytes: 50 });
  const a = search.loadIndex(r);
  assert.ok(search.search(a, 'zeppelinhall', { top: 5, minScore: 0 }).length > 0);

  // A SECOND transcript file, not the same one rewritten. Two sessions
  // are two files, and the first version of this test only passed by
  // accident: it reused one path, so whether the capture happened at
  // all depended on whether the new word was shorter than the old one.
  raw.capture(r, transcript(r, 'trombonechoir', 60, 'second.jsonl'), { minBytes: 50 });
  const b = search.loadIndex(r);
  assert.ok(search.search(b, 'trombonechoir', { top: 5, minScore: 0 }).length > 0,
    'the second capture stayed behind the cache — the search serves yesterday');
});

test('NO FALLBACK: an unwritable archive makes the capture fail', () => {
  // The comfortable path would be "then back into raw/". That would undo
  // the whole rebuild, and nobody would notice, because it looks exactly
  // like before.
  const r = root();
  const t = transcript(r);
  const blocked = path.join(r, 'blocked');
  fs.writeFileSync(blocked, 'I am a file, not a directory');

  const before = process.env.CHEAP_MEM_ARCHIVE;
  process.env.CHEAP_MEM_ARCHIVE = blocked;
  try {
    const e = raw.capture(r, t, { minBytes: 50 });
    assert.equal(e.status, 'broken');
    assert.equal(e.reason, 'archive-not-writable');
    assert.equal(fs.existsSync(path.join(r, 'raw')), false,
      'quietly fell back into the repository');
    assert.equal(archive.records(r).length, 0,
      'a record pointing at a capture that does not exist');
  } finally {
    if (before === undefined) delete process.env.CHEAP_MEM_ARCHIVE;
    else process.env.CHEAP_MEM_ARCHIVE = before;
  }
});

test('UNREACHABLE is not EMPTY', () => {
  // When the NAS is off, that has to arrive as an error. If readCapture
  // returned an empty result here, an unmounted drive would look exactly
  // like an empty memory — the most expensive mistake this project knows.
  const r = root();
  const e = raw.capture(r, transcript(r), { minBytes: 50 });
  const store = archive.readConfig(process.env, r);
  fs.rmSync(path.join(store.location, archive.pathInArchive(e.path)));

  assert.throws(() => raw.readCapture(r, e.path), (err) => {
    assert.equal(err.code, 'ARCHIVE_UNREACHABLE');
    assert.ok(err.message.includes(e.path));
    return true;
  });
  // The record still lists it — that is the statement "this DID exist".
  assert.equal(archive.records(r).length, 1);
});

test('the identifier does NOT change during the move', () => {
  // The digest ledger and every stored citation hang off the identifier.
  // If it changes, the entire existing corpus points at nothing.
  assert.equal(archive.pathInArchive('raw/2026/09/x.jsonl.gz'),
    path.join('2026', '09', 'x.jsonl.gz'));
  assert.equal(archive.pathInArchive('2026/09/x.jsonl.gz'),
    path.join('2026', '09', 'x.jsonl.gz'));
});

test('migrate copies, verifies, and only then removes', () => {
  const r = root();
  const rel = path.join('raw', '2026', '09', 'old.jsonl.gz');
  fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
  fs.writeFileSync(path.join(r, rel), zlib.gzipSync(Buffer.from(
    JSON.stringify({ __stamp: 'old', __captured_at: '2026-09-01T10:00:00Z', __lines: 3 })
    + '\n' + JSON.stringify({ message: { content: 'older material about a foghorn' } }) + '\n')));

  const store = archive.readConfig(process.env, r);
  const res = archive.migrate(store, r, [rel], { remove: false });
  assert.deepEqual(res.done, [rel]);
  assert.ok(fs.existsSync(path.join(store.location, archive.pathInArchive(rel))));
  // Without --remove the original stays. A move that deletes unasked is
  // not a move.
  assert.ok(fs.existsSync(path.join(r, rel)));

  // A second run does nothing — the record already knows it.
  const again = archive.migrate(store, r, [rel]);
  assert.equal(again.done.length, 0);
  assert.equal(again.skipped[0].reason, 'already-recorded');
  assert.equal(archive.records(r).length, 1, 'record written twice');
});

test('range: from/to and the hour window clip independently', () => {
  const rows = [
    { path: 'a', ts_to: '2026-09-01T08:30:00Z' },
    { path: 'b', ts_to: '2026-09-01T14:00:00Z' },
    { path: 'c', ts_to: '2026-09-03T14:00:00Z' },
    { path: 'd', ts_to: '2026-09-09T14:00:00Z' },
  ];
  const got = (o) => archive.inRange(rows, o).map((x) => x.path);

  assert.deepEqual(got({ from: '2026-09-01', to: '2026-09-03' }), ['a', 'b', 'c']);
  // The hour window applies on EVERY day of the range, not once.
  assert.deepEqual(got({ from: '2026-09-01', to: '2026-09-03', hourFrom: 12 }), ['b', 'c']);
  assert.deepEqual(got({ hourTo: 9 }), ['a']);
  // With no arguments: everything. A filter that empties when given
  // nothing is the silent variety of data loss.
  assert.equal(got({}).length, 4);
});

test('a row without a time drops out instead of widening the range', () => {
  assert.deepEqual(
    archive.inRange([{ path: 'x' }, { path: 'y', ts_to: '2026-09-01T10:00:00Z' }],
      { from: '2026-09-01' }).map((r) => r.path),
    ['y']);
});
