// Z2 (2026-09-30): A4 renew keeps a long task valid; A12 orphaned claims
// become a doctor finding. Red proof against the FIXED start commit
// aa31bbc8 (before Z2): there `claim.renew` does not exist and
// `claim.orphaned()` has no caller in src/doctor.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as inbox from '../src/inbox.mjs';
import * as c from '../src/claim.mjs';
import * as doctor from '../src/doctor.mjs';
import { tempDir } from './temp-dir.mjs';

const START_COMMIT = 'aa31bbc8552bb79cffb4b7cc374bdfe2e51059eb';
const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };
const T0 = new Date('2026-09-30T10:00:00.000Z');
const min = (n) => new Date(T0.getTime() + n * 60_000);
const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

function message(t) {
  const root = tempDir('cheap-mem-z2-claim-', t);
  const w = inbox.write(root, PARTS, {
    from: 'session', to: 'librarian', subject: 'please check', text: 'Body.', now: T0,
  });
  return { root, name: w.name };
}
const stripComments = (src) => src.replace(/\/\*\*[\s\S]*?\*\//g, '');
function oldSource(file) {
  return execFileSync('git', ['show', `${START_COMMIT}:${file}`], { encoding: 'utf8', stdio: 'pipe' });
}

test('red proof: the start commit has no renew and no caller of orphaned(); the current tree has both', (t) => {
  let oldClaim; let oldDoctor;
  try { oldClaim = oldSource('src/claim.mjs'); oldDoctor = oldSource('src/doctor.mjs'); }
  catch { t.skip('start commit not in this clone — unknown, not green'); return; }
  assert.equal(/export function renew\b/.test(oldClaim), false, 'old: no renew');
  assert.equal(/claim\.orphaned\(|orphaned\(root/.test(stripComments(oldDoctor)), false, 'old: orphaned() has no caller');
  // positive control: the same patterns DO match the current tree, so the probe can see
  assert.equal(/export function renew\b/.test(fs.readFileSync(new URL('../src/claim.mjs', import.meta.url), 'utf8')), true);
  assert.equal(/claim\.orphaned\(/.test(stripComments(fs.readFileSync(new URL('../src/doctor.mjs', import.meta.url), 'utf8'))), true);
});

test('renew keeps a long task valid: a second claim stays invalid, done is NOT late', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  const r1 = c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 30, now: min(25) });
  assert.equal(r1.valid, true, r1.reason);
  assert.equal(r1.holder.until, min(55).toISOString());
  assert.equal(r1.renewals, 1);
  assert.equal(c.check(root, name, a.id, { now: min(50) }).valid, true, 'still valid after the original until');
  const other = c.claim(root, name, { by: 'agentB', minutes: 30, now: min(40) });
  assert.equal(other.valid, false, 'a claim during the renewed lease is still a second, invalid one');
  const r2 = c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 30, now: min(50) });
  assert.equal(r2.valid, true, r2.reason);
  const d = c.done(root, name, { by: 'agentA', claimId: a.id, now: min(70) });
  assert.equal(d.valid, true);
  assert.equal(d.status, c.STATUS.DONE);
  assert.equal(d.late, false, 'inside the renewed lease: not late');
});

test('CONTRAST: without renew the same done at minute 70 is late', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  const d = c.done(root, name, { by: 'agentA', claimId: a.id, now: min(70) });
  assert.equal(d.late, true);
});

test('renew AFTER expiry is invalid, with the reason; the claim is not revived', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  const r = c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 30, now: min(31) });
  assert.equal(r.valid, false);
  assert.match(r.reason, /expired .*cannot be revived/);
  assert.equal(r.status, c.STATUS.EXPIRED);
  assert.equal(r.holder.until, min(30).toISOString(), 'until unchanged');
  assert.equal(r.invalid.some((u) => u.id === r.id && u.kind === c.KIND.RENEW), true, 'stands in invalid, never silent');
});

test('renew of a REPLACED claim id is invalid; the new holder is untouched', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  const b = c.claim(root, name, { by: 'agentB', minutes: 30, now: min(31) });
  assert.equal(b.valid, true);
  const r = c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 30, now: min(32) });
  assert.equal(r.valid, false);
  assert.match(r.reason, /old or replaced|not the holder/);
  assert.equal(r.holder.id, b.id);
  assert.equal(r.holder.until, min(61).toISOString());
  // even the same actor with an old id (y0 shape)
  const a2 = c.claim(root, name, { by: 'agentB', minutes: 30, now: min(70) });
  const r2 = c.renew(root, name, { by: 'agentB', claimId: b.id, minutes: 30, now: min(71) });
  assert.equal(r2.valid, false);
  assert.match(r2.reason, /old or replaced/);
  assert.equal(r2.holder.id, a2.id);
});

test('the cap holds: total extension beyond the original until is MAX_EXTENSION_MIN', (t) => {
  assert.equal(c.MAX_EXTENSION_MIN, 4 * c.DEFAULT_MINUTES);
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  // one huge renew is refused whole, not clamped
  const big = c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 500, now: min(1) });
  assert.equal(big.valid, false);
  assert.match(big.reason, /over the cap/);
  assert.equal(big.holder.until, min(30).toISOString());
  // small renews walk up to the cap: until 30 -> 59 -> 88 -> 117 -> 146
  for (const at of [29, 58, 87, 116]) {
    const r = c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 30, now: min(at) });
    assert.equal(r.valid, true, `renew at ${at}: ${r.reason}`);
  }
  // cap = 30 + 120 = 150
  const over = c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 30, now: min(145) });
  assert.equal(over.valid, false);
  assert.match(over.reason, /over the cap/);
  const exact = c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 5, now: min(145) });
  assert.equal(exact.valid, true, exact.reason);
  assert.equal(exact.holder.until, min(150).toISOString());
  assert.equal(exact.renewals, 5);
});

test('renew that does not extend, by a stranger, or after done is invalid', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  assert.match(c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 5, now: min(1) }).reason, /no extension/);
  assert.match(c.renew(root, name, { by: 'agentB', claimId: a.id, minutes: 30, now: min(2) }).reason, /not the holder/);
  assert.throws(() => c.renew(root, name, { by: 'agentA', claimId: 'nope', now: min(3) }), /claim_id/);
  c.done(root, name, { by: 'agentA', claimId: a.id, now: min(4) });
  assert.match(c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 30, now: min(5) }).reason, /already done/);
});

test('POSITIVE CONTROL: the normal path without renew is as before (claim, done)', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  assert.equal(a.valid, true);
  const d = c.done(root, name, { by: 'agentA', claimId: a.id, now: min(5) });
  assert.equal(d.valid, true);
  assert.equal(d.status, c.STATUS.DONE);
  assert.equal(d.renewals, 0);
  assert.equal(doctor.checkOrphanedClaims(root, { now: min(500) }).level, 'good');
});

test('finding claim-orphaned: an orphaned claim is a WARN with count, oldest and the way, never an action', (t) => {
  const { root, name } = message(t);
  const w2 = inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 'second', text: 'x', now: min(1) });
  c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  c.claim(root, w2.name, { by: 'agentB', minutes: 30, now: min(5) });
  const before = fs.readFileSync(c.filePath(root), 'utf8');
  // inside the lease: good
  assert.equal(doctor.checkOrphanedClaims(root, { now: min(10) }).level, 'good');
  const f = doctor.checkOrphanedClaims(root, { now: min(40) });
  assert.equal(f.name, 'claim-orphaned');
  assert.equal(f.level, 'warn');
  assert.match(f.text, /2 claims expired/);
  assert.ok(f.text.includes(name), 'names the oldest');
  assert.match(f.advice, /check FIRST whether the effect already happened/);
  assert.match(f.advice, /mem inbox claim /);
  assert.equal(fs.readFileSync(c.filePath(root), 'utf8'), before, 'the finding writes nothing');
});

test('finding claim-orphaned: a renewed claim is not orphaned until the NEW until passes; done/failed close it', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'agentA', minutes: 30, now: T0 });
  c.renew(root, name, { by: 'agentA', claimId: a.id, minutes: 30, now: min(25) });
  assert.equal(doctor.checkOrphanedClaims(root, { now: min(40) }).level, 'good');
  assert.equal(doctor.checkOrphanedClaims(root, { now: min(60) }).level, 'warn');
  c.failed(root, name, { by: 'agentA', claimId: a.id, reason: 'gave up', now: min(61) });
  assert.equal(doctor.checkOrphanedClaims(root, { now: min(90) }).level, 'good');
});

test('finding claim-orphaned: unreadable claims file is UNKNOWN; broken lines are ERROR; no file is good', (t) => {
  const { root } = message(t);
  assert.equal(doctor.checkOrphanedClaims(root).level, 'good', 'nothing ever claimed');
  fs.mkdirSync(c.filePath(root)); // a directory where the file should be
  const u = doctor.checkOrphanedClaims(root);
  assert.equal(u.level, 'unknown');
  assert.match(u.text, /unreadable/);
  const r2 = tempDir('cheap-mem-z2-claim-broken-', t);
  fs.mkdirSync(path.join(r2, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(r2, 'inbox', c.FILE), '{not json\n');
  const e = doctor.checkOrphanedClaims(r2);
  assert.equal(e.level, 'error');
  assert.ok(e.advice);
});

test('CLI: inbox renew extends, prints the count, and an invalid renew exits 1', (t) => {
  const root = tempDir('cheap-mem-z2-claim-cli-', t);
  const mem = (...a) => spawnSync(process.execPath, [MEM, ...a, '--root', root], { encoding: 'utf8', input: 'body\n' });
  assert.equal(mem('init').status, 0);
  assert.equal(mem('inbox', 'write', '--as', 'session', '--to', 'librarian', '--subject', 'hi').status, 0);
  const name = fs.readdirSync(path.join(root, 'inbox')).find((f) => f.endsWith('.md'));
  const id = /claim-id ([0-9a-f]{12})/.exec(mem('inbox', 'claim', name, '--as', 'librarian', '--minutes', '1').stdout)[1];
  const r = mem('inbox', 'renew', name, '--as', 'librarian', '--claim-id', id, '--minutes', '10');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /renewed 1x/);
  assert.match(mem('inbox', 'claims', name).stdout, /renewed 1x/);
  const bad = mem('inbox', 'renew', name, '--as', 'librarian', '--claim-id', '0123456789ab', '--minutes', '10');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /does NOT count/);
  assert.notEqual(mem('inbox', 'renew', name, '--as', 'librarian').status, 0, 'the claim id is required');
});
