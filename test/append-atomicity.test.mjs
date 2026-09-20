// env/append-atomicity: MEASURED, not read off a name (2026-09-20).
//
// **The incident.** The benchmark record `robust.concurrency.filesystem`
// sat at not-measured because three tools disagreed about the SAME
// filesystem, on the SAME machine, at the SAME moment:
//
//     doctor (old version of this check):  ext2/ext3
//     df -T:                               ext4
//     stat -f -c %T:                       ext2/ext3
//
// `doctor` only "agreed" with `stat -f -c %T` because the old check WAS
// `stat -f -c %T` fed through an allow-list — one source wearing two
// names, not two sources agreeing. `df` names the actual driver; `stat -f`
// names the statfs magic number, and ext2/ext3/ext4 share magic 0xEF53,
// so it can never spell "ext4" no matter which is mounted. The old finding
// read `[os/filesystem] filesystem is ext2/ext3 — O_APPEND writes are
// atomic here` — a guarantee derived from a disputed LABEL, never from a
// write. `Behauptet statt gemessen`: claimed instead of measured.
//
// **Why measure instead of read a name.** A name-derived check has no way
// to be right about a filesystem it has never catalogued, and it is
// silently wrong about any mount whose real backing store it cannot see
// (overlay's storage driver, a container's bind mount). Worse: it reports
// `ok` there just as confidently as it does on a filesystem it actually
// understands. This suite proves the replacement (`checkAppendAtomicity`
// in ../src/environment.mjs) performs a real concurrent write-and-check
// instead, reusing the shape `test/concurrent-append.test.mjs` and
// `bench/atlas/phase-robust.mjs` already use for the same property — the
// same probe, not a second implementation of the same truth — sized down
// to fit inside a ~500 ms `mem doctor` budget: worker threads instead of
// full processes, one round instead of ten.
//
// **What it still cannot see.** One round, small volume, one moment in
// time. A PASS here says the write that just happened was not torn; it is
// not a lifetime guarantee, and it cannot see a defect that only shows up
// under sustained load or memory pressure. It also cannot see a network
// mount fail in a way a fast, empty, local test link would never trigger
// — which is exactly why NFS/SMB/FUSE mounts are not measured at all here
// (see the "unknown half" tests below): a clean local round-trip against
// one of those would prove nothing and could look like false assurance.
//
// invariant: leer-ist-kein-bestehen
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkAppendAtomicity, analyzeAppendProbe, runAppendAtomicityProbe, LAYER,
} from '../src/environment.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-append-atomicity-'));
}

// Same PATH-injection technique `test/environment.test.mjs` uses: the
// check shells out to the real `stat` binary with no injection point of
// its own, so a fake `stat` ahead of it on PATH is the only way to name a
// filesystem type this machine does not actually have.
function withFakeStat(fsType, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-append-fakestat-'));
  fs.writeFileSync(path.join(dir, 'stat'), `#!/bin/sh\nprintf '%s' '${fsType}'\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  try {
    return fn();
  } finally {
    process.env.PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A generous timeout for tests that must not be flaky on a slow CI box.
// `checkAppendAtomicity`'s own default (400 ms) is the production budget;
// these tests widen it so a slow runner reports "measured, clean" rather
// than "could not measure in time" and turning a speed problem into a
// spurious red.
const GENEROUS = { timeoutMs: 4000 };

// --- positive control: the probe can produce a definite answer at all -----

test('positive control: on the local filesystem the check returns a definite verdict', () => {
  const root = tmpRoot();
  try {
    const c = checkAppendAtomicity(root, GENEROUS);
    assert.equal(c.layer, LAYER.OS);
    assert.notEqual(c.ok, null, `expected a definite ok/error, got unknown: ${c.detail}`);
    assert.match(c.detail, /^measured:/, 'a definite verdict must say it was measured');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the check performs real work, not a name lookup — timing evidence', () => {
  // A name-derived check answers in a couple of milliseconds no matter
  // what the name is. A real concurrent write-and-check cannot: it has to
  // start threads and wait for a filesystem round-trip. This does not
  // prove correctness on its own, but a check that returns "ok" in under
  // a millisecond has not measured anything, whatever its text claims.
  const root = tmpRoot();
  try {
    const t0 = Date.now();
    const c = checkAppendAtomicity(root, GENEROUS);
    const elapsed = Date.now() - t0;
    assert.notEqual(c.ok, null);
    assert.ok(elapsed >= 5, `finished in ${elapsed}ms — too fast to have measured anything`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('budget: the default (production) probe stays under the ~500ms target', () => {
  const root = tmpRoot();
  try {
    const t0 = Date.now();
    checkAppendAtomicity(root); // default budget, not GENEROUS
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `took ${elapsed}ms — over the ~500ms budget this check must stay under`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- sabotage counter-probe: a torn line must turn the verdict red --------

test('sabotage: a file with a torn line makes the verdict fail, not pass', () => {
  const dir = tmpRoot();
  try {
    const file = path.join(dir, 'probe.jsonl');
    // Two whole entries and one deliberately cut-off mid-write, the same
    // shape `bench/atlas/phase-robust.mjs` uses to sabotage its own
    // detector. A probe that cannot fail here proves nothing.
    fs.writeFileSync(file,
      `${JSON.stringify({ w: 0, i: 0, marker: 'w0e0' })}\n`
      + '{"w":0,"i":1,"marker":"w0e1\n' // torn: cut off before the closing brace
      + `${JSON.stringify({ w: 1, i: 0, marker: 'w1e0' })}\n`);
    const r = analyzeAppendProbe(file, 3);
    assert.equal(r.ok, false, 'a torn line must not be reported as a clean run');
    assert.equal(r.torn, 1);
    assert.equal(r.missing, 1, 'the torn line also cost a marker that never arrived');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sabotage: a duplicated marker also turns the verdict red', () => {
  const dir = tmpRoot();
  try {
    const file = path.join(dir, 'probe.jsonl');
    fs.writeFileSync(file,
      `${JSON.stringify({ w: 0, i: 0, marker: 'w0e0' })}\n`
      + `${JSON.stringify({ w: 0, i: 0, marker: 'w0e0' })}\n` // same marker twice
      + `${JSON.stringify({ w: 1, i: 0, marker: 'w1e0' })}\n`);
    const r = analyzeAppendProbe(file, 3);
    assert.equal(r.ok, false);
    assert.equal(r.duplicates, 1);
    assert.equal(r.torn, 0, 'a duplicate is not the same defect as a torn line — do not conflate them');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sabotage: a missing marker (silently dropped write) also turns the verdict red', () => {
  const dir = tmpRoot();
  try {
    const file = path.join(dir, 'probe.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ w: 0, i: 0, marker: 'w0e0' })}\n`);
    const r = analyzeAppendProbe(file, 2); // one writer's line never showed up
    assert.equal(r.ok, false);
    assert.equal(r.missing, 1);
    assert.equal(r.torn, 0);
    assert.equal(r.duplicates, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the innocence half: a clean run must not be reported as torn ---------

test('innocence: a clean file with every marker exactly once analyzes clean', () => {
  const dir = tmpRoot();
  try {
    const file = path.join(dir, 'probe.jsonl');
    const lines = [];
    for (let w = 0; w < 4; w += 1) {
      for (let i = 0; i < 5; i += 1) lines.push(JSON.stringify({ w, i, marker: `w${w}e${i}` }));
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const r = analyzeAppendProbe(file, 20);
    assert.equal(r.ok, true);
    assert.equal(r.torn, 0);
    assert.equal(r.missing, 0);
    assert.equal(r.duplicates, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('innocence: a real concurrent run on the local filesystem is not reported as torn', async () => {
  // Not a single assertion but several rounds — a flaky FAIL here would be
  // worse than no check at all, so this is checked more than once before
  // trusting it. Every round must come back clean; one bad round is a
  // reportable defect, not noise to average away.
  const root = tmpRoot();
  try {
    for (let round = 0; round < 5; round += 1) {
      const probe = runAppendAtomicityProbe(root, GENEROUS);
      assert.ok(probe.measured, `round ${round} could not even measure: ${probe.reason}`);
      assert.equal(probe.torn, 0, `round ${round}: a clean concurrent run reported a torn line`);
      assert.equal(probe.ok, true, `round ${round}: clean writers reported as unsafe`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- three verdicts, three reasons -----------------------------------------
//
// The rewrite went through one more revision after this file was first
// written, and the revision is worth stating because it changes what
// these tests are for.
//
// The first cut asked for ONE rule: measure, and let the measurement
// decide. That is half right. A run of six writers and forty-eight lines
// that comes back whole shows that no tearing HAPPENED — not that none
// CAN happen. A measurement of this shape can only ever falsify the
// guarantee; it cannot establish it. Letting a clean run alone produce
// `ok` would be the same over-claim as the name-derived verdict it
// replaced, just with a nicer provenance.
//
// So there are three sources and each does only what it is good for:
//
//   documentation says UNSAFE  -> false, and do not measure at all
//   the run tore a line        -> false, whatever the name says
//   the run was clean          -> ok only where documentation AGREES;
//                                 otherwise unknown

test('documented-unsafe mounts report FAIL, from the documentation, unmeasured', () => {
  // `open(2)`: O_APPEND may corrupt files on NFS when more than one
  // process appends at once. That is a published property, not a guess
  // from a name — so this is a determination, and "nicht messbar ist
  // nicht null" does not apply: it was determinable without measuring.
  //
  // And it must NOT be measured. The race is rare rather than
  // impossible, so a clean short run there would look like evidence and
  // be none — a green probe would be worse than no probe.
  for (const fsType of ['nfs', 'nfs4', 'cifs', 'smb2', 'sshfs']) {
    const root = tmpRoot();
    try {
      const t0 = Date.now();
      const c = withFakeStat(fsType, () => checkAppendAtomicity(root, GENEROUS));
      const elapsed = Date.now() - t0;
      assert.equal(c.ok, false, `${fsType}: expected a failing verdict, got ${c.ok}`);
      assert.match(c.detail, new RegExp(fsType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'the verdict must name the mount type');
      assert.match(c.detail, /documented NOT to be atomic/,
        'the text must say where the verdict comes from');
      assert.match(c.detail, /open\(2\)/, 'and name the source');
      assert.match(c.detail, /[Nn]ot measured/,
        'the text must say the probe was deliberately not run');
      assert.ok(elapsed < 50,
        `took ${elapsed}ms — long enough to have measured, which is exactly what must not happen here`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('pass-through mounts stay UNKNOWN even when the run is clean', () => {
  // FUSE, 9p and virtiofs forward to some other filesystem, which may be
  // perfectly safe or arbitrary. Nothing about the name decides, and a
  // clean run does not either — so the third state, with the reason
  // spelled out rather than a bare "unknown".
  for (const fsType of ['fuse', 'fuseblk', '9p', 'virtiofs']) {
    const root = tmpRoot();
    try {
      const c = withFakeStat(fsType, () => checkAppendAtomicity(root, GENEROUS));
      assert.equal(c.ok, null, `${fsType}: expected unknown (null), got ${c.ok}`);
      assert.match(c.detail, /forwards to another filesystem/,
        'the text must say why the name settles nothing');
      assert.match(c.detail, /can falsify the guarantee, never establish it/,
        'and why a clean run settles nothing either');
      assert.doesNotMatch(c.detail, /documented NOT to be atomic/,
        'a pass-through mount must not be described as documented-unsafe');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('an unrecognised name is measured, and a clean run still leaves it UNKNOWN', () => {
  // A name outside every list — the only way to answer at all is to
  // measure, and the measurement DOES run here (unlike the documented
  // -unsafe case). But a clean result cannot lift it to `ok`, because
  // nothing affirms the guarantee for this filesystem.
  const root = tmpRoot();
  try {
    const t0 = Date.now();
    const c = withFakeStat('a-name-linux-does-not-have', () => checkAppendAtomicity(root, GENEROUS));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed > 20,
      `returned in ${elapsed}ms — an unrecognised name must be MEASURED, not looked up`);
    assert.equal(c.ok, null, 'a clean run alone cannot establish the guarantee');
    assert.match(c.detail, /a-name-linux-does-not-have/, 'the name is still reported');
    assert.match(c.detail, /not one whose documentation affirms/,
      'the text must say what is missing: a second source');
    assert.match(c.detail, /none torn, none missing, none duplicated/,
      'and it must still report what the measurement found');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a torn line makes it FAIL even on a filesystem whose name affirms the guarantee', () => {
  // The other direction, and the reason measuring is worth its 100ms at
  // all: the documentation describes the filesystem, the measurement
  // describes THIS mount. Where they disagree, the mount wins.
  const root = tmpRoot();
  try {
    const c = withFakeStat('ext2/ext3', () => checkAppendAtomicity(root, {
      probe: () => ({ measured: true, ok: false, workers: 6, perWorker: 8, expected: 48,
        torn: 1, missing: 1, duplicates: 0 }),
    }));
    assert.equal(c.ok, false,
      'a run that tore a line must fail even where the filesystem name affirms atomicity');
    assert.match(c.detail, /torn/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a name that used to mean instant OK now still gets measured', () => {
  // "ext2/ext3" was on the old allow-list and used to short-circuit to
  // `ok: true` without a single write happening. It must still measure —
  // the label is not a shortcut, even for a label that happens to be
  // trustworthy.
  const root = tmpRoot();
  try {
    const t0 = Date.now();
    const c = withFakeStat('ext2/ext3', () => checkAppendAtomicity(root, GENEROUS));
    const elapsed = Date.now() - t0;
    assert.equal(c.ok, true);
    assert.ok(elapsed >= 5, `finished in ${elapsed}ms — a trusted-sounding name must not skip the measurement`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- measurement failure is unknown, never ok ------------------------------

test('a probe that cannot even run reports unknown, never ok', () => {
  // Ask for an impossibly small timeout so the writers cannot finish in
  // time — simulating "the measurement itself cannot run" without
  // depending on a real permission failure to construct.
  const root = tmpRoot();
  try {
    const probe = runAppendAtomicityProbe(root, { timeoutMs: 0, workers: 6, perWorker: 8, padBytes: 6000 });
    assert.equal(probe.measured, false);
    assert.match(probe.reason, /finished within/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
