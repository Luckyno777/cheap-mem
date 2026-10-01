// y0 (2026-09-30): done/failed carry the claim id. An old process of the same
// actor, resumed after expiry, must not close the NEW claim.
// Red proof: at the fixed start commit 201a087f (before y0) done() takes no
// claim id, so the stale done closes the new claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as inbox from '../src/inbox.mjs';
import * as c from '../src/claim.mjs';
import { tempDir } from './temp-dir.mjs';

const START_COMMIT = '201a087f2d2f634f9b061f4681bd1f78f27408be';
const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };
const T0 = new Date('2026-09-30T10:00:00.000Z');
const min = (n) => new Date(T0.getTime() + n * 60_000);

function message(t) {
  const root = tempDir('cheap-mem-claim-y0-', t);
  const w = inbox.write(root, PARTS, {
    from: 'session', to: 'librarian', subject: 'please check', text: 'Body.', now: T0,
  });
  return { root, name: w.name };
}

test('red proof: the start commit has no claim id in done()', (t) => {
  let src;
  try { src = execFileSync('git', ['show', `${START_COMMIT}:src/claim.mjs`], { encoding: 'utf8', stdio: 'pipe' }); }
  catch { t.skip('start commit not in this clone — unknown, not green'); return; }
  assert.equal(/claimId|claim_id/.test(src.replace(/\/\*\*[\s\S]*?\*\//g, '')), false);
});

test('REGRESSION: an old process with the old id after resumption -> invalid, the new claim stays open', (t) => {
  const { root, name } = message(t);
  const old = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  const created = c.claim(root, name, { by: 'agentA', minutes: 30, now: min(31) });
  assert.notEqual(old.id, created.id);
  const r = c.done(root, name, { by: 'agentA', claimId: old.id, now: min(32) });
  assert.equal(r.valid, false);
  assert.match(r.reason, /old or foreign/);
  assert.equal(r.status, c.STATUS.CLAIMED, 'the new claim is still open');
  assert.equal(r.holder.id, created.id);
  assert.equal(r.invalid.some((u) => u.id === r.id && /not the valid claim/.test(u.reason)), true, 'named with a reason, never silent');
  // same for failed: must not release the new claim
  const f = c.failed(root, name, { by: 'agentA', claimId: old.id, reason: 'late', now: min(33) });
  assert.equal(f.valid, false);
  assert.equal(f.status, c.STATUS.CLAIMED);
  assert.deepEqual(f.failures, []);
});

test('POSITIVE CONTROL: done with the right id closes; failed with the right id releases', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'a', now: T0 });
  const d = c.done(root, name, { by: 'a', claimId: a.id, now: min(1) });
  assert.equal(d.valid, true);
  assert.equal(d.status, c.STATUS.DONE);
  const m2 = message(t);
  const b = c.claim(m2.root, m2.name, { by: 'a', now: T0 });
  const f = c.failed(m2.root, m2.name, { by: 'a', claimId: b.id, reason: 'x', now: min(1) });
  assert.equal(f.valid, true);
  assert.equal(f.status, c.STATUS.FREE);
});

test('done/failed without a claim id are refused by the API', (t) => {
  const { root, name } = message(t);
  c.claim(root, name, { by: 'a', now: T0 });
  assert.throws(() => c.done(root, name, { by: 'a', now: min(1) }), /claim_id/);
  assert.throws(() => c.failed(root, name, { by: 'a', reason: 'x', now: min(1) }), /claim_id/);
});

test('a line with NO claim id (old data) reads as "unproven": does not count, stands in invalid', () => {
  const claimLine = { kind: 'claim', message: 'm.md', claimed_by: 'a', until: min(30).toISOString(), time: T0.toISOString(), id: 'aaaaaaaaaaaa' };
  const noId = { kind: 'done', message: 'm.md', by: 'a', time: min(1).toISOString(), id: 'dddddddddddd' };
  const s = c.fold([claimLine, noId], { now: min(2) });
  assert.equal(s.status, c.STATUS.CLAIMED);
  assert.equal(s.invalid.length, 1);
  assert.match(s.invalid[0].reason, /unproven/);
  const withId = c.fold([claimLine, { ...noId, claim_id: 'aaaaaaaaaaaa' }], { now: min(2) });
  assert.equal(withId.status, c.STATUS.DONE);
});

test('a done line whose claim_id is not a string is a broken line, not a lenient one', (t) => {
  const { root, name } = message(t);
  c.claim(root, name, { by: 'a', now: T0 });
  fs.appendFileSync(c.filePath(root), `${JSON.stringify({ kind: 'done', message: name, by: 'a', claim_id: 5, time: min(1).toISOString(), id: 'eeeeeeeeeeee' })}\n`);
  const s = c.status(root, name, { now: min(2) });
  assert.equal(s.broken.length, 1);
  assert.equal(s.status, c.STATUS.CLAIMED);
});
