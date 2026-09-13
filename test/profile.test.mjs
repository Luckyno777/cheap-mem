// Measuring points that cost nothing when off and do not lie when on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as profile from '../src/profile.mjs';

function sink() {
  const lines = [];
  return { lines, write: (s) => lines.push(s) };
}

test('only the exact "1" switches it on', () => {
  assert.equal(profile.on({ CHEAP_MEM_PROFILE: '1' }), true);
  for (const v of ['true', 'yes', 'on', '0', '', ' 1', '1 ', undefined]) {
    assert.equal(profile.on({ CHEAP_MEM_PROFILE: v }), false, `switched on by ${JSON.stringify(v)}`);
  }
  assert.equal(profile.on({}), false);
});

test('off: no line, and the result passes through unchanged', () => {
  const s = sink();
  assert.equal(profile.measure('p', 's', () => 42, { env: {}, write: s.write }), 42);
  assert.deepEqual(s.lines, [], 'wrote a line while switched off');
});

test('on: one greppable line with phase, section and duration', () => {
  const s = sink();
  profile.measure('index', 'raw', () => null, { env: { CHEAP_MEM_PROFILE: '1' }, write: s.write });
  assert.equal(s.lines.length, 1);
  assert.match(s.lines[0], /^msg=prof /, 'without a fixed prefix it is not greppable');
  assert.match(s.lines[0], /phase=index/);
  assert.match(s.lines[0], /sub=raw/);
  assert.match(s.lines[0], /\bms=\d+/);
});

test('without a count there is NO rate', () => {
  // A rate computed from an invented count is worse than no rate.
  const l = profile.line({ phase: 'p', sub: 's', ms: 10 });
  assert.ok(!/items=/.test(l), l);
  assert.ok(!/rate_per_s=/.test(l), l);
});

test('an unusable count is dropped, not rescued', () => {
  const s = sink();
  profile.measure('p', 's', () => 'no counter', {
    env: { CHEAP_MEM_PROFILE: '1' }, write: s.write, count: () => NaN,
  });
  assert.ok(!/items=/.test(s.lines[0]), s.lines[0]);
});

test('a section that threw carries err=1 — and rethrows', () => {
  // Without the mark, a run that aborted halfway reads as a fast one.
  const s = sink();
  assert.throws(() => profile.measure('p', 's', () => { throw new Error('boom'); },
    { env: { CHEAP_MEM_PROFILE: '1' }, write: s.write }), /boom/);
  assert.equal(s.lines.length, 1, 'an abort was not reported at all');
  assert.match(s.lines[0], /err=1/);
  assert.ok(!/items=/.test(s.lines[0]), 'an abort must not claim a count');
});

test('the rate agrees with ms and items', () => {
  const l = profile.line({ phase: 'p', sub: 's', ms: 2000, items: 500 });
  assert.match(l, /items=500/);
  assert.match(l, /rate_per_s=250/);
});

test('the index build is actually instrumented', () => {
  // Otherwise the module exists and measures nothing — a tool nobody
  // wired in looks exactly like one that finds nothing.
  const src = fs.readFileSync(new URL('../src/search.mjs', import.meta.url), 'utf8');
  assert.match(src, /profile\.measure\('index', 'raw'/,
    'the expensive section (raw captures) is not measured');
});
