// y0 (2026-09-30): the index cache must not serve an equal-length in-place
// change that lies before the last 4 KiB (the tail hash cannot see it).
// mtimeMs/ctimeMs per file are part of the cache state; same size + other
// mtime/ctime = full rebuild. A normal append stays incremental.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIndex, search } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-y0c-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  return r;
}
const hits = (idx, q) => search(idx, q, { top: 5 }).length;

function corpus(r) {
  memory.logEntry(r, 'decision', { title: 'alphaquartz first entry', why: 'start marker' });
  for (let i = 0; i < 8; i += 1) {
    memory.logEntry(r, 'decision', { title: `filler ${i}`, why: 'x'.repeat(700) });
  }
  memory.logEntry(r, 'decision', { title: 'bravoquartz middle entry', why: 'middle marker' });
  for (let i = 0; i < 8; i += 1) {
    memory.logEntry(r, 'decision', { title: `filler more ${i}`, why: 'y'.repeat(700) });
  }
  memory.logEntry(r, 'decision', { title: 'charliequartz last entry', why: 'end marker' });
  return memory.logPath(r, 'decision', null);
}

for (const [where, from, to] of [
  ['start', 'alphaquartz', 'omegaquartz'],
  ['middle', 'bravoquartz', 'tangoquartz'],
  ['end', 'charliequartz', 'foxtrotquartz'],
]) {
  test(`equal-length change at the ${where} is never served as the old hit`, () => {
    const r = root();
    try {
      const f = corpus(r);
      assert.ok(fs.statSync(f).size > 8192, 'the log must be larger than the tail window');
      loadIndex(r, { language: 'en' });
      const warm = loadIndex(r, { language: 'en' });
      assert.equal(warm.fromCache, true);
      assert.equal(hits(warm, from), 1, 'control: the old marker is found before the change');

      const before = fs.statSync(f);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to));
      assert.equal(fs.statSync(f).size, before.size, 'the size must be identical');
      // Coarse kernel timestamp ticks could give the same mtime within a
      // few ms: make the difference explicit, as a later edit would have.
      const t = new Date(before.mtimeMs + 3000);
      fs.utimesSync(f, t, t);

      const idx = loadIndex(r, { language: 'en' });
      assert.equal(hits(idx, from), 0, 'the old text must not be delivered');
      assert.equal(hits(idx, to), 1, 'the new text must be found');
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  });
}

test('POSITIVE CONTROL: a normal append stays incremental (fromCache + appended)', () => {
  const r = root();
  try {
    corpus(r);
    for (let i = 0; i < 20; i += 1) memory.logEntry(r, 'decision', { title: `more ${i}`, why: 'w' });
    loadIndex(r, { language: 'en' });
    const { entry } = memory.logEntry(r, 'error', { title: 'deltaquartz appended', text: 'later' });
    const idx = loadIndex(r, { language: 'en' });
    assert.equal(idx.fromCache, true, 'an append must not become a full rebuild');
    assert.equal(idx.appended, 1);
    assert.equal(search(idx, 'deltaquartz appended', { top: 3 })[0].entry.id, entry.id);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('an untouched corpus is served from cache (no needless rebuild)', () => {
  const r = root();
  try {
    corpus(r);
    loadIndex(r, { language: 'en' });
    const idx = loadIndex(r, { language: 'en' });
    assert.equal(idx.fromCache, true);
    assert.equal(idx.appended, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
