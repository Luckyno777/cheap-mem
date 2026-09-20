// test/chain.test.mjs — a per-writer hash chain over append-only logs.
//
// Measured baseline this builds on (`checkAppendOnlyGit`, src/doctor.mjs,
// see `test/append-only-git.test.mjs`): 1 of 5 tampers caught, because it
// compares the working tree against `git show HEAD:<path>` — once a
// rewrite is committed, HEAD *is* the rewritten content and the check
// compares clean history to itself. `src/chain.mjs` is a second,
// independent signal that never reads git: it recomputes a hash purely
// from CURRENT file content and compares it against a value a SEAL
// recorded earlier, inside the log itself.
//
// Each of the five tampers gets its own test below, and each says
// plainly whether the chain catches it and why — including the ones it
// does not. A stretched "caught" would be worse than an honest miss: see
// `src/chain.mjs`'s own module comment on the design this suite pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as chain from '../src/chain.mjs';
import * as integrity from '../src/integrity.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-chain-'));
  fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
  return root;
}
const away = (root) => fs.rmSync(root, { recursive: true, force: true });
const errorsFile = (root) => path.join(root, 'projects', 'p', 'errors.jsonl');
const line = (o) => JSON.stringify(o);
const entry = (id, agent, extra = {}) => line({
  id, ts: '2026-01-01T00:00:00Z', title: `t-${id}`, agent, ...extra,
});

/** Only for a THROWAWAY temp repo — never against this repository. See
 *  CLAUDE.md / the task brief: driving git inside a temp repo built for
 *  a test is explicitly allowed; this file never runs git against `REPO`. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function gitc(cwd, ...args) {
  return git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args);
}

// ---------------------------------------------------------------------
// Positive control
// ---------------------------------------------------------------------

test('POSITIVE: an untampered, sealed log verifies, and the verifier can see the chain at all', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');
    fs.appendFileSync(file, `${entry('a3', 'w1')}\n`);

    const report = integrity.checkChain(root);
    assert.equal(report.sealsFound, 1, 'the verifier did not see the seal at all');
    const row = report.writers.find((w) => w.writer === 'w1');
    assert.ok(row, 'writer w1 never showed up in the report');
    assert.equal(row.state, 'ok');
    assert.equal(row.seals, 1);
    assert.equal(row.verifiedThroughId, 'a2');
    assert.equal(report.tampered.length, 0);
    assert.equal(report.state, 'ok');
  } finally { away(root); }
});

test('wired into scanIntegrity, in its own shape, and isClean reflects it', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n`);
    chain.appendSeal(file, 'w1');
    const r = integrity.scanIntegrity(root);
    assert.ok(r.chain, 'scanIntegrity does not carry a chain field');
    assert.equal(r.chain.state, 'ok');
    assert.equal(integrity.isClean(r), true);
  } finally { away(root); }
});

test('a log written before chaining existed reads UNKNOWN, never as verified', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    // No seal at all — this is every log this codebase has ever written,
    // up to this round.
    const report = integrity.checkChain(root);
    assert.equal(report.sealsFound, 0);
    assert.equal(report.state, 'unknown', '"no chain present" reported as anything but unknown is a false verification');
    assert.equal(report.tampered.length, 0, 'absence of a seal is not itself a tamper finding');
    const row = report.writers.find((w) => w.writer === 'w1');
    assert.equal(row.state, 'unknown');
  } finally { away(root); }
});

test('isClean does not fail merely because no seal exists yet — a bolt that reports the innocent gets switched off', () => {
  const root = fixtureRoot();
  try {
    fs.writeFileSync(errorsFile(root), `${entry('a1', 'w1')}\n`);
    const r = integrity.scanIntegrity(root);
    assert.equal(r.chain.state, 'unknown');
    assert.equal(integrity.isClean(r), true,
      '"Ein Riegel, der Unschuldige meldet, wird abgeschaltet" — an absent chain must not fail a strict run');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// Who a writer is
// ---------------------------------------------------------------------

test('WRITER IDENTITY: a line with no agent field is filed under the unattributed bucket, not excluded from protection', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${line({ id: 'a1', ts: '2026-01-01T00:00:00Z', title: 'no agent on this one' })}\n`);
    chain.appendSeal(file, chain.UNATTRIBUTED_WRITER);

    const before = integrity.checkChain(root);
    const beforeRow = before.writers.find((w) => w.writer === chain.UNATTRIBUTED_WRITER);
    assert.ok(beforeRow, 'an unattributed line never showed up as a chain-able writer at all');
    assert.equal(beforeRow.state, 'ok');

    const raw = fs.readFileSync(file, 'utf8').replace('no agent on this one', 'TAMPERED');
    fs.writeFileSync(file, raw);
    const after = integrity.checkChain(root);
    const afterRow = after.writers.find((w) => w.writer === chain.UNATTRIBUTED_WRITER);
    assert.equal(afterRow.state, 'error', 'stripping the agent field must not be a free pass around the chain');
  } finally { away(root); }
});

test('WRITER IDENTITY: origin.agent is honoured the same way memory.mjs derives it for the agent board', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${line({
      id: 'a1', ts: '2026-01-01T00:00:00Z', title: 'via origin', origin: { agent: 'vm-admin' },
    })}\n`);
    chain.appendSeal(file, 'vm-admin');
    const report = integrity.checkChain(root);
    const row = report.writers.find((w) => w.writer === 'vm-admin');
    assert.ok(row, 'origin.agent was not recognised as the writer');
    assert.equal(row.state, 'ok');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// One hash function, called by both sides
// ---------------------------------------------------------------------

test('STRUCTURAL: exactly one call site computes a hash in src/chain.mjs', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'chain.mjs'), 'utf8');
  const calls = src.match(/\.createHash\(/g) ?? [];
  assert.equal(calls.length, 1,
    `found ${calls.length} hashing call sites — a second one is exactly how the write and verify `
    + 'sides drifted apart on 2026-09-20 (raw bytes vs. re-serialised JSON), each individually correct '
    + 'and both wrong together');
});

test('the write side (appendSeal) and the read side (verifyChain) agree because both call chainHash and nothing else', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    const seal = chain.appendSeal(file, 'w1');

    // Recomputed here, independently of `appendSeal`'s internals, using
    // ONLY the exported `chainHash` — the same function `verifyChain`
    // itself calls. If the two sides ever used different functions this
    // would not match by construction, not by luck.
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    let h = chain.GENESIS;
    for (const raw of rows) {
      const parsed = JSON.parse(raw);
      if (parsed.id === 'a1' || parsed.id === 'a2') h = chain.chainHash(h, raw);
    }
    assert.equal(seal.chain_seal.hash, h, 'appendSeal computed a different hash than chainHash alone produces');

    const report = integrity.checkChain(root);
    assert.equal(report.writers.find((w) => w.writer === 'w1').state, 'ok');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// The five tampers — one test each, each stating whether it is caught
// and why.
// ---------------------------------------------------------------------

test('TAMPER 1/5 — working-tree edit: CAUGHT (the baseline this chain shares with checkAppendOnlyGit)', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');
    const raw = fs.readFileSync(file, 'utf8').replace('t-a1', 'TAMPERED-IN-WORKING-TREE');
    fs.writeFileSync(file, raw);

    const report = integrity.checkChain(root);
    const row = report.writers.find((w) => w.writer === 'w1');
    assert.equal(row.state, 'error');
    assert.equal(row.brokenAt.throughId, 'a2', 'must name the seal boundary the mismatch was found at');
  } finally { away(root); }
});

test('TAMPER 2/5 — edited AND committed: CAUGHT (the chain never reads git, unlike checkAppendOnlyGit)', () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-chain-committed-'));
  try {
    fs.mkdirSync(path.join(top, 'global'), { recursive: true });
    const file = path.join(top, 'global', 'errors.jsonl');
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');
    git(top, 'init', '-q');
    git(top, 'add', '-A');
    gitc(top, 'commit', '-q', '-m', 'init');

    // The rewrite AND the commit that covers it up — the case
    // checkAppendOnlyGit documents as invisible to it, because HEAD now
    // IS the rewritten content.
    const raw = fs.readFileSync(file, 'utf8').replace('t-a1', 'TAMPERED-AND-COMMITTED');
    fs.writeFileSync(file, raw);
    git(top, 'add', '-A');
    gitc(top, 'commit', '-q', '-m', 'quiet rewrite');

    // The chain reads the CURRENT FILE, not git history, so the commit
    // changes nothing about what it sees.
    const report = chain.verifyChain([{ rel: 'global/errors.jsonl', raw: fs.readFileSync(file, 'utf8') }]);
    const row = report.writers.find((w) => w.writer === 'w1');
    assert.equal(row.state, 'error', 'a rewrite that got committed must still be caught — the chain does not consult git at all');
  } finally { away(top); }
});

test('TAMPER 3/5 — git commit --amend: CAUGHT (same reason as #2: the chain is blind to git history either way)', () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-chain-amend-'));
  try {
    fs.mkdirSync(path.join(top, 'global'), { recursive: true });
    const file = path.join(top, 'global', 'errors.jsonl');
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');
    git(top, 'init', '-q');
    git(top, 'add', '-A');
    gitc(top, 'commit', '-q', '-m', 'init');

    fs.appendFileSync(file, `${entry('a3', 'w1')}\n`);
    git(top, 'add', '-A');
    gitc(top, 'commit', '-q', '-m', 'a3');

    // Fold a rewrite of the FIRST line into the most recent commit —
    // the commit that carried the honest a3 line now also carries the
    // tamper, and no separate "here is the tamper" commit ever existed.
    const raw = fs.readFileSync(file, 'utf8').replace('t-a1', 'TAMPERED-VIA-AMEND');
    fs.writeFileSync(file, raw);
    git(top, 'add', '-A');
    gitc(top, 'commit', '-q', '--amend', '-m', 'a3 (amended)');

    const report = chain.verifyChain([{ rel: 'global/errors.jsonl', raw: fs.readFileSync(file, 'utf8') }]);
    const row = report.writers.find((w) => w.writer === 'w1');
    assert.equal(row.state, 'error');
  } finally { away(top); }
});

test('TAMPER 4/5 — a drawer rewritten as one huge line: NOT CAUGHT — the rewrite destroys the seal along with the evidence it protected', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n${entry('a3', 'w1')}\n`);
    chain.appendSeal(file, 'w1');
    assert.equal(integrity.checkChain(root).writers.find((w) => w.writer === 'w1').state, 'ok');

    // The realistic shape of this tamper: the ENTIRE file — including the
    // seal line itself, which lived among the ordinary entries with
    // nothing marking it as special to a naive rewrite — collapses into
    // one line. There is no longer a seal in the file to disagree with.
    fs.writeFileSync(file, `${line({ id: 'merged', ts: '2026-01-01T00:00:00Z', agent: 'w1', title: 'x'.repeat(2000) })}\n`);

    const report = integrity.checkChain(root);
    const row = report.writers.find((w) => w.writer === 'w1');
    // Honest miss, stated plainly: this is not an ERROR, because nothing
    // survived that could disagree with the new content. It is also, and
    // this is the part worth pinning, NOT an OK — the chain correctly
    // refuses to vouch for content it never saw sealed. A check that
    // cannot detect this tamper but also does not falsely certify it is
    // a materially better outcome than one that goes quiet and green.
    assert.equal(row.state, 'unknown',
      'the chain cannot see the tamper once the evidence for it is gone, but it must not silently say OK either');
  } finally { away(root); }
});

test('TAMPER 5/5 — .mem/epoch.json deleted: OUT OF REACH BY DESIGN — a different subsystem, protecting a different property', () => {
  const root = fixtureRoot();
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'epoch.json'), JSON.stringify({ version: 1, claims: 1 }));
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n`);
    chain.appendSeal(file, 'w1');

    const before = integrity.checkChain(root);
    fs.rmSync(path.join(root, '.mem', 'epoch.json'));
    const after = integrity.checkChain(root);

    // `src/chain.mjs` never reads `.mem/epoch.json` — it has nothing to
    // do with the log CONTENT this module checks. `.mem/epoch.json` is
    // `src/epoch.mjs`'s own local high-water mark, guarding against a
    // rollback (an old commit or backup checked out), a different
    // failure from a line being edited in place. Deleting it is a real
    // attack on THAT mechanism, and this test's point is that it is
    // invisible to this one, for a reason worth stating rather than a
    // gap worth hiding: the two are orthogonal, not overlapping.
    assert.deepEqual(after, before, 'the chain result changed because of a file it has no business reading');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// The named gap: the last line of a writer is not protected
// ---------------------------------------------------------------------

test('THE NAMED GAP: entries appended after the most recent seal are not protected until the next one', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');            // seals a1, a2
    fs.appendFileSync(file, `${entry('a3', 'w1')}\n`);  // NOT sealed yet

    const before = integrity.checkChain(root);
    const beforeRow = before.writers.find((w) => w.writer === 'w1');
    assert.equal(beforeRow.state, 'ok');
    // 2, not 1: the seal line itself is written under writer 'w1' too (it
    // self-seals) and is therefore just as "since the last seal" as a3 is
    // — nothing has chained to the SEAL's own bytes yet either. That is
    // the same window this test is about, one line earlier than it looks.
    assert.equal(beforeRow.unsealedSince, 2, 'the seal line and a3 should both be outside the last seal boundary');

    const raw = fs.readFileSync(file, 'utf8').replace('t-a3', 'TAMPERED-BUT-UNSEALED');
    fs.writeFileSync(file, raw);

    const after = integrity.checkChain(root);
    const row = after.writers.find((w) => w.writer === 'w1');
    // This is the gap, pinned on purpose: a tamper strictly after the
    // last seal produces no error, because nothing chains to a3 yet. If
    // a future change (sealing on every write, say) closes this window,
    // THIS assertion is the one that will fail — on purpose, loudly,
    // rather than the gap quietly changing shape unnoticed.
    assert.equal(row.state, 'ok',
      'the last-line window is expected to be open here; if this now reads error, the gap this test documents no longer holds and the comment above needs revisiting, not deleting');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// The merge probe — the property that decided per-writer over global
// ---------------------------------------------------------------------

test('MERGE PROBE: two clones append under DIFFERENT writers; after a real merge=union merge both writers\' chains still verify', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-chain-mergeA-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-chain-mergeB-'));
  try {
    fs.mkdirSync(path.join(a, 'global'), { recursive: true });
    fs.writeFileSync(path.join(a, '.gitattributes'), '*.jsonl merge=union\n');
    const fileA = path.join(a, 'global', 'errors.jsonl');
    fs.writeFileSync(fileA, `${entry('base', 'w1')}\n`);
    chain.appendSeal(fileA, 'w1');
    git(a, 'init', '-q');
    git(a, 'add', '-A');
    gitc(a, 'commit', '-q', '-m', 'base');
    const branch = git(a, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

    execFileSync('git', ['clone', '-q', a, b], { encoding: 'utf8' });

    // Clone A: writer w1 keeps appending, independently.
    fs.appendFileSync(fileA, `${entry('a2', 'w1')}\n`);
    chain.appendSeal(fileA, 'w1');
    git(a, 'add', '-A');
    gitc(a, 'commit', '-q', '-m', 'a appends');

    // Clone B: a DIFFERENT writer, w2, appends — never seeing A's commit.
    const fileB = path.join(b, 'global', 'errors.jsonl');
    fs.appendFileSync(fileB, `${entry('b2', 'w2')}\n`);
    chain.appendSeal(fileB, 'w2');
    git(b, 'add', '-A');
    gitc(b, 'commit', '-q', '-m', 'b appends');

    // Merge B into A with the union driver — the exact shape measured
    // 2026-09-20: exit 0, no conflict markers, lines interleaved.
    gitc(a, 'pull', '-q', '--no-rebase', b, branch);

    const merged = fs.readFileSync(fileA, 'utf8');
    const report = chain.verifyChain([{ rel: 'global/errors.jsonl', raw: merged }]);
    const w1 = report.writers.find((w) => w.writer === 'w1');
    const w2 = report.writers.find((w) => w.writer === 'w2');
    assert.ok(w1 && w2, 'both writers should still appear as separate chains after the merge');
    assert.equal(w1.state, 'ok', `writer w1's chain broke across the merge: ${JSON.stringify(w1.brokenAt)}`);
    assert.equal(w2.state, 'ok', `writer w2's chain broke across the merge: ${JSON.stringify(w2.brokenAt)}`);
  } finally { away(a); away(b); }
});

// ---------------------------------------------------------------------
// Sabotage: break it by hand, confirm red, restore, confirm green
// ---------------------------------------------------------------------

test('SABOTAGE: hand-break the chain (no git involved at all here) — red, then restore — green', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');
    const original = fs.readFileSync(file, 'utf8');

    const green1 = integrity.checkChain(root);
    assert.equal(green1.writers.find((w) => w.writer === 'w1').state, 'ok');

    fs.writeFileSync(file, original.replace('t-a1', 'SABOTAGED-BY-HAND'));
    const red = integrity.checkChain(root);
    assert.equal(red.writers.find((w) => w.writer === 'w1').state, 'error');

    fs.writeFileSync(file, original);
    const green2 = integrity.checkChain(root);
    assert.equal(green2.writers.find((w) => w.writer === 'w1').state, 'ok');
  } finally { away(root); }
});

test('isClean fails on a chain mismatch even though every other check in scanIntegrity stays silent', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');
    const raw = fs.readFileSync(file, 'utf8').replace('t-a1', 'TAMPERED');
    fs.writeFileSync(file, raw);

    const r = integrity.scanIntegrity(root);
    assert.equal(r.broken.length, 0, 'this fixture is well-formed JSON — the tamper must be caught by the chain, not by the parser');
    assert.equal(r.duplicateIds.length, 0);
    assert.equal(integrity.isClean(r), false, 'a hash mismatch must fail isClean even when nothing else in the report says a word about it');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// Sealing the TAIL, not the file: `recoverWriterTail` / `appendSeal` /
// `maybeSeal` (the P19 follow-up)
// ---------------------------------------------------------------------

test('FIRST SEAL / NO PREDECESSOR: an unsealed file recovers GENESIS and the whole file as its tail', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n${entry('a3', 'w1')}\n`);

    const rec = chain.recoverWriterTail(file, 'w1');
    assert.equal(rec.sealFound, false, 'there is no seal anywhere in this file for w1');
    assert.equal(rec.predecessorHash, chain.GENESIS,
      'no predecessor must mean GENESIS, never a guessed or cached value');
    assert.equal(rec.tailLines.length, 3, 'with no seal, the entire file is the tail, exactly once');

    // Matches a full replay from GENESIS, byte for byte -- the first
    // seal is the one case this module cannot avoid reading the whole
    // file for, and it must still land on the SAME hash a full replay
    // would.
    const full = chain.replay(fs.readFileSync(file, 'utf8'));
    const seal = chain.appendSeal(file, 'w1');
    assert.equal(seal.chain_seal.hash, full.running.get('w1'));
    assert.equal(seal.chain_seal.through_id, 'a3');
  } finally { away(root); }
});

test('CHUNK BOUNDARY: a seal record straddling a tiny reverse-read chunk is still found intact', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');   // this seal line alone is >100 bytes
    fs.appendFileSync(file, `${entry('a3', 'w1')}\n${entry('a4', 'w1')}\n`);

    // A chunk size of 8 bytes guarantees the seal record — and every
    // other line — is split across many reverse-read chunks. This is
    // exactly the case a naive `split('\n')`-per-chunk approach mangles:
    // the seal's JSON would be parsed as several incomplete fragments
    // instead of one line.
    const tiny = chain.recoverWriterTail(file, 'w1', { chunkSize: 8 });
    assert.equal(tiny.sealFound, true, 'the seal must still be found with a chunk size far smaller than one line');

    const normal = chain.recoverWriterTail(file, 'w1');
    assert.equal(tiny.predecessorHash, normal.predecessorHash);
    assert.deepEqual(tiny.tailLines, normal.tailLines,
      'a tiny chunk size must recover the exact same lines as the default chunk size');

    // Cross-checked against a full forward replay too.
    const full = chain.replay(fs.readFileSync(file, 'utf8'));
    let h = tiny.predecessorHash;
    for (const l of tiny.tailLines) {
      const e = JSON.parse(l);
      if (chain.writerOf(e) === 'w1') h = chain.chainHash(h, l);
    }
    assert.equal(h, full.running.get('w1'), 'tiny-chunk backward recovery must match a full forward replay');
  } finally { away(root); }
});

test('CHUNK BOUNDARY: appendSeal itself produces the same hash whether the chunk size is huge or tiny', () => {
  const root = fixtureRoot();
  try {
    const build = () => fs.writeFileSync(errorsFile(root),
      `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n${entry('a3', 'w1')}\n`);
    build();
    const sealBig = chain.appendSeal(errorsFile(root), 'w1', { chunkSize: 65536 });
    build();   // rebuild the identical starting file for a fair comparison
    const sealSmall = chain.appendSeal(errorsFile(root), 'w1', { chunkSize: 5 });
    assert.equal(sealSmall.chain_seal.hash, sealBig.chain_seal.hash);
    assert.equal(sealSmall.chain_seal.through_id, sealBig.chain_seal.through_id);
  } finally { away(root); }
});

test('COST: recoverWriterTail scans bytes bounded by the tail, not by lines that came before the last seal', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    const lines = [];
    for (let i = 0; i < 2000; i += 1) lines.push(entry(`old${i}`, 'w1'));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    chain.appendSeal(file, 'w1');
    fs.appendFileSync(file, `${entry('new1', 'w1')}\n${entry('new2', 'w1')}\n`);

    // A chunk size small enough that "found in the first chunk" is a
    // real claim rather than "the whole file happened to fit in one
    // default 64 KB read" -- the file here is well over 200 KB.
    const chunkSize = 4096;
    const rec = chain.recoverWriterTail(file, 'w1', { chunkSize });
    assert.equal(rec.sealFound, true);
    assert.equal(rec.tailLines.length, 3, 'seal line + new1 + new2 -- not 2003');
    // Bounded by a small, fixed multiple of ONE chunk -- not by the
    // ~200 KB file, which would need ~50 reads of this chunk size.
    assert.ok(rec.bytesScanned <= chunkSize * 2,
      `scanned ${rec.bytesScanned} bytes (chunk size ${chunkSize}) to recover a 3-line tail out of ` +
      '2000+ prior lines -- this should be bounded by the tail, not by the file');
  } finally { away(root); }
});

test('SABOTAGE: a tail scan that stops one line early produces a hash real verification would reject', () => {
  const root = fixtureRoot();
  try {
    const file = errorsFile(root);
    fs.writeFileSync(file, `${entry('a1', 'w1')}\n${entry('a2', 'w1')}\n`);
    chain.appendSeal(file, 'w1');                          // seals a1, a2
    fs.appendFileSync(file, `${entry('a3', 'w1')}\n${entry('a4', 'w1')}\n`);

    const correct = chain.replay(fs.readFileSync(file, 'utf8')).running.get('w1');

    const rec = chain.recoverWriterTail(file, 'w1');
    assert.equal(rec.tailLines.length, 3, 'the real tail is [seal line, a3, a4]');

    // RED, by hand: a tail scan that "stops one line early" -- dropping
    // the SEAL's own line (the earliest line in the real tail) instead
    // of hashing forward from it, which is exactly the off-by-one this
    // design has to avoid (the seal line self-seals; see src/chain.mjs).
    let sabotagedHash = rec.predecessorHash;
    for (const l of rec.tailLines.slice(1)) {
      const e = JSON.parse(l);
      if (chain.writerOf(e) === 'w1') sabotagedHash = chain.chainHash(sabotagedHash, l);
    }
    assert.notEqual(sabotagedHash, correct,
      'if a one-line-early scan matched the correct hash anyway, the defect would be undetectable');

    // GREEN: the shipped implementation does not stop early.
    const seal = chain.appendSeal(file, 'w1');
    assert.equal(seal.chain_seal.hash, correct,
      'the real implementation must hash the seal line itself plus every line after it');
    assert.equal(integrity.checkChain(root).writers.find((w) => w.writer === 'w1').state, 'ok');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// Cadence: wired into memory.logEntry, opt-in via .mem/config.json
// ---------------------------------------------------------------------

function withChainConfig(root, chainSealCadence) {
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    version: 1,
    participants: { user: 'u', session: 's', librarian: 'l' },
    chainSealCadence,
  }, null, 2));
}

test('WIRED IN: memory.logEntry seals automatically once chainSealCadence is configured', () => {
  const root = fixtureRoot();
  try {
    withChainConfig(root, 3);
    for (let i = 0; i < 3; i += 1) memory.logEntry(root, 'error', { title: `e${i}` }, { project: 'p' });

    const { entries } = memory.readLog(root, 'error', { project: 'p' });
    const seals = entries.filter((e) => chain.isSealEntry(e));
    assert.equal(seals.length, 1, 'a seal should have been written automatically once the cadence was reached');

    const report = integrity.checkChain(root);
    assert.equal(report.sealsFound, 1);
    assert.equal(report.tampered.length, 0);
    assert.equal(report.state, 'ok');
  } finally { away(root); }
});

test('OFF BY DEFAULT: memory.logEntry never seals unless chainSealCadence is configured', () => {
  const root = fixtureRoot();
  try {
    // No .mem/config.json at all -- the state of every memory that
    // predates this option, and every existing test fixture elsewhere
    // in this suite.
    for (let i = 0; i < 120; i += 1) memory.logEntry(root, 'error', { title: `e${i}` }, { project: 'p' });
    const { entries } = memory.readLog(root, 'error', { project: 'p' });
    assert.equal(entries.filter((e) => chain.isSealEntry(e)).length, 0,
      'sealing must never fire unless explicitly turned on');
  } finally { away(root); }
});
