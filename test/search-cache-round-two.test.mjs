// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Second review of the shape rule (2026-10-12), L3: `search.CACHE_VERSION` was still 15 after the rule became strict. An index built
// by the FIRST round of the code (version 15) holds the documents of lines with `key: 5` / `title: true` (broken now, out of the
// index) and lacks the lines with `tags: true` (read as an empty list now, in the index). It is valid by its file stamps, so it was
// served as it stands: `mem find` listed broken lines and hid readable ones. The format is 16 now, so a version-15 cache is rebuilt
// once. Same probe as test/derived-caches-version.test.mjs: the previous format is PINNED (not CACHE_VERSION - 1), and a cache of
// the current format is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp-dir.mjs';
import { loadIndex, CACHE_DIR, CACHE_VERSION } from '../src/search.mjs';
import { readIndexCache, writeIndexCache } from '../src/indexcache.mjs';

/** The cache format of the first round of the strict shape rule - pinned. */
const FORMAT_ROUND_ONE = 15;
const z = (o) => `${JSON.stringify(o)}\n`;

function world(t) {
  const root = tempDir('cm-cache16-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'c16', participants: ['a'], language: 'en' }));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  const base = { ts: '2026-10-11T22:30:00Z', v: 1, authority: 'agent', topic: 'tunnel' };
  fs.writeFileSync(path.join(root, 'global', 'thoughts.jsonl'),
    z({ ...base, id: 'h1healthy', title: 'alpha one', text: 'alpha healthy words' })
    + z({ ...base, id: 'k2keyfive', title: 'alpha key five', text: 'alpha numeric key words', key: 5 })
    + z({ ...base, id: 't3tagstrue', title: 'alpha tags true', text: 'alpha bare tags words', tags: true }));
  return root;
}
const ids = (idx) => idx.documents.map((d) => d.entry.id).sort();

/** What the round-one code would have left: `key: 5` indexed, `tags: true` missing, format 15. */
function plantRoundOneCache(root) {
  const idx = loadIndex(root);
  assert.deepEqual(ids(idx), ['h1healthy', 't3tagstrue'], 'fixture: the current code indexes the tags:true line and not the key:5 line');
  const dir = path.join(root, CACHE_DIR);
  const c = readIndexCache(dir, { expectedVersion: CACHE_VERSION, expectedLanguage: 'en' });
  assert.ok(c.ok, `fixture: ${c.reason}`);
  const docs = c.index.documents;
  const tags = docs.findIndex((d) => d.entry.id === 't3tagstrue');
  const [gone] = docs.splice(tags, 1);
  docs.push({ ...gone, entry: { ...gone.entry, id: 'k2keyfive', title: 'alpha key five', key: 5, tags: undefined }, line: 2 });
  writeIndexCache(dir, { version: FORMAT_ROUND_ONE, language: 'en', files: c.files, fullAt: c.fullAt, index: c.index });
}

test('the cache format was raised past the one of the first round', () => {
  assert.ok(CACHE_VERSION > FORMAT_ROUND_ONE, `CACHE_VERSION is ${CACHE_VERSION}`);
});

test('a version-15 index is rebuilt: the key:5 line is out, the tags:true line is in', (t) => {
  const root = world(t);
  plantRoundOneCache(root);
  assert.deepEqual(ids(loadIndex(root)), ['h1healthy', 't3tagstrue'], 'the old-format index was served as it stood');
});

test('positive control: a cache of the CURRENT format is kept as it stands', (t) => {
  const root = world(t);
  loadIndex(root);
  const dir = path.join(root, CACHE_DIR);
  const c = readIndexCache(dir, { expectedVersion: CACHE_VERSION, expectedLanguage: 'en' });
  c.index.documents[0].weights = [['plantedmarker', 1]];
  writeIndexCache(dir, { version: CACHE_VERSION, language: 'en', files: c.files, fullAt: c.fullAt, index: c.index });
  assert.deepEqual([...loadIndex(root).documents[0].weights], [['plantedmarker', 1]], 'a current-format cache was thrown away');
});
