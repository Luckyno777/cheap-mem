// test/y7-encrypted-search.test.mjs — Y7 (2026-09-30): encrypted entries
// (`shred: true`) are searchable and visible to the signed-in user, but
// their plaintext lives in memory only.
//
// Decision (owner, 2026-09-30): threat model = data theft at rest (a
// stolen laptop). So: (1) with the key present, the body is decrypted in
// memory at load and indexed normally; (2) NO file under the root ever
// holds the plaintext (search-index shards, dashboard, journals); (3) key
// destroyed -> gone from search and display at once; (4) key unreachable
// -> "not readable", never silently empty; (5) plain entries unchanged.
//
// Red proof: run this file against the fixed start commit f9ece14
// (`git archive f9ece14` into a temp dir + this file) -> the finding
// tests fail with 0 hits; see the session report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as shred from '../src/shred.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';
import * as fulltext from '../src/fulltext.mjs';
import * as retrieval from '../src/retrieval.mjs';
import * as caps from '../src/capability.mjs';

const WORD = 'uniquesecretquartz';
const PLAIN = 'plainvisiblemarmot';

function mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'y7-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const hits = (idx, q) => (search.search(idx, q).results ?? search.search(idx, q)).length;

function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
/** Every file under `root` (dot-folders included) that contains `needle`. */
function filesWith(root, needle) {
  return walk(root).filter((f) => fs.readFileSync(f).includes(needle));
}
function seed(root) {
  const enc = memory.logEntry(root, 'decision', { title: 'crypt title', text: `${WORD} vault contents`, shred: true });
  memory.logEntry(root, 'decision', { title: 'open title', text: `${PLAIN} open contents` });
  return enc.id ?? enc.entry?.id;
}

test('finding: an encrypted entry is found by a word from its encrypted body (fresh and cached)', () => {
  const root = mkRoot();
  try {
    seed(root);
    for (const opts of [{ fresh: true }, {}, {}]) {
      const idx = search.loadIndex(root, opts);
      assert.equal(hits(idx, WORD), 1, `search(${JSON.stringify(opts)})`);
      const hit = (search.search(idx, WORD).results ?? search.search(idx, WORD))[0];
      assert.match(String(hit.entry.text), new RegExp(WORD));
      assert.equal(hit.entry.__body.state, 'ok');
    }
  } finally { away(root); }
});

test('finding: an entry appended AFTER a cache exists is found through the append path', () => {
  const root = mkRoot();
  try {
    for (let i = 0; i < 60; i += 1) memory.logEntry(root, 'decision', { title: `base ${i}`, text: `base plain entry ${i}` });
    search.loadIndex(root, { fresh: true });
    memory.logEntry(root, 'decision', { title: 'late', text: `${WORD} late arrival`, shred: true });
    const idx = search.loadIndex(root);
    assert.equal(idx.appended, 1);
    assert.equal(hits(idx, WORD), 1);
    assert.deepEqual(filesWith(root, WORD), []);
  } finally { away(root); }
});

test('no plaintext on disk: nothing under the root holds the word after search and dashboard', () => {
  const root = mkRoot();
  try {
    seed(root);
    search.loadIndex(root, { fresh: true });
    search.loadIndex(root);
    hits(search.loadIndex(root), WORD);
    fulltext.forget();
    const ft = fulltext.answer(root, WORD);
    assert.equal(ft.measurable, true);
    assert.equal(ft.ids.length, 1, 'the dashboard full-text search finds it in memory');
    const data = dashboardData.collectDashboard(root);
    assert.match(JSON.stringify(data), new RegExp(WORD), 'the signed-in dashboard shows it');
    const claims = retrieval.retrieve(root, WORD, caps.grantAll('test'), { top: 5 }).claims;
    assert.equal(claims.length, 1, 'agent recall finds it too');
    const card = dashboard.readPass(root).rows.find((x) => x.entry.__body);
    assert.equal(card.entry.text, `${WORD} vault contents`);
    // The unique word of the plain entry is a positive control for the scan:
    assert.ok(filesWith(root, PLAIN).length > 0, 'the scan does see plain text (control)');
    assert.deepEqual(filesWith(root, WORD), [], 'plaintext of an encrypted entry on disk');
    assert.deepEqual(filesWith(root, 'vault contents'), []);
    assert.deepEqual(filesWith(root, 'crypt title'), []);
  } finally { away(root); }
});

test('key destroyed: gone from search, display and full text at once', () => {
  const root = mkRoot();
  try {
    const id = seed(root);
    let idx = search.loadIndex(root);
    assert.equal(hits(idx, WORD), 1);
    fulltext.forget();
    assert.equal(fulltext.answer(root, WORD).ids.length, 1);
    const res = memory.shredEntry(root, 'decision', id, { reason: 'test' });
    assert.equal(res.destroyed.destroyed ?? res.destroyed, true);
    idx = search.loadIndex(root);
    assert.equal(hits(idx, WORD), 0);
    const doc = idx.documents.find((d) => d.entry.id === id);
    assert.equal(doc.encState, 'unreadable');
    assert.match(doc.entry.title, /not readable/);
    assert.match(doc.entry.title, /destroyed|shredded/);
    // same process, no forget(): the in-memory full-text store must notice the key change
    assert.equal(fulltext.answer(root, WORD).ids.length, 0);
    const row = dashboard.readPass(root).rows.find((x) => x.entry.id === id);
    assert.match(row.entry.title, /not readable/);
    assert.equal(row.entry.text, undefined);
    assert.match(JSON.stringify(dashboardData.collectDashboard(root)), /not readable/);
    assert.equal(JSON.stringify(dashboardData.collectDashboard(root)).includes(WORD), false);
    assert.deepEqual(filesWith(root, WORD), []);
  } finally { away(root); }
});

test('key store unreachable: state is "not readable / unknown", never empty', () => {
  const root = mkRoot();
  try {
    const id = seed(root);
    search.loadIndex(root, { fresh: true });
    fs.renameSync(shred.keyringPath(root), path.join(root, 'keyring.away'));
    const idx = search.loadIndex(root);
    assert.equal(hits(idx, WORD), 0);
    const doc = idx.documents.find((d) => d.entry.id === id);
    assert.equal(doc.encState, 'unreadable');
    assert.equal(doc.entry.__body.reason, 'keyring-absent');
    assert.match(doc.entry.title, /unreachable/);
    assert.match(doc.entry.title, /unknown/);
    const row = dashboard.readPass(root).rows.find((x) => x.entry.id === id);
    assert.match(row.entry.title, /unreachable/);
    // ... and it comes back when the key store does
    fs.renameSync(path.join(root, 'keyring.away'), shred.keyringPath(root));
    assert.equal(hits(search.loadIndex(root), WORD), 1);
  } finally { away(root); }
});

test('corrupt key store is "not readable", not a crash', () => {
  const root = mkRoot();
  try {
    const id = seed(root);
    fs.writeFileSync(shred.keyringPath(root), '{ not json');
    const idx = search.loadIndex(root, { fresh: true });
    const doc = idx.documents.find((d) => d.entry.id === id);
    assert.equal(doc.entry.__body.reason, 'keyring-corrupt');
    assert.equal(hits(idx, PLAIN), 1);
  } finally { away(root); }
});

test('positive control: plain entries behave as before; ranking statistics stay coherent', () => {
  const root = mkRoot();
  try {
    seed(root);
    const idx = search.loadIndex(root);
    assert.equal(hits(idx, PLAIN), 1);
    assert.equal(idx.N, idx.documents.length);
    const plainDoc = idx.documents.find((d) => !d.enc);
    assert.equal(plainDoc.enc, undefined);
    assert.equal(plainDoc.encState, undefined);
    // docFreq agrees with the documents (decrypted words included exactly once)
    const counted = new Map();
    for (const d of idx.documents) for (const t of d.weights.keys()) counted.set(t, (counted.get(t) ?? 0) + 1);
    for (const [t, n] of counted) assert.equal(idx.docFreq.get(t), n, `docFreq of ${t}`);
    // a plain-only corpus: identical answer with and without the encrypted entry's slot
    const root2 = mkRoot();
    try {
      memory.logEntry(root2, 'decision', { title: 'open title', text: `${PLAIN} open contents` });
      const a = search.search(search.loadIndex(root2), PLAIN);
      const b = search.search(idx, PLAIN);
      assert.equal((a.results ?? a).length, (b.results ?? b).length);
    } finally { away(root2); }
  } finally { away(root); }
});

test('cost: load time with 0, 10 and 100 encrypted entries (printed, coarse bound)', () => {
  const out = {};
  for (const n of [0, 10, 100]) {
    const root = mkRoot();
    try {
      for (let i = 0; i < 200; i += 1) memory.logEntry(root, 'decision', { title: `plain ${i}`, text: `plain body number ${i} marmot` });
      for (let i = 0; i < n; i += 1) memory.logEntry(root, 'decision', { title: `crypt ${i}`, text: `${WORD} secret body ${i}`, shred: true });
      search.loadIndex(root, { fresh: true });
      const t0 = performance.now();
      const rounds = 5;
      for (let i = 0; i < rounds; i += 1) search.loadIndex(root);
      out[n] = Math.round((performance.now() - t0) / rounds * 10) / 10;
    } finally { away(root); }
  }
  console.log(`# warm load ms (200 plain entries + N encrypted): ${JSON.stringify(out)}`);
  assert.ok(out[100] < out[0] + 2000, 'decrypting 100 entries stays far below the cost of a rebuild');
});
