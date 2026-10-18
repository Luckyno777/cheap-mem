// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// K0 fix 2 (indexregeln-cm): the search index cache carried only a hand-raised FORMAT number, so an index built under other
// INDEX RULES (tokenizer, stopwords, stemming, fields, drawer set) was served as it stood while every file stamp matched
// (reproduced: a cache built at 346dec9^ was kept by 346dec9). Now the manifest carries `indexRules` (INDEX_RULES_VERSION in
// src/indexrules.mjs, ONE constant used by writer and reader), and a ratchet ties the constant to a fingerprint of the
// rules' behaviour so a rule cannot change without the number moving.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { INDEX_RULES_VERSION } from '../src/indexrules.mjs';
import { loadIndex, CACHE_DIR, CACHE_VERSION } from '../src/search.mjs';
import { readIndexCache, writeIndexCache } from '../src/indexcache.mjs';
import { PACKS } from '../src/language.mjs';
import * as memory from '../src/memory.mjs';
import { ruleFacts, ruleFingerprint, partHashes } from './fixture/index-rules-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');
const HISTORY = JSON.parse(fs.readFileSync(path.join(HERE, 'fixture', 'index-rules-history.json'), 'utf8')).history;
const z = (o) => `${JSON.stringify(o)}\n`;

function world(t) {
  const root = tempDir('cm-idxrules-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'ir', participants: ['a'], language: 'en' }));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  const base = { ts: '2026-10-18T10:00:00Z', v: 1, authority: 'agent', topic: 'tunnel' };
  fs.writeFileSync(path.join(root, 'global', 'thoughts.jsonl'),
    z({ ...base, id: 'a1alpha', title: 'alpha one', text: 'alpha healthy words' })
    + z({ ...base, id: 'a2alpha', title: 'alpha two', text: 'alpha other words' }));
  return root;
}
const cacheDirOf = (root) => path.join(root, CACHE_DIR);
const manifestOf = (root) => path.join(cacheDirOf(root), 'manifest.json');
const editManifest = (root, fn) => fs.writeFileSync(manifestOf(root), JSON.stringify(fn(JSON.parse(fs.readFileSync(manifestOf(root), 'utf8')))));
/** Plant a marker into the cached first document (a rebuild from the log cannot bring it back); the cache then still reads as valid. */
function plantMarker(root, mutate) {
  const c = readIndexCache(cacheDirOf(root), { expectedVersion: CACHE_VERSION, expectedLanguage: 'en' });
  assert.ok(c.ok, `fixture: ${c.reason}`);
  c.index.documents[0].weights = [['plantedmarker', 1]];
  writeIndexCache(cacheDirOf(root), { version: CACHE_VERSION, language: 'en', files: c.files, fullAt: c.fullAt, index: c.index });
  if (mutate) editManifest(root, mutate);
}
function captureStderr(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { return { value: fn(), lines }; } finally { console.error = real; }
}
const hasMarker = (idx) => idx.documents.some((d) => [...d.weights.keys()].includes('plantedmarker'));

test('the writer puts the one constant into the manifest', (t) => {
  const root = world(t);
  loadIndex(root);
  const m = JSON.parse(fs.readFileSync(manifestOf(root), 'utf8'));
  assert.equal(m.indexRules, INDEX_RULES_VERSION);
  assert.equal(m.version, CACHE_VERSION, 'the format number stays its own');
});

test('positive control: an index of the current rules is kept as it stands, silently', (t) => {
  const root = world(t);
  loadIndex(root);
  plantMarker(root);
  const { value: idx, lines } = captureStderr(() => loadIndex(root));
  assert.ok(hasMarker(idx), 'the planted current-rules cache was thrown away');
  assert.deepEqual(lines, []);
});

test('an index built under OTHER rules is dropped, said on stderr, rebuilt, and the answer is right', (t) => {
  const root = world(t);
  loadIndex(root);
  plantMarker(root, (m) => ({ ...m, indexRules: INDEX_RULES_VERSION + 1 }));
  const { value: idx, lines } = captureStderr(() => loadIndex(root));
  assert.ok(!hasMarker(idx), 'the index of other rules was served');
  assert.equal(idx.cacheStatus, 'stale');
  assert.equal(idx.fromCache, false);
  assert.deepEqual(idx.documents.map((d) => d.entry.id).sort(), ['a1alpha', 'a2alpha']);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /index rules/);
  assert.match(lines[0], new RegExp(`built under index rules ${INDEX_RULES_VERSION + 1}`));
  assert.equal(JSON.parse(fs.readFileSync(manifestOf(root), 'utf8')).indexRules, INDEX_RULES_VERSION, 'the rebuilt cache carries the current rules');
  const again = captureStderr(() => loadIndex(root));
  assert.deepEqual(again.lines, [], 'the migration is said once, not on every load');
  assert.equal(again.value.cacheStatus, 'hit');
});

test('an index built BEFORE the field existed (no indexRules) is stale: one loud rebuild on an existing installation', (t) => {
  const root = world(t);
  loadIndex(root);
  plantMarker(root, ({ indexRules, ...rest }) => rest);
  assert.equal(JSON.parse(fs.readFileSync(manifestOf(root), 'utf8')).indexRules, undefined, 'fixture: the field is gone');
  const { value: idx, lines } = captureStderr(() => loadIndex(root));
  assert.ok(!hasMarker(idx), 'the index without a rules number was served');
  assert.equal(idx.cacheStatus, 'stale');
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /none \(older build\)/);
});

test('end to end: `mem find` over an index of other rules says so on stderr and still answers', (t) => {
  const root = world(t);
  loadIndex(root);
  editManifest(root, (m) => ({ ...m, indexRules: 0 }));
  const run = () => spawnSync(process.execPath, [MEM, 'find', 'alpha'], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HEADLESS: '' } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /built under index rules 0/);
  assert.match(first.stdout, /alpha one/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /index rules/);
});

test('the read side takes the number from the constant, not from the caller (nothing to forget)', (t) => {
  const root = world(t);
  loadIndex(root);
  editManifest(root, (m) => ({ ...m, indexRules: INDEX_RULES_VERSION + 1 }));
  const res = readIndexCache(cacheDirOf(root), { expectedVersion: CACHE_VERSION, expectedLanguage: 'en' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'rules-mismatch');
  assert.equal(res.found, INDEX_RULES_VERSION + 1);
});

// --- the ratchet ---

test('ratchet: the history is consecutive and its last entry is the constant', () => {
  assert.ok(HISTORY.length >= 1);
  HISTORY.forEach((e, i) => assert.equal(e.version, i + 1, `history entry ${i} has version ${e.version}`));
  for (let i = 1; i < HISTORY.length; i += 1) {
    assert.notEqual(HISTORY[i].fingerprint, HISTORY[i - 1].fingerprint, `version ${HISTORY[i].version} was raised without a rule change`);
  }
  assert.equal(INDEX_RULES_VERSION, HISTORY.at(-1).version,
    'INDEX_RULES_VERSION and the last entry of test/fixture/index-rules-history.json must be the same number');
});

test('ratchet: the rules still behave as recorded for the current version (change a rule => raise INDEX_RULES_VERSION)', () => {
  const now = ruleFingerprint();
  assert.equal(now, HISTORY.at(-1).fingerprint,
    'An index rule changed (tokenizer, stopwords, stemming, fields, weights, drawer set or the shape rule). Every index built before it is wrong. '
    + `Raise INDEX_RULES_VERSION in src/indexrules.mjs to ${INDEX_RULES_VERSION + 1} and APPEND { version: ${INDEX_RULES_VERSION + 1}, fingerprint: "${now}" } `
    + 'to test/fixture/index-rules-history.json (an old entry is never edited). Parts now: ' + JSON.stringify(partHashes()));
});

test('ratchet mutants: a changed rule moves the fingerprint', () => {
  const base = ruleFingerprint();
  assert.equal(ruleFingerprint(), base, 'the fingerprint is stable between two runs');
  // 1. a stopword (the real, mutable Set of the English pack) goes
  const stop = PACKS.en.stopwords;
  const word = [...stop][0];
  stop.delete(word);
  try { assert.notEqual(ruleFingerprint(), base, `dropping the stopword "${word}" was not noticed`); } finally { stop.add(word); }
  assert.equal(ruleFingerprint(), base, 'restored');
  // 2. facts-level mutants for the frozen tables: weight, field set, drawer set
  const facts = ruleFacts();
  const mutants = {
    weight: { ...facts, fieldWeights: { ...facts.fieldWeights, title: facts.fieldWeights.title + 0.5 } },
    fields: { ...facts, bodyFields: { ...facts.bodyFields, event: [...facts.bodyFields.event, 'extra'] } },
    drawers: { ...facts, drawers: { ...facts.drawers, searched: [...facts.drawers.searched, 'card'] } },
    stemmer: { ...facts, packs: { ...facts.packs, en: { ...facts.packs.en, words: facts.packs.en.words.map((w) => w.slice(0, -1)) } } },
  };
  for (const [name, m] of Object.entries(mutants)) assert.notEqual(ruleFingerprint(m), base, `mutant "${name}" was not noticed`);
  assert.ok(memory.SEARCH_TYPES.includes('thought') && !memory.SEARCH_TYPES.includes('card'), 'fixture: the drawer set is what the mutant changes');
});
