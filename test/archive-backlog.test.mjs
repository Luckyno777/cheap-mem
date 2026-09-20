// `archive-backlog` — how much raw material lies in the clone and never drains?
//
// **The failure this probe stands against (measured 2026-09-19).** The
// drain command — the one that pulls a capture out of the tracked
// capture folder into the machine archive, verifies it by checksum and
// only then removes the original — was built on 2026-09-18 in the
// sibling house. Built, tested, documented. And never called: no unit,
// no timer, no hook. Measured on 2026-09-19: 1382 captures, 85.5 MB in
// the tracked folder, the oldest from 2026-08-30 — twenty days. The git
// pack was 86.6 MiB, so the memory consisted almost entirely of its own
// raw material, and from outside that looked exactly like a drain that
// had just run.
//
// **Why this measures the age and not the amount.** On an ephemeral
// machine fresh material belongs in the tracked folder — it is the only
// storage that outlives the container. An amount threshold would report
// innocents there, and a bolt that reports innocents gets switched off.
// A capture that has been lying for days is the same finding anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as archive from '../src/archive.mjs';
import {
  checkArchiveBacklog, LEVEL,
  BACKLOG_LATE_DAYS, BACKLOG_DEAD_DAYS,
} from '../src/doctor.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-09-19T12:00:00Z');

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-backlog-'));
const gone = (root) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/** A capture with the timestamp IN ITS NAME, the way raw.mjs writes it. */
function capture(root, msOld, { name = null } = {}) {
  const d = new Date(NOW - msOld).toISOString();
  const stamp = name ?? `${d.slice(0, 19).replace(/:/g, '-')}Z--probe.jsonl.gz`;
  const dir = path.join(root, archive.DEFAULT_LOCATION, d.slice(0, 4), d.slice(5, 7));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stamp), Buffer.alloc(1024, 7));
  return path.join(dir, stamp);
}

const check = (root) => checkArchiveBacklog(root, { env: {}, now: NOW });

// **These two were nearly changed to UNKNOWN on 2026-09-20, and that
// was wrong.** The measurement that day found 13 of 31 findings
// reporting ok over a zero count, and this looked like the sharpest of
// them: "raw/ is empty — the drain has taken everything", claimed where
// nothing ever arrived.
//
// Only the SENTENCE was wrong. The level was right, and the sister
// house had already written down why, in its own test: an empty folder
// is measurably empty, and turning that into "not measurable" is a
// false unknown. The question this finding asks — is anything piling up
// here? — is answered by looking, and the folder was looked at.
//
// The other half of why GOOD is safe: if captures stop arriving, the
// silence belongs to `capture`, which says "no captures at all" and
// warns. A finding that stays quiet because a neighbour speaks hides
// nothing. `topic-quality` has no such neighbour and really is unknown
// on an empty memory — same measurement, opposite answer, and the
// difference is the question, not the count.

test('no capture folder is good — and does not claim a drain that never ran', () => {
  const root = tmpRoot();
  try {
    const f = check(root);
    assert.equal(f.level, LEVEL.GOOD, f.text);
    assert.doesNotMatch(f.text, /the drain has taken everything/,
      'nothing ever arrived here for a drain to take');
  } finally { gone(root); }
});

test('an empty capture folder is good, and says why it is empty', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, archive.DEFAULT_LOCATION), { recursive: true });
  try {
    const f = check(root);
    assert.equal(f.level, LEVEL.GOOD, f.text);
    assert.doesNotMatch(f.text, /the drain has taken everything/,
      'a successful drain was reported where nothing ever arrived');
    assert.match(f.text, /no capture has ever been recorded/,
      'the reader cannot tell an idle drain from a working one');
  } finally { gone(root); }
});

test('fresh material is good — the transport is allowed to be full', () => {
  // Exactly the innocents: a container that captured today and whose
  // captures have not been collected yet. No finding.
  const root = tmpRoot();
  try {
    for (let i = 0; i < 40; i += 1) capture(root, i * 3600000);   // 40 captures, all < 2 days
    const f = check(root);
    assert.equal(f.level, LEVEL.GOOD, f.text);
    assert.match(f.text, /40 captures/);
  } finally { gone(root); }
});

test('older than the late threshold: warning, with age and amount in the text', () => {
  const root = tmpRoot();
  try {
    capture(root, 0);
    capture(root, (BACKLOG_LATE_DAYS + 0.5) * DAY);
    const f = check(root);
    assert.equal(f.level, LEVEL.WARN, f.text);
    assert.match(f.text, /2 captures/);
    assert.match(f.text, /2\.5 days/);
    assert.ok(f.advice, 'a warning without advice leaves the reader standing');
  } finally { gone(root); }
});

test('older than the dead threshold: error, and the advice names the command', () => {
  const root = tmpRoot();
  try {
    capture(root, (BACKLOG_DEAD_DAYS + 13) * DAY);   // the measured case: 20 days
    const f = check(root);
    assert.equal(f.level, LEVEL.ERROR, f.text);
    assert.match(f.text, /20\.0 days/);
    assert.match(f.advice, /mem raw migrate --remove/);
  } finally { gone(root); }
});

test('the threshold is an edge, not a feeling', () => {
  // Just under is good, just over is a warning. Without this probe the
  // threshold could be off by a factor and both cases would look
  // familiar.
  const root = tmpRoot();
  try {
    const dir = path.join(root, archive.DEFAULT_LOCATION);
    capture(root, BACKLOG_LATE_DAYS * DAY - 60000);
    assert.equal(check(root).level, LEVEL.GOOD);
    fs.rmSync(dir, { recursive: true, force: true });
    capture(root, BACKLOG_LATE_DAYS * DAY + 60000);
    assert.equal(check(root).level, LEVEL.WARN);
  } finally { gone(root); }
});

test('the timestamp comes from the NAME, not from the mtime', () => {
  // A fresh clone sets every mtime to the clone time. A finding that
  // reads the mtime reports "all fresh" there — and a fresh clone is
  // exactly where it gets read.
  const root = tmpRoot();
  try {
    const p = capture(root, 20 * DAY);
    fs.utimesSync(p, new Date(NOW), new Date(NOW));   // just cloned
    const f = check(root);
    assert.equal(f.level, LEVEL.ERROR, f.text);
    assert.match(f.text, /20\.0 days/);
  } finally { gone(root); }
});

test('a name without a readable timestamp is UNKNOWN, not fresh', () => {
  // Not measurable is not zero. Were this "good", a renamed stock would
  // hide the whole backlog.
  const root = tmpRoot();
  try {
    capture(root, 20 * DAY, { name: 'anything.jsonl.gz' });
    const f = check(root);
    assert.equal(f.level, LEVEL.UNKNOWN, f.text);
    assert.match(f.text, /not one with a readable/);
  } finally { gone(root); }
});

test('only .jsonl.gz counts — the folder carries other files too', () => {
  const root = tmpRoot();
  try {
    const base = path.join(root, archive.DEFAULT_LOCATION);
    fs.mkdirSync(path.join(base, '2026', '08'), { recursive: true });
    fs.writeFileSync(path.join(base, '.keep'), '');
    fs.writeFileSync(path.join(base, '2026', '08', 'README.md'), '# not a capture\n');
    const f = check(root);
    assert.equal(f.level, LEVEL.GOOD, f.text);
    assert.doesNotMatch(f.text, /\b[1-9]\d* captures?\b/,
      'files that are not .jsonl.gz were counted as captures');
  } finally { gone(root); }
});
