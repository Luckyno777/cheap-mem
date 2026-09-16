// `_source` is data other people read — so it is spelled one way.
//
// It travels further than it looks: into the evidence line of a note
// `broadcast` drops in another agent's inbox, into what `mem` prints, and
// into the `sources` an injection names — which `gauges.afterLook` then
// compares against the paths it sees in tool calls.
//
// Until 2026-09-16 all three took it from `path.relative`, which answers
// in the host separator. On the Windows runner the evidence line read
// `global\learnings.jsonl:1`, the note's own test called it missing, and
// the gauge could never report READ_NAMED — a measurement reading zero
// for a reason that has nothing to do with what it measures.
//
// invariant: trenner-nicht-fest-verdrahten
// invariant: fremder-pfad-wird-normalisiert
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-src-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 's' }));
  memory.logEntry(r, 'learning', { topic: 't', title: 'a', text: 'needle here' });
  memory.logEntry(r, 'decision', { topic: 't', choice: 'b', why: 'needle again' },
    { project: 'alpha' });
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

test('no _source carries a native separator, wherever it was produced', () => {
  const r = world();
  try {
    const seen = [];
    for (const h of memory.find(r, 'needle', {})) seen.push(h._source);
    for (const e of Object.values(memory.entriesById(r))) if (e._source) seen.push(e._source);
    assert.ok(seen.length >= 2, 'the fixture produced no sources — nothing was measured');
    for (const s of seen) {
      assert.doesNotMatch(s, /\\/, `native separator in _source: ${s}`);
      assert.match(s, /\//, `no separator at all, so nothing was nested: ${s}`);
    }
  } finally { away(r); }
});

test('canonicalSep is handed the Windows shape and returns the canonical one', () => {
  // The two tests above run on this host, where `path.relative` never
  // produces a backslash — so they pass whether the normaliser works or
  // not. Reverting it to `split(path.sep)` leaves them green and breaks
  // Windows again. Only the pure function can be given the other shape,
  // which is the whole reason it is a separate export.
  assert.equal(memory.canonicalSep('global\\learnings.jsonl'), 'global/learnings.jsonl');
  assert.equal(memory.canonicalSep('projects\\alpha\\decisions.jsonl'),
    'projects/alpha/decisions.jsonl');
  assert.equal(memory.canonicalSep('global/learnings.jsonl'), 'global/learnings.jsonl',
    'a path that is already canonical must come back untouched');
});

test('asSource runs its result through canonicalSep', () => {
  assert.equal(memory.asSource('/root', '/root/global/learnings.jsonl'),
    'global/learnings.jsonl');
});

test('a source still points at a file that is really there', () => {
  // The normalisation must not turn into "produce a nice-looking string".
  // Forward slashes resolve on both platforms, so this holds everywhere.
  const r = world();
  try {
    const hits = memory.find(r, 'needle', {});
    assert.ok(hits.length > 0, 'nothing found — the fixture, not the property');
    for (const h of hits) {
      assert.ok(fs.existsSync(path.join(r, h._source)),
        `_source points nowhere: ${h._source}`);
    }
  } finally { away(r); }
});
