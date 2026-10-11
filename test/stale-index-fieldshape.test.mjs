// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Fable security run 2026-10-11 (follow-up to the read-side fix of lucky-mem error 5katltp7cfkr): a search index built by the
// code from BEFORE `fieldshape` can hold documents from poisoned lines (an object in `author`, `tags`, ...). The readers
// skip such a line now, but a cache that is still valid by its file stamps would be served as it stands: `mem find` listed
// the poisoned entry and `mem retrieve` ended in "Cannot convert object to primitive value" (reproduced: index built on
// de610ac, then the new code). The cache format is version 15 now, so every older cache is rebuilt once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadIndex, CACHE_DIR, CACHE_VERSION } from '../src/search.mjs';
import { readIndexCache, writeIndexCache } from '../src/indexcache.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantAll } from '../src/capability.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
/** The cache format of the code before `fieldshape` (de610ac) - pinned, not CACHE_VERSION - 1. */
const FORMAT_BEFORE_FIELDSHAPE = 14;
const z = (o) => `${JSON.stringify(o)}\n`;

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-staleidx-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'si', participants: ['a'], language: 'en' }));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  const base = { ts: '2026-10-11T22:30:00Z', v: 1, authority: 'agent', topic: 'tunnel' };
  fs.writeFileSync(path.join(root, 'global', 'thoughts.jsonl'),
    z({ ...base, id: 'h1healthy', title: 'alpha one', text: 'alpha healthy words', author: 'alice' })
    + z({ ...base, id: 'h2healthy', title: 'alpha two', text: 'alpha other words', author: 'bob' })
    + z({ ...base, id: 'p3poison', title: 'alpha poison', text: 'alpha poisoned words', author: { toString: 'x' } }));
  return root;
}

/** What the OLD code would have left: the cache of the current log, in the old format, with the poisoned line indexed. */
function plantOldCache(root) {
  loadIndex(root); // the new code builds it (without the poisoned line)
  const dir = path.join(root, CACHE_DIR);
  const c = readIndexCache(dir, { expectedVersion: CACHE_VERSION, expectedLanguage: 'en' });
  assert.ok(c.ok, `fixture: ${c.reason}`);
  const docs = c.index.documents;
  assert.equal(docs.length, 2, 'fixture: the new code leaves the poisoned line out of a fresh build');
  docs.push({ ...docs[1], entry: { ...docs[1].entry, id: 'p3poison', title: 'alpha poison', author: { toString: 'x' } }, line: 3 });
  c.files['global/thoughts.jsonl'].docs = 3; // the old build counted the poisoned line's document too
  writeIndexCache(dir, { version: FORMAT_BEFORE_FIELDSHAPE, language: 'en', files: c.files, fullAt: c.fullAt, index: c.index });
}

test('the cache format was raised past the one that could hold poisoned documents', () => {
  assert.ok(CACHE_VERSION > FORMAT_BEFORE_FIELDSHAPE, `CACHE_VERSION is ${CACHE_VERSION}`);
});

test('an index from before fieldshape is not used: it is rebuilt, the poisoned document is gone, nothing crashes', () => {
  const root = world();
  try {
    plantOldCache(root);
    const idx = loadIndex(root);
    const ids = idx.documents.map((d) => d.entry.id).sort();
    assert.deepEqual(ids, ['h1healthy', 'h2healthy'], 'the poisoned document came out of the stale cache');
    const r = retrieve(root, 'alpha words', grantAll(), { top: 10 }); // used to throw: "Cannot convert object to primitive value"
    assert.ok(r.claims.length >= 2);
    assert.ok(!r.claims.some((x) => x.id === 'p3poison'));
    const find = spawnSync(process.execPath, [MEM, 'find', 'alpha'], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HEADLESS: '' } });
    assert.equal(find.status, 0, find.stderr);
    assert.ok(!find.stdout.includes('alpha poison'), find.stdout);
    assert.match(find.stdout, /alpha one/, 'the healthy entries are found');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('positive control: a cache of the CURRENT format is still used as it stands (not rebuilt on every call)', () => {
  const root = world();
  try {
    loadIndex(root);
    const dir = path.join(root, CACHE_DIR);
    const c = readIndexCache(dir, { expectedVersion: CACHE_VERSION, expectedLanguage: 'en' });
    c.index.documents[0].weights = [['plantedmarker', 1]];
    writeIndexCache(dir, { version: CACHE_VERSION, language: 'en', files: c.files, fullAt: c.fullAt, index: c.index });
    const again = loadIndex(root);
    assert.deepEqual([...again.documents[0].weights], [['plantedmarker', 1]], 'the planted current-format cache was thrown away');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
