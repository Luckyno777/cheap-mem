// no-empty-green — an "ok" that measured zero entries is not health.
//
// **The incident.** `mem doctor` was run twice over otherwise identical
// memories: once freshly initialised and empty, once with 120 real
// entries. The findings' TEXTS were diffed. Of 31 findings, 21 said
// `ok` on the empty memory — and for 10 of those, the text on the empty
// run was byte-for-byte the same shape it would be on any run where the
// thing being counted never showed up, because the count behind it was
// zero. The sharpest case: `archive-backlog` said "raw/ is empty — the
// drain has taken everything" over a memory that had never captured a
// single byte. That sentence describes a successful drain. Nothing had
// ever arrived to drain. In a dispute about whether a pipeline is
// working, that is exactly the line somebody points at.
//
// The other 9: `delivery` ("drawer empty"), `digest` ("nothing
// pending"), `digest-yield`, `entry-form`, `fact-conflicts`, `legacy`,
// `orphan-drawers`, `orphans`, `topic-quality` — each had a real
// denominator (messages ever delivered, captures ever made, entries
// ever logged, facts ever tracked, pointers ever written, topics ever
// assigned) that was zero, and each reported the same "clean" verdict a
// genuinely healthy, well-populated memory would report. "nicht messbar ist nicht null": a check that cannot see its own denominator has to
// say so, not default to the answer that looks like success.
//
// **Why this is shaped as three fixtures, not one.** A single "empty
// memory is not all green" assertion would also go green the moment
// EVERYTHING reports `unknown` — including the six checks that measure
// the ENVIRONMENT (participants configured, redaction canaries, git
// itself, the merge driver, append atomicity) and have a real,
// non-corpus denominator that is satisfied on a bare `mem init`. A fix
// that is too eager and turns those into `unknown` too would pass a
// test that only checks "the ten are not ok", while quietly teaching
// people to ignore doctor output for a different reason — "a guard
// that flags innocents gets switched off". So the guarantee and the
// counter-probe run over the SAME empty memory, in the same test run,
// and the counter-probe fails loudly if the fix over-corrected.
//
// **What this would miss.** It does not check every one of the 31
// findings individually — only the ten named in the incident, plus a
// generic sweep (any OTHER `ok` finding on this fixture must also name
// a positive count, unless it is one of the eleven known-fine
// exceptions). A finding added later that invents its own new way to
// say "clean" over zero would only be caught by that generic sweep if
// its text carries no digit at all — a cosmetic "all good" with a
// stray unrelated number in it would slip through. And the filled
// fixture is built once, by hand, to give each of the ten a small but
// real, positive count; it is not a fuzzer and proves nothing about
// corpora shaped very differently from this one.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as doctor from '../src/doctor.mjs';
import * as memory from '../src/memory.mjs';
import * as cfgmod from '../src/config.mjs';
import * as inbox from '../src/inbox.mjs';
import * as raw from '../src/raw.mjs';
import * as agents from '../src/agents.mjs';

const MEM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

// The findings named in the incident that really do report over a zero
// denominator. Ten were named; `archive-backlog` left the list on
// 2026-09-20 — it inspected the folder and found it empty, which
// answers its own question. See EXEMPT below for the full argument.
const TARGET = [
  'delivery', 'digest', 'digest-yield', 'entry-form',
  'fact-conflicts', 'legacy', 'orphan-drawers', 'orphans', 'topic-quality',
];

// The six environment guarantees — a real denominator that measures the
// LAYER, not the corpus, and is satisfied by a bare `mem init`. Never
// supposed to move off `ok` here.
const SIX_INNOCENTS = [
  'config', 'redaction', 'gitignore', 'git', 'env/merge-driver', 'env/append-atomicity',
];

// The five that already had a moving denominator before this fix and
// were never part of the incident (root: the path exists or it does
// not; integrity/corpus-size: "0 entries" over a genuinely empty log
// set is the correct, honest count, not a hidden claim of health;
// drawers/append-only-git: report the skeleton `mem init` itself
// writes). Together with the six above these are the eleven findings
// the measurement found legitimately green on an empty memory.
const FIVE_MOVING_DENOMINATOR = ['root', 'integrity', 'corpus-size', 'drawers', 'append-only-git'];

/**
 * Findings allowed to report `ok` on an empty memory without naming a
 * positive count — each with the reason, in the file, where it can be
 * argued with.
 *
 * **The rule got sharper on 2026-09-20.** "No `ok` over a zero count"
 * was the first formulation and it was too blunt: it would have turned
 * `archive-backlog` unknown, and the sister house had already written
 * down why that is wrong — an empty folder is measurably empty, and
 * calling that "not measurable" is a false unknown.
 *
 * The rule that survives both cases: **a finding may report `ok` only
 * if it can say what it inspected.** `archive-backlog` inspected the
 * folder. `topic-quality` inspected nothing — it had no topic to judge
 * — and that one really is unknown.
 *
 * A reason is required for every entry, and the control below refuses a
 * reason that says nothing. An exemption list without arguments is how
 * a guarantee quietly stops guaranteeing.
 */
const EXEMPT = new Map([
  ...SIX_INNOCENTS.map((n) => [n, 'checks the LAYER, not the corpus — fully answerable on a bare init']),
  ...FIVE_MOVING_DENOMINATOR.map((n) => [n, 'its count moves with the corpus and is honestly 0 here']),
  ['archive-backlog', 'inspected the folder and found it empty, which answers "is anything '
    + 'piling up"; and if captures stop arriving, `capture` warns — a finding that stays '
    + 'quiet because a neighbour speaks hides nothing'],
]);

const EXEMPT_FROM_COUNT_RULE = new Set(EXEMPT.keys());

const hasPositiveCount = (text) => /[1-9]\d*/.test(String(text ?? ''));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const gone = (root) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/**
 * A freshly initialised, empty, git-committed memory — the exact shape
 * `mem init` hands a new user, with nothing logged into it yet. Built
 * through the real CLI and a real commit (not a hand-rolled skeleton)
 * because several of the eleven legitimately-green findings (`git`,
 * `gitignore`, the `env/*` checks) test the git layer itself, and a
 * fixture that fakes the files without the repository would not
 * exercise them at all.
 */
function buildEmptyMemory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-empty-'));
  execFileSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8', timeout: 30000 });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
  return root;
}

/** A capture with the timestamp encoded in the name, the way raw.mjs writes it. */
function putCapture(root, label, offsetMs = 0) {
  const stamp = new Date(Date.now() - offsetMs).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
  const rel = path.join('raw', stamp.slice(0, 4), stamp.slice(5, 7), `${stamp}--${label}.jsonl.gz`);
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, zlib.gzipSync(Buffer.from('{"text":"ordinary capture, no secrets"}\n', 'utf8')));
  return rel;
}

/**
 * A memory with ~120 real entries, built so EVERY ONE of the ten target
 * findings has a small but genuinely positive denominator: real
 * captures (archive-backlog, digest, digest-yield, legacy), a real
 * inbox message (delivery), real timeline facts (fact-conflicts), a
 * real correction pointer (orphans), reused topics (topic-quality),
 * plus one deliberately malformed entry and one deliberately misnamed
 * log file so entry-form and orphan-drawers have real damage to name
 * instead of nothing to scan.
 */
function buildFilledMemory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-filled-'));
  cfgmod.writeConfig(root, cfgmod.DEFAULT_CONFIG);
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true });

  // The bulk: ordinary decisions and learnings, reusing 20 topics so
  // topic-quality's entries-per-topic ratio is a real thread, not a
  // pile of one-offs.
  for (let i = 0; i < 100; i += 1) {
    memory.logEntry(root, 'decision', {
      topic: `area/topic-${i % 20}`, choice: `choice number ${i}`, why: 'because the numbers say so',
    });
  }
  for (let i = 0; i < 20; i += 1) {
    memory.logEntry(root, 'learning', { topic: `area/topic-${i % 20}`, title: `lesson ${i}`, text: 'do it differently' });
  }

  // fact-conflicts: a real fact tracked over time, no conflict.
  memory.logEntry(root, 'timeline', { key: 'service.port', value: '8000', valid_from: '2026-01-01' });
  memory.logEntry(root, 'timeline', { key: 'service.port', value: '9000', valid_from: '2026-02-01' });

  // orphans: a real correction pointing at a real entry.
  const { entry: base } = memory.logEntry(root, 'decision', { title: 'base decision', choice: 'x', why: 'y' });
  memory.logEntry(root, 'decision', { title: 'corrected decision', choice: 'x2', why: 'y2', replaces_id: base.id });

  // delivery: one message to a registered recipient. `listAgents` reads
  // `agents/<name>/`, not `.mem/config.json`'s participants — a message
  // to a bare config participant with no agent folder is (correctly)
  // an unknown recipient, so a registered agent is created here.
  agents.createAgent(root, 'user', {});
  const cfg = cfgmod.readConfig(root);
  inbox.write(root, cfg.participants, { from: 'session', to: 'user', subject: 'status', text: 'all quiet' });

  // archive-backlog / digest / digest-yield / legacy: five real, valid
  // gzip captures, four digested with entries pointing back at them,
  // one left open and fresh (so digest reports real, not-due backlog).
  const caps = [];
  for (let i = 0; i < 5; i += 1) caps.push(putCapture(root, `cap${i}`, i * 1000));
  raw.markDigested(root, caps.slice(0, 4));
  for (let i = 0; i < 4; i += 1) {
    memory.logEntry(root, 'thought', { text: `drawn from capture ${i}`, origin: { raw: caps[i] } });
  }

  // entry-form: one hand-written malformed line — a swallowed value —
  // among everything else, so the check has real damage to name.
  fs.appendFileSync(path.join(root, 'global', 'learnings.jsonl'),
    `${JSON.stringify({
      id: 'malformed-1', ts: '2026-01-01T00:00:00Z', title: true, 'a swallowed field': true,
    })}\n`);

  // orphan-drawers: one .jsonl file that matches no known type.
  fs.writeFileSync(path.join(root, 'global', 'mystery.jsonl'), '{"whatever":1}\n');

  return root;
}

// --- POSITIVE CONTROL --------------------------------------------------

test('POSITIVE CONTROL: the harness sees findings at all over an empty memory', () => {
  const root = buildEmptyMemory();
  try {
    const { findings } = doctor.checkAll(root);
    // If this collapses to zero, every assertion below would pass
    // vacuously — "no offenders found" is also true of an empty list.
    assert.ok(findings.length >= 20,
      `only ${findings.length} findings came back — the harness itself is broken, `
      + 'not the ten findings this file exists to check');
  } finally { gone(root); }
});

// --- THE GUARANTEE -------------------------------------------------------

test('GUARANTEE: no finding is ok over an empty memory without naming a positive count', () => {
  const root = buildEmptyMemory();
  try {
    const { findings } = doctor.checkAll(root);
    assert.ok(findings.length > 0, 'positive control failed inside the guarantee run too');

    // The ten by name: each must have moved OFF `ok` on this fixture.
    // "unknown" (or anything else) is fine — `ok` is the only failure.
    const stillGreen = TARGET
      .map((name) => findings.find((f) => f.name === name))
      .filter((f) => f && f.level === doctor.LEVEL.GOOD);
    assert.deepEqual(stillGreen.map((f) => f.name), [],
      `still reporting ok over a zero denominator on a freshly initialised, empty memory: ${
        stillGreen.map((f) => `${f.name} (${f.text})`).join('; ')}`);

    // The general sweep: ANY finding reporting `ok` here, other than the
    // eleven with a legitimate non-corpus or already-moving denominator,
    // must name a positive count in its text — otherwise its "ok" is as
    // unearned as the ten above were.
    const offenders = findings.filter((f) => f.level === doctor.LEVEL.GOOD
      && !EXEMPT_FROM_COUNT_RULE.has(f.name)
      && !hasPositiveCount(f.text));
    assert.deepEqual(offenders.map((f) => f.name), [],
      `finding(s) report ok over what looks like a zero denominator, without naming a count: ${
        offenders.map((f) => `${f.name} (${JSON.stringify(f.text)})`).join('; ')}`);
  } finally { gone(root); }
});

// --- THE INNOCENCE COUNTER-PROBE -----------------------------------------

test('INNOCENCE COUNTER-PROBE: the six environment guarantees stay ok on the same empty memory', () => {
  // "Ein Riegel, der Unschuldige meldet, wird abgeschaltet." If fixing
  // the ten above pushed one of these into `unknown` too, this is where
  // it shows: these six measure the LAYER (participants configured,
  // redaction armed, git ignoring what it must, the merge driver, atomic
  // appends), and every one of those is fully answerable from a bare
  // `mem init` — there is nothing here for them to wait for.
  const root = buildEmptyMemory();
  try {
    const { findings } = doctor.checkAll(root);
    const broken = SIX_INNOCENTS.map((name) => {
      const f = findings.find((x) => x.name === name);
      return { name, level: f ? f.level : 'MISSING', text: f ? f.text : null };
    }).filter((x) => x.level !== doctor.LEVEL.GOOD);
    assert.deepEqual(broken, [],
      `an innocent got flagged: ${broken.map((x) => `${x.name}=${x.level}`).join(', ')}`);
  } finally { gone(root); }
});

test('CONTROL: every exemption carries a reason that argues', () => {
  // Without this the exemption list is a place to make failures go away.
  // A reason must be a sentence someone can disagree with, not a label.
  for (const [name, why] of EXEMPT) {
    assert.ok(typeof why === 'string' && why.length >= 40,
      `the exemption for '${name}' has no real reason: ${JSON.stringify(why)}`);
    assert.ok(/ — |because|which|and /.test(why),
      `the exemption for '${name}' states a category, not an argument: ${why}`);
  }
  // And it must not grow without anyone noticing.
  assert.equal(EXEMPT.size, 12,
    `the exemption list is now ${EXEMPT.size} long. Every addition needs an argument in `
    + 'the file and a deliberate change here — that is the point of pinning the number.');
});

// --- THE FILLED-MEMORY CONTROL --------------------------------------------

test('FILLED-MEMORY CONTROL: the same ten report their normal levels, with a positive count', () => {
  // Proves the fix touched only the empty case: over real content, none
  // of the ten may sit at `unknown` (that would mean the new zero-check
  // is over-firing on real data), and each must show a real, positive
  // count — the same property the empty-memory guarantee tests for the
  // absence of.
  const root = buildFilledMemory();
  try {
    const { findings } = doctor.checkAll(root);
    const byName = Object.fromEntries(TARGET.map((n) => [n, findings.find((f) => f.name === n)]));

    const missing = TARGET.filter((n) => !byName[n]);
    assert.deepEqual(missing, [], `finding(s) not produced at all over a filled memory: ${missing.join(', ')}`);

    const stillUnknown = TARGET.filter((n) => byName[n].level === doctor.LEVEL.UNKNOWN);
    assert.deepEqual(stillUnknown, [],
      `finding(s) still report unknown over ~120 real entries — the fix is not invisible on a filled `
      + `memory: ${stillUnknown.map((n) => `${n} (${byName[n].text})`).join('; ')}`);

    const noCount = TARGET.filter((n) => !hasPositiveCount(byName[n].text));
    assert.deepEqual(noCount, [],
      `finding(s) report a normal level but name no positive count over real content: ${
        noCount.map((n) => `${n} (${byName[n].text})`).join('; ')}`);
  } finally { gone(root); }
});
