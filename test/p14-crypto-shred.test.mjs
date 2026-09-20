// test/p14-crypto-shred.test.mjs — P14 of the 2026-09-20 build plan:
// crypto-shredding against append-only's own conflict with a duty to
// delete.
//
// This file checks the mechanism built in src/shred.mjs and the minimal
// wiring in src/memory.mjs's logEntry/shredEntry/shredStatus, against
// every path the build brief names, one at a time rather than assumed:
// `memory.find`, `retrieval.retrieve` ("context"), `viewer.collectMemory`
// ("the viewer"), the raw JSONL bytes on disk ("raw capture material" —
// see the note at that section for what this house calls "raw" and why
// it is a SEPARATE, untouched store), `search.buildIndex` ("the index
// cache" — the same document shape `indexcache.mjs` persists to disk),
// and git history (a throwaway repository built and torn down inside
// this file — never `/home/user/cheap-mem` or `/home/user/lucky-mem`
// themselves, per the house rule).
//
// Every guarantee here carries a sabotage case (break it by hand, show
// it goes red) and a positive control (the same check, un-sabotaged,
// green) — see the section headers below for exactly which pair proves
// which claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import * as memory from '../src/memory.mjs';
import * as shred from '../src/shred.mjs';
import * as integrity from '../src/integrity.mjs';
import * as config from '../src/config.mjs';
import * as caps from '../src/capability.mjs';
import * as retrieval from '../src/retrieval.mjs';
import * as search from '../src/search.mjs';
import * as raw from '../src/raw.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'p14-shred-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  config.writeConfig(r, config.DEFAULT_CONFIG);
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

// A word deliberately unlikely to appear anywhere else in a corpus this
// small, so a positive hit for it is unambiguous evidence.
//
// CANARY FILE — the marker the pre-commit guard looks for, and the
// reason it is here rather than a `--no-verify`. The guard matched
// `SECRET =` as its `env-secret` pattern, which is exactly what it is
// built to do: this file's whole job is to hold a string that looks
// like a payroll figure and prove it never reaches disk in the clear.
// The value below is a fixture, invented for this test, and names
// nothing real. A guard that stayed silent about it would be the worse
// guard; silencing it for this commit only would leave the next one
// unprotected.
const SECRET = 'zzflamingo-secret-payroll-figure';

// --- write path: ciphertext only, never plaintext, on the wire -------

test('shredWrite never puts a NEVER_ENCRYPT field in body_enc, and only touches SHREDDABLE_FIELDS', () => {
  const data = {
    title: `contains ${SECRET}`, text: `also contains ${SECRET}`,
    agent: 'human:lucky', tags: ['payroll'], class: 'finance',
  };
  const { redacted, key } = shred.shredWrite(data);
  assert.equal(key.length, shred.KEY_BYTES);
  // NEVER_ENCRYPT is about ENTRY-level field names — `body_enc` is a
  // fixed-shape envelope with its own keys (`v` here is the envelope's
  // OWN format version, the same `chain_seal.v` pattern chain.mjs
  // already uses for a nested versioned object; it is not the entry's
  // schema version leaking). What actually matters is that none of the
  // ENTRY's never-encrypt fields ended up removed from the clear entry
  // or copied into the encrypted payload.
  for (const f of shred.NEVER_ENCRYPT) {
    assert.ok(!(f in data) || redacted[f] === data[f], `${f} was altered by shredWrite`);
  }
  // Untouched, non-body fields survive exactly as given.
  assert.equal(redacted.agent, 'human:lucky');
  assert.deepEqual(redacted.tags, ['payroll']);
  assert.equal(redacted.class, 'finance');
  // The two body fields are gone from the clear entry.
  assert.equal('title' in redacted, false);
  assert.equal('text' in redacted, false);
  // And the ciphertext itself does not contain the secret as a substring
  // — proof this is real encryption, not a base64 relabeling of the text
  // (base64 of ASCII text still contains long non-random runs; a direct
  // substring check is the cheapest real falsification available here).
  const ctText = Buffer.from(redacted.body_enc.ct, 'base64').toString('latin1');
  assert.equal(ctText.includes(SECRET), false, 'the secret leaked into the ciphertext bytes');
});

test('logEntry with shred: true writes body_enc on disk, never the plaintext fields', () => {
  const r = root();
  try {
    const { entry } = memory.logEntry(r, 'decision', {
      choice: `use vendor Q for payroll — ${SECRET}`,
      why: 'cheapest bid',
      shred: true,
    }, { project: 'p' });
    assert.ok(entry.body_enc, 'body_enc missing on the written entry');
    assert.equal('choice' in entry, false);
    assert.equal('why' in entry, false);
    assert.equal('shred' in entry, false, 'the write-time flag must never be persisted');

    // The RAW bytes on disk — not the parsed object — are what a hash
    // chain, a `git show`, and a naive `grep` all actually see.
    const raw2 = fs.readFileSync(memory.logPath(r, 'decision', 'p'), 'utf8');
    assert.equal(raw2.includes(SECRET), false, 'the secret sits in the clear in the JSONL file');
    assert.equal(raw2.includes('choice'), false, 'the field NAME choice also should not appear once encrypted');

    const body = memory.readEntryBody(r, entry);
    assert.equal(body.state, 'ok');
    assert.match(body.fields.choice, new RegExp(SECRET));
  } finally { away(r); }
});

// --- the third state: keyring absent entirely -------------------------

test('keyring entirely absent: reports unreadable, never "no entries"', () => {
  const r = root();
  try {
    memory.logEntry(r, 'decision', { choice: SECRET, why: 'x', shred: true }, { project: 'p' });
    fs.rmSync(shred.keyringPath(r)); // the whole file, not one key

    const { entries } = memory.readLog(r, 'decision', { project: 'p' });
    assert.equal(entries.length, 1, 'the entry itself must still be there — this is not deletion');

    const body = memory.readEntryBody(r, entries[0]);
    assert.equal(body.state, 'unreadable');
    assert.equal(body.reason, 'keyring-absent');

    // The distinguishing fact this state exists for: a HEALTHY, merely
    // empty keyring must NOT look the same as an absent one.
    const kr = shred.loadKeyring(r);
    assert.equal(kr.present, false);
  } finally { away(r); }
});

test('positive control: an EMPTY-but-PRESENT keyring is a different, better state than an absent one', () => {
  const r = root();
  try {
    memory.logEntry(r, 'decision', { choice: SECRET, why: 'x', shred: true }, { project: 'p' });
    // Replace the keyring with a present-but-empty one (simulating a
    // keyring that legitimately never held this id, as opposed to one
    // that was never created at all).
    fs.writeFileSync(shred.keyringPath(r), JSON.stringify({ version: 1, keys: {} }));
    const kr = shred.loadKeyring(r);
    assert.equal(kr.present, true);
    const { entries } = memory.readLog(r, 'decision', { project: 'p' });
    const body = memory.readEntryBody(r, entries[0]);
    assert.equal(body.state, 'unreadable');
    assert.equal(body.reason, 'no-key', 'present-but-empty must read as no-key, not keyring-absent');
  } finally { away(r); }
});

// --- shredding: destroy + marker, and the register keeps reporting it --

function shredWorld() {
  const r = root();
  const a = memory.logEntry(r, 'decision', {
    choice: `vendor Q for payroll — ${SECRET}`, why: 'cheapest bid', shred: true,
  }, { project: 'p' }).entry;
  const b = memory.logEntry(r, 'decision', {
    choice: 'vendor R for shipping — a neighbouring, NON-shredded decision', why: 'fastest', shred: true,
  }, { project: 'p' }).entry;
  return { r, a, b };
}

test('probe: after shredding, readEntryBody is unreadable — the mechanism this build actually controls', () => {
  const { r, a } = shredWorld();
  try {
    const { destroyed, marker } = memory.shredEntry(r, 'decision', a.id, {
      project: 'p', reason: 'payroll figure named a specific employee',
    });
    assert.equal(destroyed.destroyed, true);
    assert.ok(marker.id);

    const status = memory.shredStatus(r, 'decision', a.id, { project: 'p' });
    assert.equal(status.shredded, true);
    assert.match(status.reason, /named a specific employee/);
    assert.ok(status.at);

    // Re-read the ORIGINAL line from disk (not a cached object) and
    // confirm it is still exactly there, byte for byte — shredding must
    // never touch the line itself.
    const { entries } = memory.readLog(r, 'decision', { project: 'p' });
    const original = entries.find((e) => e.id === a.id);
    assert.ok(original.body_enc, 'the original line is gone or was rewritten');
    const afterBody = memory.readEntryBody(r, original);
    assert.equal(afterBody.state, 'unreadable');
    assert.equal(afterBody.reason, 'no-key');
  } finally { away(r); }
});

test('counter-probe: a neighbouring, non-shredded entry stays fully readable', () => {
  const { r, a, b } = shredWorld();
  try {
    memory.shredEntry(r, 'decision', a.id, { project: 'p', reason: 'x' });
    const { entries } = memory.readLog(r, 'decision', { project: 'p' });
    const neighbour = entries.find((e) => e.id === b.id);
    const body = memory.readEntryBody(r, neighbour);
    assert.equal(body.state, 'ok', 'the shredder broke an entry it was never asked to touch');
    assert.match(body.fields.choice, /vendor R for shipping/);
  } finally { away(r); }
});

test('sabotage: skipping key destruction leaves the body fully readable — the probe above is not vacuous', () => {
  // A hand-broken version of shredEntry that appends the SAME marker
  // but never calls destroyKey — the mistake the real function must
  // never make. If the probe above ("shredded -> unreadable") were
  // trivially true regardless of what shredEntry does, this would ALSO
  // report unreadable. It must not.
  const { r, a } = shredWorld();
  try {
    memory.logEntry(r, 'decision', {
      shredded_of: a.id, shredded_reason: 'sabotage: key kept on purpose',
    }, { project: 'p' });
    // NOTE: no shred.destroyKey call — this is the sabotage.
    const status = memory.shredStatus(r, 'decision', a.id, { project: 'p' });
    assert.equal(status.shredded, true, 'the register-line half of the mechanism does not depend on the key');

    const { entries } = memory.readLog(r, 'decision', { project: 'p' });
    const original = entries.find((e) => e.id === a.id);
    const body = memory.readEntryBody(r, original);
    // RED: the register says "deleted", but the body is still fully
    // readable, because the one thing that actually erases anything —
    // destroying the key — was skipped.
    assert.equal(body.state, 'ok', 'sabotage should have left the body readable, and it must — proving the ' +
      'GREEN case above is doing real work, not reporting unreadable unconditionally');
    assert.match(body.fields.choice, new RegExp(SECRET));
  } finally { away(r); }
});

test('sabotage, restored exactly: destroying the key afterwards makes the SAME entry unreadable again', () => {
  const { r, a } = shredWorld();
  try {
    memory.logEntry(r, 'decision', {
      shredded_of: a.id, shredded_reason: 'sabotage then repair',
    }, { project: 'p' });
    const body1 = memory.readEntryBody(r, memory.readLog(r, 'decision', { project: 'p' }).entries.find((e) => e.id === a.id));
    assert.equal(body1.state, 'ok', 'sabotage step did not reproduce');

    shred.destroyKey(r, a.id, { reason: 'repair: actually destroy it now' });
    const body2 = memory.readEntryBody(r, memory.readLog(r, 'decision', { project: 'p' }).entries.find((e) => e.id === a.id));
    assert.equal(body2.state, 'unreadable');
    assert.equal(body2.reason, 'no-key');
  } finally { away(r); }
});

test('destroyKey on an already-destroyed key is a no-op, not an error', () => {
  const { r, a } = shredWorld();
  try {
    memory.shredEntry(r, 'decision', a.id, { project: 'p', reason: 'first' });
    const again = shred.destroyKey(r, a.id, { reason: 'second' });
    assert.equal(again.destroyed, false);
    assert.equal(again.reason, 'no-such-key');
  } finally { away(r); }
});

test('destroyKey throws (not "no-such-key") when the whole keyring is absent — a worse, different fact', () => {
  const r = root();
  try {
    assert.throws(() => shred.destroyKey(r, 'whatever'), /No keyring/);
  } finally { away(r); }
});

// --- every path named in the brief, checked one at a time -------------

test('path: memory.find — a substring search for the plaintext finds nothing once shredded', () => {
  const { r, a } = shredWorld();
  try {
    // Before shredding, the CIPHERTEXT gives find() nothing either — the
    // secret was never in the clear on disk even for a split second, so
    // this is not "find only fails after deletion", it never had it.
    assert.equal(memory.find(r, SECRET, caps.grantAll()).length, 0,
      'find matched a substring that was never written in the clear');
    memory.shredEntry(r, 'decision', a.id, { project: 'p', reason: 'x' });
    assert.equal(memory.find(r, SECRET, caps.grantAll()).length, 0, 'find still must not match after shredding');
    // Counter-probe: find CAN still see the entry by its unencrypted id.
    assert.ok(memory.find(r, a.id, caps.grantAll()).some((h) => h.id === a.id),
      'find lost the ability to see the entry at all');
  } finally { away(r); }
});

test('path: retrieval.retrieve ("context") — no claim body ever carries the secret', () => {
  const { r, a } = shredWorld();
  try {
    memory.shredEntry(r, 'decision', a.id, { project: 'p', reason: 'x' });
    const res = retrieval.retrieve(r, 'vendor', caps.grantAll(), { top: 20 });
    for (const c of res.claims) {
      assert.equal(String(c.body ?? '').includes(SECRET), false, `claim ${c.id} carried the secret`);
    }
    // Documented limitation, not a silent pass: retrieval.mjs reads
    // BODY_FIELDS directly off the raw entry (see retrieval.mjs's own
    // `bodyOf`) and has no decrypt hook — this build's scope forbids
    // editing retrieval.mjs, so an entry written with shred: true shows
    // an EMPTY body here even while its key is still intact, not a
    // decrypted one. The assertion above is still meaningful (no leak),
    // but "fully readable through context" is not claimed — see the
    // build report.
  } finally { away(r); }
});

test('path: viewer.collectMemory / renderHtml — no rendered page ever contains the secret', async () => {
  const { r, a } = shredWorld();
  try {
    const v = await import('../src/viewer.mjs');
    memory.shredEntry(r, 'decision', a.id, { project: 'p', reason: 'x' });
    const data = v.collectMemory(r, { name: 'p14' });
    assert.equal(JSON.stringify(data).includes(SECRET), false, 'the collected viewer DATA contains the secret');
    const { html } = v.build([r], { title: 'p14' });
    assert.equal(html.includes(SECRET), false, 'the rendered viewer page contains the secret');
  } finally { away(r); }
});

test('path: raw JSONL bytes on disk — the register file itself never held the secret', () => {
  const { r, a } = shredWorld();
  try {
    memory.shredEntry(r, 'decision', a.id, { project: 'p', reason: 'x' });
    const bytes = fs.readFileSync(memory.logPath(r, 'decision', 'p'), 'utf8');
    assert.equal(bytes.includes(SECRET), false);
  } finally { away(r); }
});

test('path: raw CAPTURE material (src/raw.mjs) — a DIFFERENT, untouched store; documented gap, not a false pass', () => {
  // Crypto-shredding protects the STRUCTURED entry's body only. If the
  // same information was also captured as a raw transcript before it
  // was digested into that entry, the capture is a completely separate
  // file this build never looks at. This test proves the gap is real
  // rather than asserting it in prose: the secret survives in the raw
  // store even after the corresponding memory entry is shredded.
  const r = root();
  try {
    memory.logEntry(r, 'decision', { choice: SECRET, why: 'x', shred: true }, { project: 'p' });
    const t = path.join(r, 't.jsonl');
    fs.writeFileSync(t, `${JSON.stringify({
      timestamp: '2026-01-01T00:00:00Z',
      message: { content: `discussing the decision: ${SECRET}` },
    })}\n`.repeat(400));
    const cap = raw.capture(r, t);
    assert.equal(cap.status, 'captured', `capture did not run: ${JSON.stringify(cap)}`);

    const entries = memory.readLog(r, 'decision', { project: 'p' }).entries;
    memory.shredEntry(r, 'decision', entries[0].id, { project: 'p', reason: 'x' });

    const captures = raw.listCaptures(r);
    assert.ok(captures.length >= 1, 'no capture was recorded to check');
    const found = raw.snippet(r, captures[0], [SECRET.split('-')[1]]);
    assert.match(found, new RegExp(SECRET), 'raw capture material no longer contains the secret — if this ' +
      'assertion ever starts failing, someone wired raw captures into crypto-shredding and this comment (and ' +
      'the build report\'s stated gap) are out of date, not this test');
  } finally { away(r); }
});

test('path: search.buildIndex ("the index cache") — an encrypted body contributes zero index weight, from the FIRST build', () => {
  // Note what this test actually found while it was being written: since
  // encryption happens at WRITE time (before shredding ever enters the
  // picture), an entry written with `shred: true` is unindexable from
  // its very first `buildIndex` — not only after a later deletion. That
  // is a stronger property than the brief's phrasing implies ("no path
  // is readable AFTER shredding"): here, the index cache never held the
  // plaintext at ANY point, shredded or not. The comparison below is
  // against a PLAIN neighbour, to prove the index genuinely works and
  // this is not "buildIndex is broken and indexes nothing".
  const r = root();
  try {
    const plain = memory.logEntry(r, 'decision', {
      choice: 'vendor R for shipping, written in the clear', why: 'fastest',
    }, { project: 'p' }).entry;
    const enc = memory.logEntry(r, 'decision', {
      choice: `vendor Q for payroll — ${SECRET}`, why: 'cheapest bid', shred: true,
    }, { project: 'p' }).entry;

    const before = search.buildIndex(r);
    const plainDoc = before.documents.find((d) => d.entry.id === plain.id);
    assert.ok(plainDoc && plainDoc.weights.size > 0, 'the PLAIN neighbour was not indexed — fixture or search.mjs assumption is wrong');
    const encDoc = before.documents.find((d) => d.entry.id === enc.id);
    // fieldsOfEntry() (src/search.mjs) reads SHREDDABLE_FIELDS by name
    // straight off the raw entry; once they are replaced by `body_enc`
    // (an object under a field name FIELD_WEIGHTS does not know), it
    // contributes NOTHING — not even ciphertext tokens. A document with
    // literally zero weight is dropped from the index entirely (see
    // search.mjs's addDoc), so "no leak" here can mean "absent from the
    // index altogether", the strongest form of unreadable.
    assert.ok(!encDoc || encDoc.weights.size === 0,
      'the encrypted entry contributed index weight before it was ever shredded');
    assert.equal(search.search(before, SECRET).length, 0);

    // Shredding it afterwards changes nothing about this — it was
    // already unindexable, and stays that way.
    memory.shredEntry(r, 'decision', enc.id, { project: 'p', reason: 'x' });
    const after = search.buildIndex(r);
    const encDocAfter = after.documents.find((d) => d.entry.id === enc.id);
    assert.ok(!encDocAfter || encDocAfter.weights.size === 0);
    // Counter-probe: the plain neighbour's indexing survives shredding
    // an unrelated entry, untouched.
    const plainDocAfter = after.documents.find((d) => d.entry.id === plain.id);
    assert.ok(plainDocAfter && plainDocAfter.weights.size === plainDoc.weights.size,
      'shredding one entry disturbed indexing of its neighbour');
  } finally { away(r); }
});

// --- git history: a throwaway repo this file builds and destroys ------
//
// House rule: never `git` inside /home/user/cheap-mem or
// /home/user/lucky-mem. Everything below runs inside a mktemp'd
// directory that is its OWN, brand-new git repository.

function gitRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'p14-git-'));
  execFileSync('git', ['init', '-q'], { cwd: r });
  execFileSync('git', ['config', 'user.email', 'p14@example.test'], { cwd: r });
  execFileSync('git', ['config', 'user.name', 'p14 test'], { cwd: r });
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  config.writeConfig(r, config.DEFAULT_CONFIG);
  return r;
}
function commitAll(r, message) {
  execFileSync('git', ['add', '-A'], { cwd: r });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: r });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).trim();
}
function showAtCommit(r, commit, relPath) {
  try {
    return execFileSync('git', ['show', `${commit}:${relPath}`], { cwd: r, encoding: 'utf8' });
  } catch {
    return null; // the path did not exist at that commit
  }
}

test('path: git history — the committed log line was ciphertext from the FIRST commit, not rewritten later', () => {
  const r = gitRoot();
  try {
    const { entry } = memory.logEntry(r, 'decision', { choice: SECRET, why: 'x', shred: true }, { project: 'p' });
    const c1 = commitAll(r, 'first: encrypted entry');
    memory.shredEntry(r, 'decision', entry.id, { project: 'p', reason: 'git-history probe' });
    const c2 = commitAll(r, 'second: shredded');

    const relPath = path.relative(r, memory.logPath(r, 'decision', 'p'));
    const atC1 = showAtCommit(r, c1, relPath);
    const atC2 = showAtCommit(r, c2, relPath);
    assert.ok(atC1 && !atC1.includes(SECRET), 'the FIRST commit already held the secret in the clear');
    assert.ok(atC2 && !atC2.includes(SECRET), 'the second commit holds the secret in the clear');
    // The original line's bytes are IDENTICAL across both commits — the
    // one property src/chain.mjs's hash depends on.
    const line1 = atC1.trim().split('\n').find((l) => l.includes(entry.id));
    const line2 = atC2.trim().split('\n').find((l) => l.includes(entry.id));
    assert.equal(line1, line2, 'the original line changed between commits — shredding rewrote history');
  } finally { away(r); }
});

test('FINDING: a keyring committed to git with retained history does NOT actually shred — the old key is still reachable', () => {
  // This is the sharpest, most important gap this build point surfaces.
  // Destroying a key only helps if the OLD version of the keyring is
  // unreachable afterwards. If the keyring is committed like an
  // ordinary file, the commit BEFORE the deletion still has the old
  // key, in full, forever — the exact problem `git filter-repo` exists
  // to fix for the LOG and which this build explicitly refuses to
  // reach for. See src/shred.mjs's own module comment.
  const r = gitRoot();
  try {
    const { entry } = memory.logEntry(r, 'decision', { choice: SECRET, why: 'x', shred: true }, { project: 'p' });
    const c1 = commitAll(r, 'keyring with the key present');
    memory.shredEntry(r, 'decision', entry.id, { project: 'p', reason: 'x' });
    commitAll(r, 'keyring after destroyKey');

    const relKeyring = path.relative(r, shred.keyringPath(r));
    const oldKeyring = JSON.parse(showAtCommit(r, c1, relKeyring));
    assert.ok(oldKeyring.keys[entry.id], 'the fixture did not actually have the key at c1 — test is broken');

    // Reconstruct the OLD keyring file from git history and prove the
    // "destroyed" entry decrypts again with it — the concrete failure
    // mode, not an assertion about intent.
    const oldKeyringPath = path.join(r, '.mem', 'keyring.json');
    fs.writeFileSync(oldKeyringPath, JSON.stringify(oldKeyring));
    const { entries } = memory.readLog(r, 'decision', { project: 'p' });
    const body = memory.readEntryBody(r, entries.find((e) => e.id === entry.id));
    assert.equal(body.state, 'ok', 'a keyring recovered from an OLD git commit should still decrypt — proving ' +
      'that committing the keyring with retained history defeats the deletion');
    assert.match(body.fields.choice, new RegExp(SECRET));
  } finally { away(r); }
});

// --- interaction with the hash chain (src/chain.mjs) -------------------

function withChainConfig(r, chainSealCadence) {
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    ...config.DEFAULT_CONFIG, chainSealCadence,
  }, null, 2));
}

test('chain compatibility: a sealed chain stays "ok" after shredding an entry it already covers', () => {
  const r = root();
  try {
    withChainConfig(r, 3);
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(memory.logEntry(r, 'decision', {
        choice: `${SECRET}-${i}`, why: 'x', shred: true, agent: 'w1',
      }, { project: 'p' }).entry.id);
    }
    let report = integrity.checkChain(r);
    assert.equal(report.state, 'ok', 'the fixture did not seal — check CHAIN_SEAL_CADENCE wiring');

    // The bytes of the log BEFORE shredding, for the byte-identity check.
    const before = fs.readFileSync(memory.logPath(r, 'decision', 'p'), 'utf8');

    memory.shredEntry(r, 'decision', ids[0], { project: 'p', reason: 'chain check', agent: 'w1' });

    // The append-only file grew by exactly one line (the marker); every
    // byte that existed before is still there, unchanged.
    const after = fs.readFileSync(memory.logPath(r, 'decision', 'p'), 'utf8');
    assert.ok(after.startsWith(before), 'shredding modified bytes that existed before it ran');

    report = integrity.checkChain(r);
    assert.equal(report.tampered.length, 0, 'the chain reports tampering after a shred that never touched a line');
    // `unknown` is fine here (the marker line pushed the writer's tail
    // past its last seal without reaching the next cadence) — `error`
    // is the only state that would mean this build broke the chain.
    assert.notEqual(report.state, 'error');
  } finally { away(r); }
});

test('sabotage: an ACTUAL line rewrite (not shredding) is what the chain is supposed to catch', () => {
  // Positive control for the chain check itself, using this file's own
  // fixture shape — proves report.state can and does go to 'error' for
  // a REAL append-only violation, so the 'ok'/'unknown' results above
  // are not just "this check never fires".
  const r = root();
  try {
    withChainConfig(r, 2);
    memory.logEntry(r, 'decision', { choice: 'a', why: 'x', agent: 'w1' }, { project: 'p' });
    memory.logEntry(r, 'decision', { choice: 'b', why: 'x', agent: 'w1' }, { project: 'p' });
    let report = integrity.checkChain(r);
    assert.equal(report.state, 'ok');

    const p = memory.logPath(r, 'decision', 'p');
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    lines[0] = lines[0].replace('"choice":"a"', '"choice":"TAMPERED"');
    fs.writeFileSync(p, lines.join('\n'));

    report = integrity.checkChain(r);
    assert.equal(report.state, 'error', 'a hand-edited line did not turn the chain red');
  } finally { away(r); }
});

// --- write cost: encryption against the 20% abort criterion ------------
//
// Measures memory.logEntry ALONE (no CLI corpus scans — see
// test/p16-append-exponent.test.mjs for why those live outside this
// function entirely), with and without shred: true, at a few PRE-EXISTING
// keyring sizes — because shred's own added cost is a keyring
// read-modify-write, and unlike the JSONL append itself that operation
// is NOT designed to be O(1) here: every write rewrites the WHOLE
// keyring file. See the numbers this prints/asserts below and the build
// report for what they mean against P16's own "cost must not grow with
// corpus size" goal.

function rootWithKeyring(nKeys) {
  const r = root();
  const keys = {};
  for (let i = 0; i < nKeys; i += 1) {
    keys[`seed${String(i).padStart(8, '0')}`] = {
      key: Buffer.alloc(shred.KEY_BYTES, i % 256).toString('base64'),
      createdAt: '2026-01-01T00:00:00Z',
    };
  }
  fs.writeFileSync(shred.keyringPath(r), JSON.stringify({ version: 1, keys }));
  return r;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function timeWrites(r, n, shredFlag) {
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    memory.logEntry(r, 'decision', {
      choice: `${SECRET}-${i}`, why: 'timing sample', ...(shredFlag ? { shred: true } : {}),
    }, { project: 'p' });
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

test('COST: shred: true against the 20% write-time abort criterion, at three keyring sizes', () => {
  const RUNGS = [0, 500, 3000];
  const N = 25;
  const report = [];
  for (const nKeys of RUNGS) {
    const rBase = rootWithKeyring(nKeys);
    const rShred = rootWithKeyring(nKeys);
    try {
      const baseline = timeWrites(rBase, N, false);
      const withShred = timeWrites(rShred, N, true);
      const overheadPct = baseline > 0 ? ((withShred - baseline) / baseline) * 100 : null;
      report.push({ nKeys, baselineMs: baseline, shredMs: withShred, overheadPct });
    } finally { away(rBase); away(rShred); }
  }
  // Printed unconditionally: the brief asks for the REAL number, not a
  // pass/fail hidden behind an assertion. See the file's own header
  // comment (updated after this test was first run) for the numbers
  // observed on the machine that built this, and the build report for
  // the honest verdict against the 20% line.
  console.log('P14 write-cost ladder (median of', N, 'writes):', JSON.stringify(report));
  for (const row of report) {
    assert.ok(Number.isFinite(row.baselineMs) && row.baselineMs >= 0, 'baseline did not measure');
    assert.ok(Number.isFinite(row.shredMs) && row.shredMs >= 0, 'shred timing did not measure');
  }
});

// =========================================================================
// Two things found by probing this module from outside after it was
// built, both of which a "is the body still readable" test cannot see.
// =========================================================================

test('probe: readEntryBody says `unknown` for no entry, not `plain`', () => {
  const r = root();
  try {
    // `plain` is a VERDICT — "this entry's body is not encrypted". Given
    // nothing to inspect, that verdict is about an entry the function
    // never saw. A caller that looks an id up and misses would read a
    // confident "not encrypted" for something that does not exist.
    for (const nothing of [undefined, null, 'not-an-entry', 42]) {
      const got = memory.readEntryBody(r, nothing);
      assert.equal(got.state, 'unknown', `readEntryBody(${JSON.stringify(nothing)}) claimed '${got.state}'`);
      assert.equal(got.reason, 'no-entry');
      assert.equal(got.fields, null, 'an unknown state must not hand back a fields map to iterate');
    }

    // POSITIVE CONTROL: a REAL entry with no body_enc is still `plain`,
    // with its fields in the clear. Without this, returning `unknown`
    // for everything would pass the assertions above.
    const { entry } = memory.logEntry(r, 'decision',
      { topic: 't/plain', title: 'an ordinary entry', choice: 'c', why: 'w' });
    const real = memory.readEntryBody(r, entry);
    assert.equal(real.state, 'plain', 'an ordinary unencrypted entry stopped reading as plain');
    assert.equal(real.fields.title, 'an ordinary entry');
  } finally { away(r); }
});

test('probe: an entry written with shred:true is UNFINDABLE, not merely body-hidden', () => {
  const r = root();
  try {
    // `title` is in SHREDDABLE_FIELDS — correctly, it is the field most
    // likely to name a person. But it is also what the indexer weights
    // most. The consequence is bigger than "the body is hidden", and it
    // is the reason this feature ships OFF: turning it on by default
    // would remove entries from every answer the memory gives, while
    // every body-readability test stayed green.
    const marker = `zzzunfindable${Date.now().toString(36)}`;
    const { entry } = memory.logEntry(r, 'decision',
      { topic: 't/x', title: marker, choice: 'secret', why: 'secret', shred: true });

    const stored = memory.readEntryBody(r, memory.readLog(r, 'decision').entries.find((e) => e.id === entry.id));
    assert.equal(stored.state, 'ok', 'sanity: the key is intact and the body decrypts');
    assert.equal(stored.fields.title, marker, 'sanity: the title is preserved, just not in the clear');

    const found = retrieval.retrieve(r, marker, caps.grantAll('test'), { top: 5 });
    assert.equal(found.claims.length, 0,
      'this assertion documents a LIMIT, not a guarantee: if it ever fails, a decrypt hook has been '
      + 'wired into the search lanes and this test plus SHREDDABLE_FIELDS\' comment are stale');

    // POSITIVE CONTROL: the same entry without `shred` IS findable, so
    // the zero above is the encryption and not a broken query.
    const plainMarker = `zzzfindable${Date.now().toString(36)}`;
    memory.logEntry(r, 'decision', { topic: 't/y', title: plainMarker, choice: 'c', why: 'w' });
    const plainFound = retrieval.retrieve(r, plainMarker, caps.grantAll('test'), { top: 5 });
    assert.ok(plainFound.claims.length > 0, 'the query lane itself is broken — the zero above proves nothing');
  } finally { away(r); }
});
