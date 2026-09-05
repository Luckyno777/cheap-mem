// Rollback and resurrection: check out an older commit and a superseded
// claim is active again, with nothing to notice it. Listed as unsolved
// after round three; this is the smallest thing that closes it, and its
// limits are tested as explicitly as its guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { observe, checkEpoch, recordEpoch, readEpoch, EPOCH_FILE } from '../src/epoch.mjs';
import { SEMANTIC_VERSION, CHANGELOG } from '../src/semantics.mjs';

const z = (o) => JSON.stringify(o) + '\n';
const A = { id: 'a1', ts: '2026-01-01T00:00:00Z', author: 'alice', authority: 'agent',
  topic: 't', choice: 'payment up front', why: 'original' };
const FIX = { id: 'a2', ts: '2026-02-01T00:00:00Z', author: 'alice', authority: 'agent',
  topic: 't', choice: 'payment up front, SEPA only', why: 'narrowed', replaces_id: 'a1' };

function fixture(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ep-'));
  fs.mkdirSync(path.join(root, 'projects', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'a', 'decisions.jsonl'),
    entries.map((e) => z(e)).join(''));
  return root;
}
const write = (root, entries) => fs.writeFileSync(
  path.join(root, 'projects', 'a', 'decisions.jsonl'), entries.map((e) => z(e)).join(''));
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

test('a fresh memory has no watermark and says so instead of claiming safety', () => {
  const root = fixture([A]);
  const s = checkEpoch(root);
  assert.equal(s.status, 'first');
  assert.equal(s.mark, null);
  rm(root);
});

test('growing forward is `ahead`, standing still is `same`', () => {
  const root = fixture([A]);
  recordEpoch(root);
  assert.equal(checkEpoch(root).status, 'same');
  write(root, [A, FIX]);
  assert.equal(checkEpoch(root).status, 'ahead');
  rm(root);
});

test('a rollback that resurrects a superseded claim is detected and NAMED', () => {
  const root = fixture([A, FIX]);
  recordEpoch(root);
  write(root, [A]);                       // the t1 state again
  const s = checkEpoch(root);
  assert.equal(s.status, 'rollback');
  assert.deepEqual(s.resurrected, ['a1']);
  assert.equal(s.lostClaims, 1);
  rm(root);
});

test('resurrection is caught even when the claim count is unchanged', () => {
  // The count alone is not enough: a rollback that drops one tombstone and
  // adds an unrelated claim keeps the total identical. The RETIRED SET is
  // what carries the signal, which is why it is compared as a set.
  const OTHER = { id: 'b1', ts: '2026-03-01T00:00:00Z', author: 'alice',
    authority: 'agent', topic: 't', choice: 'unrelated', why: 'filler' };
  const root = fixture([A, FIX]);
  recordEpoch(root);
  write(root, [A, OTHER]);                // same count, tombstone gone
  const s = checkEpoch(root);
  assert.equal(s.current.claims, s.mark.claims, 'the fixture must keep the count equal');
  assert.equal(s.status, 'rollback');
  assert.deepEqual(s.resurrected, ['a1']);
  rm(root);
});

test('recordEpoch refuses to lower the watermark, and --force is a deliberate act', () => {
  const root = fixture([A, FIX]);
  recordEpoch(root);
  const before = readEpoch(root);
  write(root, [A]);
  const refused = recordEpoch(root);
  assert.equal(refused.written, false);
  assert.deepEqual(readEpoch(root), before, 'the mark moved backwards anyway');

  const forced = recordEpoch(root, { force: true });
  assert.equal(forced.written, true);
  assert.equal(checkEpoch(root).status, 'same');
  rm(root);
});

test('the watermark stores no memory content — it is an observation, not a claim', () => {
  const root = fixture([{ ...A, why: 'a very distinctive secret-looking phrase' }]);
  recordEpoch(root);
  const raw = fs.readFileSync(path.join(root, EPOCH_FILE), 'utf8');
  assert.ok(!raw.includes('distinctive'), 'the watermark copied entry content');
  assert.ok(!raw.includes('payment'), 'the watermark copied entry content');
  rm(root);
});

test('observe() is deterministic and order-independent', () => {
  const root = fixture([A, FIX]);
  const a = observe(root);
  const b = observe(root);
  assert.equal(a.retiredHash, b.retiredHash);
  assert.equal(a.claims, b.claims);
  write(root, [FIX, A]);                  // reversed file order
  assert.equal(observe(root).retiredHash, a.retiredHash);
  rm(root);
});

test('LIMIT: deleting the watermark defeats detection — and that is documented, not hidden', () => {
  const root = fixture([A, FIX]);
  recordEpoch(root);
  fs.rmSync(path.join(root, EPOCH_FILE));
  write(root, [A]);
  assert.equal(checkEpoch(root).status, 'first',
    'without the mark there is nothing to compare against — by construction');
  const help = execFileSync('node', [path.join(process.cwd(), 'bin', 'mem'), 'epoch', '--help'],
    { encoding: 'utf8' });
  assert.match(help, /delete it and you lose detection, not data/i);
  assert.match(help, /fresh clone/i);
  rm(root);
});

test('the watermark is gitignored in a memory created by init', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ep-init-'));
  execFileSync('node', [path.join(process.cwd(), 'bin', 'mem'), 'init'],
    { cwd: root, stdio: 'ignore' });
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /\.mem\/epoch\.json/,
    'a committed watermark travels back with the checkout it is meant to detect');
  rm(root);
});

test('a watermark from older semantics is not compared — a rules change is not a rollback', () => {
  // Comparing across a rules bump would report a rollback that is really a
  // rule change, and hide a real one behind the noise.
  const root = fixture([A, FIX]);
  recordEpoch(root);
  const mark = JSON.parse(fs.readFileSync(path.join(root, EPOCH_FILE), 'utf8'));
  mark.semantics = 0;
  fs.writeFileSync(path.join(root, EPOCH_FILE), JSON.stringify(mark));
  write(root, [A]);                        // a genuine rollback, under old semantics
  const s = checkEpoch(root);
  assert.equal(s.status, 'semantics-changed');
  assert.match(s.detail, /NOT comparable/);
  rm(root);
});

test('the semantic version is recorded in every watermark', () => {
  const root = fixture([A]);
  recordEpoch(root);
  const mark = JSON.parse(fs.readFileSync(path.join(root, EPOCH_FILE), 'utf8'));
  assert.equal(mark.semantics, SEMANTIC_VERSION);
  assert.ok(CHANGELOG[SEMANTIC_VERSION], 'a semantic version with no changelog entry');
  rm(root);
});
