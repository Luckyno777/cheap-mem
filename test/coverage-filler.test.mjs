// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A typed word the document could never carry (an English stopword, which
// the document's own rule set dropped at index time) must not count as
// uncovered. Before 2026-10-07 it did, whenever the query's language was
// open: "the", "and", "on" are English stopwords but not German ones, so
// they survived query tokenisation as typed words, no English entry could
// carry them, and the answer gate (h3: "carries EVERY typed word") withheld
// a field of equally good hits that held every word it could.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { search, loadIndex } from '../src/search.mjs';
import { passes } from '../src/searchlevers.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function world(titles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-filler-'));
  const env = { ...process.env, CHEAP_MEM_ROOT: root };
  execFileSync(process.execPath, [MEM, 'init'], { env, stdio: 'ignore' });
  for (const t of titles) {
    execFileSync(process.execPath, [MEM, 'log', 'event', '--title', t, '--tags', 'misc'], { env, stdio: 'ignore' });
  }
  return root;
}

const NOTES = [1, 2, 3, 4, 5, 6].map((i) => `routine note ${i} about deploys and builds`);

test('stopwords in the question do not count as uncovered words', () => {
  const root = world(NOTES);
  try {
    const index = loadIndex(root);
    const plain = search(index, 'routine note deploys builds', { top: 10, withCoverage: true });
    const worded = search(index, 'the routine note on deploys and builds', { top: 10, withCoverage: true });
    assert.equal(plain.length, 6);
    assert.equal(worded.length, 6);
    for (const h of worded) assert.equal(h.covered, 1, 'every word the entry could carry is carried');
    // The gate: a flat field of full covers is an answer, with or without filler words.
    assert.ok(worded.every((h) => passes(h, worded, { occasion: 'find' })), 'the gate lets the field out');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('COUNTER-PROBE: a content word the entry lacks still counts as uncovered', () => {
  const root = world(NOTES);
  try {
    const index = loadIndex(root);
    const hits = search(index, 'the routine note on deploys and kubernetes', { top: 10, withCoverage: true });
    assert.ok(hits.length > 0);
    for (const h of hits) assert.ok(h.covered < 1, `kubernetes is not carried, covered=${h.covered}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('conversational filler of a question ("tell me about ...") does not count as uncovered', () => {
  const root = world(NOTES);
  try {
    const index = loadIndex(root);
    const asked = search(index, 'tell me about the routine note on deploys and builds', { top: 10, withCoverage: true });
    assert.equal(asked.length, 6);
    for (const h of asked) assert.equal(h.covered, 1);
    assert.ok(asked.every((h) => passes(h, asked, { occasion: 'find' })), 'the gate lets the field out');
    const please = search(index, 'please explain what the routine note about deploys is', { top: 10, withCoverage: true });
    for (const h of please) assert.equal(h.covered, 1);
    // COUNTER-PROBE: a topic word the entry lacks is still uncovered, filler or not.
    const missing = search(index, 'tell me about the routine note on kubernetes', { top: 10, withCoverage: true });
    assert.ok(missing.length > 0);
    for (const h of missing) assert.ok(h.covered < 1);
    // Scores are untouched by the filler list: the same question without the filler words, same order.
    const bare = search(index, 'routine note deploys builds', { top: 10 });
    assert.equal(asked.length, bare.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
