// A rare, literally typed word counts in full inside a raw capture
// (src/search.mjs RARE_DF; mirrored from lucky-mem P9, 2026-09-28).
//
// The case this pins: a question whose only content word stands in ONE
// document, a capture where the person wrote the sentence themselves.
// With RAW_WEIGHT damping, idf at its ceiling and a capture of average
// length, the score topped out just under the injection bar (5.0,
// MEM_RETRIEVE_MIN in bin/mem-retrieve). The fixture rebuilds that shape
// without anyone's real text: a large curated corpus (so idf sits where it
// does on a real memory) and one capture holding the rare word once.
//
// Red proof (before the change, commit 6154cd0): score 3.53 < 5.0; after: 7.47.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as search from '../src/search.mjs';

const BAR = 5.0;   // MEM_RETRIEVE_MIN default (bin/mem-retrieve)

const WORDS = ['recall', 'digest', 'watcher', 'journal', 'register', 'threshold', 'corpus',
  'entry', 'session', 'dashboard', 'graph', 'node', 'shell', 'edge', 'thread', 'archive',
  'bell', 'inbox', 'console', 'gate', 'suite', 'branch', 'commit', 'run', 'service',
  'server', 'bridge', 'tunnel', 'login', 'sign', 'mark', 'colour', 'cloud', 'sphere'];

function corpus(root, n = 2500) {
  const dir = path.join(root, 'global');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const w = (k) => WORDS[(i * 7 + k * 13) % WORDS.length];
    lines.push(JSON.stringify({
      id: `RW${String(i).padStart(5, '0')}`, ts: '2026-09-01T10:00:00Z', author: 'lucky',
      title: `${w(0)} and ${w(1)}`,
      text: `the ${w(2)} checks the ${w(3)} in the ${w(4)}, then ${w(5)} ${w(6)}`,
    }));
  }
  fs.writeFileSync(path.join(dir, 'learnings.jsonl'), `${lines.join('\n')}\n`);
}

function capture(root, name, sentences) {
  const dir = path.join(root, 'raw', '2026', '09');
  fs.mkdirSync(dir, { recursive: true });
  const body = sentences.map((t) => JSON.stringify({ ts: '2026-09-28T09:00:00Z', role: 'user', text: t }));
  fs.writeFileSync(path.join(dir, `2026-09-28T09-00-00Z--${name}.jsonl.gz`),
    zlib.gzipSync(`${body.join('\n')}\n`));
}

const idx = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rare-'));
  try {
    corpus(root);
    // The rare word ("axolotl") exactly ONCE; a control word ("thunderstorm")
    // in four captures — df 4, so NOT rare (RARE_DF = 3).
    capture(root, 'rare', [
      'the clouds in the graph should look less like an axolotl and more like a sphere',
      'make the edges calmer and the colour warmer, no thunderstorm please',
      // Padding so the capture is about as long as an average document —
      // otherwise length normalisation alone lifts it over the bar.
      ...Array.from({ length: 5 }, (_, i) => WORDS.slice(i * 6, i * 6 + 6).join(' ')),
    ]);
    for (let i = 0; i < 3; i += 1) {
      capture(root, `storm${i}`, [`a thunderstorm over the ${WORDS[i]} and the ${WORDS[i + 5]}`]);
    }
    return search.buildIndex(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();

function rawHit(query) {
  return search.search(idx, query, { top: 9, mmr: true })
    .find((h) => h.raw && String(h.source).includes('--rare')) ?? null;
}

test('the fixture is as large as a real memory, and the words have the intended df', () => {
  assert.ok(idx.N >= 2500, `N=${idx.N}`);
  const rareDoc = idx.documents.find((d) => d.type === 'raw' && d.source.includes('--rare'));
  assert.ok(rareDoc, 'the capture was not indexed');
  const ratio = rareDoc.length / idx.avgLength;
  assert.ok(ratio > 0.8 && ratio < 1.4, `capture/average = ${ratio.toFixed(2)}`);
});

test('a rare typed word lifts the capture over the injection bar', () => {
  const h = rawHit('axolotl?');
  assert.ok(h, 'the capture was not found at all');
  assert.ok(h.score >= BAR, `score ${h.score.toFixed(3)} < ${BAR}`);
});

test('positive control: a word in four documents stays damped in the capture', () => {
  const h = rawHit('thunderstorm?');
  assert.ok(h, 'the capture was not found at all');
  assert.ok(h.score < BAR, `score ${h.score.toFixed(3)} >= ${BAR}: damping is gone`);
});
