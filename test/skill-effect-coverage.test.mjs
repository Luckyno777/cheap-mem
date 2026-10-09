// test/skill-effect-coverage.test.mjs - the skill offer -> fetch rate counts a
// window as covered only when the capture BEGAN before the offer AND reaches past
// its window (L5, port of lucky-mem `skillwirkung-fangbeginn`, 2026-10-03).
//
// Reason: only the END of the capture counted. Every offer made before the start of
// the one readable capture of its session counted as "not fetched" - in the
// sibling house "0 of 87" was a measuring artefact (really observed: 0 of 95).
//
// Red proof: at a FIXED base commit the same offers all count as observed.
// Positive controls: an offer inside the capture IS observed and a fetch IS counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as injection from '../src/injection.mjs';
import * as raw from '../src/raw.mjs';
import * as effect from '../src/skilleffect.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BASE = '0cec5683212e9721fdac0813f1561e50dbb6081f';
const T0 = Date.parse('2026-10-01T10:00:00Z');
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SESSION = 'real-session-1';

function world(t) {
  const root = tempDir('cm-effect-cov-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  const s = memory.logEntry(root, 'skill', { title: 'Publish', text: 'Publish - body', triggers: 'publish package,npm release' }).entry;
  memory.logEntry(root, 'skill', { status_of: s.id, status: 'released', issued_by: 'owner', agent: 'test' });
  return { root, skillId: s.id };
}

/** Ten hourly offers of one skill in one session, from T0 on. */
function bookOffers(root, skillId, n = 10) {
  for (let i = 0; i < n; i += 1) {
    injection.book(root, { ts: iso(T0 + i * HOUR), session: SESSION, occasion: injection.OCCASION.SKILL_OFFER, reason: null, bytes: 40, hits: 1, sources: [skillId] });
  }
}

/** One capture of the session whose readable lines run from `from` to `to`. */
function capture(root, from, to, extraLines = []) {
  const lines = [
    { type: 'user', timestamp: iso(from), message: { content: 'start' } },
    ...extraLines,
    { type: 'assistant', timestamp: iso(to), message: { content: [{ type: 'text', text: 'end' }] } },
  ];
  const stamp = raw.buildStamp({ sessionId: `s-${from}`, realSessionId: SESSION, tsFrom: iso(from), tsTo: iso(to), surface: 'local' });
  const header = { __stamp: stamp, __captured_at: iso(to), __redacted: 0 };
  const r = raw.storeCapture(root, { header, captured: lines, stamp, now: new Date(to), record: { ts_from: iso(from), ts_to: iso(to) } });
  assert.equal(r.status, 'stored', JSON.stringify(r));
}

const names = new Map([['k1', 'alpha']]);
const offers = (n = 10) => Array.from({ length: n }, (_, i) => ({ ts: iso(T0 + i * HOUR), session: 's', ids: ['k1'] }));

test('compute: a capture that begins after the offer does not cover it; the end alone no longer decides', () => {
  const cov = new Map([['s', [{ from: T0 + 5 * HOUR, to: T0 + 20 * HOUR }]]]);
  const r = effect.compute({ offers: offers(), fetches: [], coverage: cov, names });
  assert.equal(r.overall.observed, 5, 'the five offers before the capture began are not observed');
  assert.equal(r.overall.unobserved, 5);
  assert.equal(r.overall.notFetched, 5);
  // positive control: the same offers with a capture that began at the first offer are all observed
  const all = effect.compute({ offers: offers(), fetches: [], coverage: new Map([['s', [{ from: T0, to: T0 + 20 * HOUR }]]]), names });
  assert.equal(all.overall.observed, 10);
});

test('compute: pieces count only as far as they join; a gap in between is unmeasured; a bare number still means "end known"', () => {
  const joined = new Map([['s', [{ from: T0, to: T0 + 4.5 * HOUR }, { from: T0 + 4 * HOUR, to: T0 + 20 * HOUR }]]]);
  assert.equal(effect.compute({ offers: offers(), fetches: [], coverage: joined, names }).overall.observed, 10);
  const gap = new Map([['s', [{ from: T0, to: T0 + 3 * HOUR }, { from: T0 + 6 * HOUR, to: T0 + 20 * HOUR }]]]);
  const g = effect.compute({ offers: offers(), fetches: [], coverage: gap, names });
  assert.equal(g.overall.observed, 7, 'offers 4 and 5 sit in the gap (offer 3 needs half an hour past 3 h: also not covered)');
  assert.equal(effect.compute({ offers: offers(), fetches: [], coverage: new Map([['s', T0 + 20 * HOUR]]), names }).overall.observed, 10, 'the old numeric form');
});

test('compute: a fetch still counts for an offer inside the capture (positive control)', () => {
  const cov = new Map([['s', [{ from: T0 + 5 * HOUR, to: T0 + 20 * HOUR }]]]);
  const fetches = [{ session: 's', skill: 'k1', ms: T0 + 7 * HOUR + 60000 }];
  const r = effect.compute({ offers: offers(), fetches, coverage: cov, names, minN: 1 });
  assert.equal(r.overall.fetched, 1);
  assert.equal(r.overall.observed, 5);
});

test('measure(): the capture of the session begins at hour 5 - the five earlier offers are not observed (red at the base)', async (t) => {
  const { root, skillId } = world(t);
  bookOffers(root, skillId);
  capture(root, T0 + 5 * HOUR, T0 + 20 * HOUR, [{
    type: 'assistant', timestamp: iso(T0 + 7 * HOUR + 60000),
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node bin/mem skills fetch publish' } }] },
  }]);
  const now = effect.measure(root);
  assert.equal(now.capturesRead, 1, 'precondition: the capture was read');
  assert.equal(now.overall.observed, 5, JSON.stringify(now.overall));
  assert.equal(now.overall.unobserved, 5);
  assert.equal(now.overall.fetched, 1);
  // the base counts all ten as observed
  const tmp = tempDir('cm-effect-cov-base-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], tmp);
  const old = await import(pathToFileURL(path.join(tmp, 'src', 'skilleffect.mjs')).href);
  assert.equal(old.measure(root).overall.observed, 10, 'RED PROOF: the base counts every offer as observed');
});
