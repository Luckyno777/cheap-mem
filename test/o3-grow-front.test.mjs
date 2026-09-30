// O3 (2026-09-30): the index cache must not paper over an equal-length
// change EARLIER in a log when the file has also GROWN. Before, on growth
// only the hash of the last 4 KiB of the old range was compared (no
// mtime, no full hash): a git merge or checkout that rewrote a line near
// the front at equal length and appended one at the end let the appended
// index keep serving the OLD text.
//
// Three things:
//   1. red probe: change at the front + append never serves the old text;
//   2. positive control: a pure append stays incremental;
//   3. equivalence: after a sequence of edits the appended index returns
//      the same hits in the same order as a full build from an empty cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIndex, search } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-o3-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  return r;
}
const hits = (idx, q) => search(idx, q, { top: 5 }).length;
const TYPE = 'decision';

function corpus(r) {
  memory.logEntry(r, TYPE, { title: 'alphaquartz first entry', why: 'start marker' });
  for (let i = 0; i < 8; i += 1) memory.logEntry(r, TYPE, { title: `filler ${i}`, why: 'x'.repeat(700) });
  memory.logEntry(r, TYPE, { title: 'bravoquartz middle entry', why: 'middle marker' });
  for (let i = 0; i < 8; i += 1) memory.logEntry(r, TYPE, { title: `filler more ${i}`, why: 'y'.repeat(700) });
  memory.logEntry(r, TYPE, { title: 'charliequartz last entry', why: 'end marker' });
  return memory.logPath(r, TYPE, null);
}

test('change at the front + append never serves the old text', () => {
  const r = root();
  try {
    const f = corpus(r);
    assert.ok(fs.statSync(f).size > 8192, 'the log must be larger than the tail window');
    loadIndex(r, { language: 'en' });
    const warm = loadIndex(r, { language: 'en' });
    assert.equal(warm.fromCache, true);
    assert.equal(hits(warm, 'alphaquartz'), 1, 'control: the marker is found before the change');

    const size = fs.statSync(f).size;
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('alphaquartz', 'omegaquartz'));
    assert.equal(fs.statSync(f).size, size, 'the rewrite must be equal-length');
    memory.logEntry(r, TYPE, { title: 'echoquartz appended', why: 'after the rewrite' });
    assert.ok(fs.statSync(f).size > size, 'the file must have grown');

    const idx = loadIndex(r, { language: 'en' });
    assert.equal(hits(idx, 'alphaquartz'), 0, 'the old text must not be delivered');
    assert.equal(hits(idx, 'omegaquartz'), 1, 'the new text must be found');
    assert.equal(hits(idx, 'echoquartz'), 1, 'the appended entry must be found');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: a pure append to the same log stays incremental', () => {
  const r = root();
  try {
    corpus(r);
    for (let i = 0; i < 20; i += 1) memory.logEntry(r, TYPE, { title: `more ${i}`, why: 'w' });
    loadIndex(r, { language: 'en' });
    const { entry } = memory.logEntry(r, TYPE, { title: 'deltaquartz appended', why: 'later' });
    const idx = loadIndex(r, { language: 'en' });
    assert.equal(idx.fromCache, true, 'an append must not become a full rebuild');
    assert.equal(idx.appended, 1);
    assert.equal(search(idx, 'deltaquartz appended', { top: 3 })[0].entry.id, entry.id);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// ── equivalence ──────────────────────────────────────────────────────
const QUERIES = ['alphaquartz', 'omegaquartz', 'bravoquartz', 'charliequartz', 'echoquartz',
  'filler', 'corrected', 'start marker', 'entry', 'replacequartz', 'x'];

function ranking(idx) {
  return QUERIES.map((q) => search(idx, q, { top: 10 })
    .map((h) => `${h.source}:${h.line}:${h.entry?.id ?? '?'}`));
}

function fullBuild(r) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-o3-full-'));
  fs.cpSync(r, copy, { recursive: true });
  try { return ranking(loadIndex(copy, { language: 'en', fresh: true })); } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

test('EQUIVALENCE: appended index == full build after every step of an edit sequence', () => {
  const r = root();
  try {
    const f = corpus(r);
    loadIndex(r, { language: 'en' });
    let t = fs.statSync(f).mtimeMs;
    const tick = () => { t += 3000; const d = new Date(t); fs.utimesSync(f, d, d); };
    const steps = [
      ['append', () => memory.logEntry(r, TYPE, { title: 'echoquartz one', why: 'more' })],
      ['correction line', () => {
        const first = [...memory.iterLog(r, TYPE)].find((e) => /bravoquartz/.test(e.title));
        memory.logEntry(r, TYPE, { title: 'bravoquartz corrected', why: 'new', replaces_id: first.id });
      }],
      ['equal-length change at the front', () => {
        fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('start marker', 'start market')); tick();
      }],
      ['change at the front + append', () => {
        fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('alphaquartz', 'omegaquartz'));
        memory.logEntry(r, TYPE, { title: 'echoquartz two', why: 'more' });
      }],
      ['shrink', () => {
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(f, lines.slice(0, -1).join('\n') + '\n'); tick();
      }],
      ['replace the file', () => {
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        const tmp = `${f}.new`;
        fs.writeFileSync(tmp, lines.map((l) => l.replace('charliequartz', 'replacequartz!')).join('\n') + '\n');
        fs.renameSync(tmp, f);
      }],
      ['append after replace', () => memory.logEntry(r, TYPE, { title: 'echoquartz three', why: 'more' })],
    ];
    for (const [name, step] of steps) {
      step();
      assert.deepEqual(ranking(loadIndex(r, { language: 'en' })), fullBuild(r),
        `after step "${name}" the appended index differs from a full build`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
