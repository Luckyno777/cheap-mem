// Asking for an id means asking for ONE entry.
//
// **The finding (2026-09-08, reported by a connected agent.)** It wrote
// an entry over the bridge and then looked for it with `mem_find <id>`:
// ZERO hits, even after waiting. The literal search found it at once —
// but a bridge agent does not have that one. `mem_find` is ranked and
// nothing else.
//
// Cause: the exact-identifier lane knows five shapes (path, version,
// hyphenated name, number, env var). An entry id matches none of them.
//
// So "write it and find it again" — the loop the whole onboarding check
// rests on — could not be closed over the bridge. And worse: the check
// reported it green anyway, because it asked the LITERAL lane. Two
// faults that covered for each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as onboarding from '../src/onboarding.mjs';
import * as cfgmod from '../src/config.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-idlane-'));
  spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return root;
}
function fill(root, n = 12) {
  for (let i = 0; i < n; i += 1) {
    memory.logEntry(root, 'learning', { title: `filler ${i}`, text: `something about topic ${i}` });
  }
}

test('THE FIX: the ranked search finds an entry by its id', () => {
  const w = world();
  try {
    fill(w);
    const { entry } = memory.logEntry(w, 'thought', { text: 'the probe', agent: 'chatgpt' });
    const hits = search.search(search.buildIndex(w), entry.id, { top: 5, minScore: 0 });
    assert.equal(hits.length, 1, 'the id does not find exactly one');
    assert.equal(hits[0].entry.id, entry.id);
    assert.deepEqual(hits[0].exact, ['id'], 'the hit does not say WHY it is one');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('an invented id returns NOTHING rather than something', () => {
  // Otherwise the lane would be worse than its absence: it would
  // answer a question about one particular entry with an arbitrary one.
  const w = world();
  try {
    fill(w);
    assert.deepEqual(
      search.search(search.buildIndex(w), 'doesnotexist0815', { top: 5, minScore: 0 }), []);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE BOUNDARY: an ordinary word stays an ordinary query', () => {
  // A pattern for "six to twenty alphanumerics" would swallow half a
  // dictionary. Hence a lookup, not a pattern: the id lane only bites
  // when the string REALLY is an id we hold.
  const w = world();
  try {
    for (let i = 0; i < 6; i += 1) {
      memory.logEntry(w, 'learning', { title: `capture ${i}`, text: 'something about capture' });
    }
    const hits = search.search(search.buildIndex(w), 'capture', { top: 10, minScore: 0 });
    assert.ok(hits.length > 1, 'an everyday word was treated as an id');
    assert.ok(!hits.some((h) => h.exact?.includes('id')));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('a retired entry does not come back through its id either', () => {
  const w = world();
  try {
    fill(w);
    const { entry } = memory.logEntry(w, 'thought', { text: 'not after all' });
    spawnSync('node', [MEM, '--root', w, 'discard', entry.id, '--why', 'no'],
      { encoding: 'utf8', timeout: 30000 });
    assert.deepEqual(search.search(search.buildIndex(w), entry.id, { top: 5, minScore: 0 }), [],
      'a withdrawn entry comes back through its id');
    assert.equal(search.search(search.buildIndex(w), entry.id,
      { top: 5, minScore: 0, withRetired: true }).length, 1);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('the loop only holds while the probe entry holds', () => {
  const w = world();
  try {
    const { entry } = memory.logEntry(w, 'thought',
      { text: 'the probe', tags: [onboarding.PROBE_TAG], agent: 'newcomer' });
    const parts = cfgmod.readConfig(w).participants;
    assert.equal(onboarding.status(w, 'newcomer', { participants: parts }).steps.loop.state, 'green');
    spawnSync('node', [MEM, '--root', w, 'discard', entry.id, '--why', 'no'],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(onboarding.status(w, 'newcomer', { participants: parts }).steps.loop.state, 'red');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE LATCH: onboarding asks the RANKED lane, not the literal one', () => {
  // **Why this is a source test and not a behaviour test.**
  //
  // With the id lane in place BOTH lanes now find the same entry — the
  // mix-up is no longer visible in behaviour. The sabotage run on
  // 2026-09-08 showed exactly that: reverting the check to
  // `memory.find` left every test green.
  //
  // It only becomes visible again once the id lane fails — i.e. in the
  // damage case, by which time it is too late. A bridge agent has ONLY
  // the ranked lane, so what is checked here is a property of the test
  // bench itself, and that lives in the source.
  const src = fs.readFileSync(new URL('../src/onboarding.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('function checkLoop');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.match(body, /search\.search\(/,
    'the loop step does not ask the ranked lane — a bridge agent has no other');
  assert.ok(!/memory\.find\(/.test(body),
    'the loop step asks the literal lane, which a bridge agent does not have');
});
