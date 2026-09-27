import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cfg from '../src/config.mjs';

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-cfg-')); }

test('readConfig throws ENOCONFIG when missing', () => {
  const root = tmpRoot();
  let err;
  try { cfg.readConfig(root); } catch (e) { err = e; }
  assert.ok(err, 'should throw');
  assert.equal(err.code, 'ENOCONFIG');
});

test('writeConfig + readConfig round-trip', () => {
  const root = tmpRoot();
  cfg.writeConfig(root, { ...cfg.DEFAULT_CONFIG, participants: { me: 'the human' } });
  const r = cfg.readConfig(root);
  assert.equal(r.participants.me, 'the human');
});

test('readConfig fails loudly on invalid JSON', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.mem'));
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{ broken');
  assert.throws(() => cfg.readConfig(root), /not valid JSON/);
});

test('findRoot walks up', () => {
  const root = tmpRoot();
  cfg.writeConfig(root, cfg.DEFAULT_CONFIG);
  const sub = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(cfg.findRoot(sub), root);
});

test('findRoot returns null when no config anywhere up', () => {
  const root = tmpRoot();  // no config written
  assert.equal(cfg.findRoot(root), null);
});

// -----------------------------------------------------------------------
// humanParticipant() / isHuman() / roleOf() — see the module header for
// why "human": true is the only way a participant is the human, never
// a name (design rule 3: no participant names hardcoded in src/).
// -----------------------------------------------------------------------

test('roleOf: reads the description whichever shape the value has', () => {
  assert.equal(cfg.roleOf('a plain description'), 'a plain description');
  assert.equal(cfg.roleOf({ role: 'an object description', human: true }), 'an object description');
  assert.equal(cfg.roleOf({ human: true }), '', 'no role text at all is empty, not undefined/throw');
  assert.equal(cfg.roleOf(null), '');
  assert.equal(cfg.roleOf(undefined), '');
});

test('isHuman: true only for the object shape with human: true, never guessed from a value', () => {
  assert.equal(cfg.isHuman({ human: true }), true);
  assert.equal(cfg.isHuman({ human: false }), false);
  assert.equal(cfg.isHuman({ role: 'The human.' }), false, 'no human field at all is not human');
  assert.equal(cfg.isHuman('The human.'), false, 'a plain string is never human, whatever it says');
  assert.equal(cfg.isHuman(null), false);
  assert.equal(cfg.isHuman(undefined), false);
});

test('humanParticipant: exactly one marked -> that name, no reason', () => {
  const r = cfg.humanParticipant({ lucky: { human: true }, session: 'a session' });
  assert.deepEqual(r, { name: 'lucky', reason: null });
});

test('humanParticipant: none marked -> unknown, with a reason naming the fix', () => {
  const r = cfg.humanParticipant({ user: 'The human.', session: 'a session' });
  assert.equal(r.name, null);
  assert.match(r.reason, /"human": true/);
});

test('humanParticipant: two marked -> refused, not the first one picked silently', () => {
  const r = cfg.humanParticipant({ a: { human: true }, b: { human: true }, c: 'not it' });
  assert.equal(r.name, null);
  assert.match(r.reason, /2 participants/);
  assert.match(r.reason, /a/);
  assert.match(r.reason, /b/);
});

test('humanParticipant: no participants object at all -> "no memory config here", not a throw', () => {
  assert.deepEqual(cfg.humanParticipant(null), { name: null, reason: 'no memory config here' });
  assert.deepEqual(cfg.humanParticipant(undefined), { name: null, reason: 'no memory config here' });
});

test('DEFAULT_CONFIG marks "user" human, so a fresh `mem init` keeps working', () => {
  assert.deepEqual(
    cfg.humanParticipant(cfg.DEFAULT_CONFIG.participants),
    { name: 'user', reason: null },
  );
});
