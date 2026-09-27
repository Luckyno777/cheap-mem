// The agent ledger: count jobs, do not claim strengths.
//
// Four things the task named explicitly: a synthetic journal through
// to the ledger, n<20 -> unknown, a missing field -> 'unknown', and the
// red proof (done separately for this session, see the report — this
// module did not exist before it, and every import failed without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as memory from '../src/memory.mjs';
import * as ledger from '../src/agentledger.mjs';

function build() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ledger-'));
  fs.mkdirSync(path.join(w, 'global'), { recursive: true });
  fs.mkdirSync(path.join(w, 'projects'), { recursive: true });
  return w;
}
const wipe = (w) => fs.rmSync(w, { recursive: true, force: true });

/** A job through the structured convention. */
function logStructured(w, { pkg, model, agentKind = null, firstTry, ts }) {
  const fields = ledger.buildJobFields({
    package: pkg, model, agent_kind: agentKind, first_try: firstTry,
  });
  memory.logEntry(w, 'event', {
    title: `Job ${pkg}`, text: `Job ${pkg}, synthetic.`,
    tags: ['job', 'agents', pkg.toLowerCase()],
    agent: 'human:root', ...fields,
  }, { now: ts ? new Date(ts) : undefined });
}

// git is never really invoked — same stub convention as the module's
// own doc comment implies. Without a stub every probe would run
// against this session's own commit history and measure that instead.
const NO_GIT = () => '';

test('empty journal: no jobs, no rows, git ran', () => {
  const w = build();
  try {
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.totalJobs, 0);
    assert.deepEqual(r.rows, []);
    assert.equal(r.agentsWithEvidence, 0);
    assert.equal(r.git, true);
  } finally { wipe(w); }
});

test('synthetic journal -> ledger grouped by agent kind/model', () => {
  const w = build();
  try {
    logStructured(w, { pkg: 'X1', model: 'Sonnet 5', agentKind: 'package-agent', firstTry: true });
    logStructured(w, { pkg: 'X2', model: 'Sonnet 5', agentKind: 'package-agent', firstTry: true });
    logStructured(w, { pkg: 'X3', model: 'Sonnet 5', agentKind: 'package-agent', firstTry: false });
    logStructured(w, { pkg: 'Y1', model: 'Opus 5.5', agentKind: 'orchestrator', firstTry: true });

    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.totalJobs, 4);
    assert.equal(r.unassigned, 0);

    const sonnet = r.rows.find((z) => z.model === 'Sonnet 5');
    assert.equal(sonnet.agent_kind, 'package-agent');
    assert.equal(sonnet.jobs, 3);
    assert.equal(sonnet.firstTryOk, 2);
    assert.equal(sonnet.followUps, 1);
    assert.equal(sonnet.packagesReverted, 0);

    const opus = r.rows.find((z) => z.model === 'Opus 5.5');
    assert.equal(opus.jobs, 1);
    assert.equal(opus.firstTryOk, 1);
  } finally { wipe(w); }
});

test('under 20 jobs: verdict is always "unknown (n<20)", never a strength', () => {
  const w = build();
  try {
    for (let i = 0; i < 19; i += 1) {
      logStructured(w, { pkg: `Z${i}`, model: 'Sonnet 5', firstTry: true });
    }
    const r = ledger.ledger(w, { git: NO_GIT });
    const row = r.rows[0];
    assert.equal(row.jobs, 19);
    assert.equal(row.verdict, ledger.VERDICT.UNKNOWN_N20);
    assert.equal(r.agentsWithEvidence, 0);
  } finally { wipe(w); }
});

test('at 20 jobs with a high first-try share: notably strong, backed by a count', () => {
  const w = build();
  try {
    for (let i = 0; i < 20; i += 1) {
      logStructured(w, { pkg: `G${i}`, model: 'Sonnet 5', firstTry: i < 19 });
    }
    const r = ledger.ledger(w, { git: NO_GIT });
    const row = r.rows[0];
    assert.equal(row.jobs, 20);
    assert.equal(row.firstTryOk, 19);
    assert.equal(row.verdict, ledger.VERDICT.NOTABLY_STRONG);
    assert.equal(r.agentsWithEvidence, 1);
  } finally { wipe(w); }
});

test('at 20 jobs with a low first-try share: notably weak', () => {
  const w = build();
  try {
    for (let i = 0; i < 20; i += 1) {
      logStructured(w, { pkg: `S${i}`, model: 'Haiku', firstTry: i < 8 });
    }
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.rows[0].verdict, ledger.VERDICT.NOTABLY_WEAK);
  } finally { wipe(w); }
});

test('at 20 jobs in the middle: unremarkable', () => {
  const w = build();
  try {
    for (let i = 0; i < 20; i += 1) {
      logStructured(w, { pkg: `M${i}`, model: 'Haiku', firstTry: i < 14 });
    }
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.rows[0].verdict, ledger.VERDICT.UNREMARKABLE);
  } finally { wipe(w); }
});

test('missing model in a structured entry -> "unknown", never guessed', () => {
  const w = build();
  try {
    memory.logEntry(w, 'event', {
      title: 'Job without a model', text: 'no model field',
      tags: ['job', 'agents', 'oq1'], agent: 'human:root',
      package: 'OQ1', first_try: 'yes',
    });
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.rows[0].model, 'unknown');
  } finally { wipe(w); }
});

test('missing agent_kind -> "unknown"', () => {
  const w = build();
  try {
    memory.logEntry(w, 'event', {
      title: 'Job C2', text: 'C2, no agent_kind field at all.',
      tags: ['job', 'agents', 'c2'], agent: 'human:root',
      package: 'C2', model: 'Sonnet 5', first_try: 'yes',
    });
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].agent_kind, 'unknown');
    assert.equal(r.rows[0].model, 'Sonnet 5');
    assert.equal(r.rows[0].firstTryOk, 1);
  } finally { wipe(w); }
});

test('an event tagged "job" but with no package at all lands in unassigned', () => {
  const w = build();
  try {
    memory.logEntry(w, 'event', {
      title: 'Job lever built', text: 'Builds the mechanism itself, not a package.',
      tags: ['job', 'cost'], agent: 'human:root',
    });
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.totalJobs, 0);
    assert.equal(r.unassigned, 1);
  } finally { wipe(w); }
});

test('an event without the tag "job" is not read at all', () => {
  const w = build();
  try {
    memory.logEntry(w, 'event', {
      title: 'X done', text: 'not in the job journal',
      tags: ['wave1'], agent: 'human:root',
    });
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.totalJobs, 0);
    assert.equal(r.unassigned, 0);
  } finally { wipe(w); }
});

test('"follow-up" in free text counts as a follow-up, even without the structured field', () => {
  const w = build();
  try {
    memory.logEntry(w, 'event', {
      title: 'Job Q1', text: 'Q1: coverage floor 0.7. Follow-up needed, the first pass only saw ranking.',
      tags: ['job', 'wave2'], agent: 'human:root',
      package: 'Q1', model: 'Sonnet 5', first_try: 'yes',
    });
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.rows[0].followUps, 1);
    assert.equal(r.rows[0].firstTryOk, 0);
  } finally { wipe(w); }
});

test('commit signal "<package>-followup" on an open branch counts as a follow-up', () => {
  const w = build();
  try {
    logStructured(w, { pkg: 'S6', model: 'Sonnet 5', firstTry: true });
    const gitStub = (args) => {
      assert.deepEqual(args, ['log', '--all', '--format=%H|%s']);
      return [
        'aaa1111|S6-followup: Read only gets the OPEN head',
        'bbb2222|A completely unrelated commit',
      ].join('\n');
    };
    const r = ledger.ledger(w, { git: gitStub });
    assert.equal(r.rows[0].followUps, 1);
    assert.equal(r.rows[0].firstTryOk, 0);
  } finally { wipe(w); }
});

test('a bundled package ("S6+L6+F3") matches a commit signal on ONE part-package', () => {
  const w = build();
  try {
    memory.logEntry(w, 'event', {
      title: 'S6+L6+F3 done', text: 'all three finished.',
      tags: ['job', 'wave3'], agent: 'human:root',
      package: 'S6+L6+F3', first_try: 'yes',
    });
    const gitStub = () => 'ccc3333|S6-followup: Read only gets the OPEN head';
    const r = ledger.ledger(w, { git: gitStub });
    assert.equal(r.rows[0].followUps, 1);
  } finally { wipe(w); }
});

test('a duplicate commit hash on two branches is counted only once', () => {
  const w = build();
  try {
    logStructured(w, { pkg: 'C10', model: 'Sonnet 5', firstTry: true });
    const gitStub = () => [
      'zzz9999|C10-followup: role via agentDefault()',
      'zzz9999|C10-followup: role via agentDefault()', // same hash, second branch
    ].join('\n');
    const sig = ledger.commitSignals(w, { git: gitStub });
    assert.equal(sig.followUp.get('c10').length, 1);
  } finally { wipe(w); }
});

test('a real "Revert" commit marks the package as reverted', () => {
  const w = build();
  try {
    logStructured(w, { pkg: 'R1', model: 'Sonnet 5', firstTry: true });
    const gitStub = () => 'ddd4444|Revert "R1-done: something"';
    const r = ledger.ledger(w, { git: gitStub });
    assert.equal(r.rows[0].packagesReverted, 1);
    // A revert is not by itself evidence of a follow-up — the two
    // counts stay separate (see module head).
    assert.equal(r.rows[0].firstTryOk, 1);
  } finally { wipe(w); }
});

test('a bare word "reverted" without the git-revert shape is NOT evidence of a revert', () => {
  const w = build();
  try {
    logStructured(w, { pkg: 'F9', model: 'Sonnet 5', firstTry: true });
    const gitStub = () => 'eee5555|handler: seven catches tightened, the cursor reverted';
    const r = ledger.ledger(w, { git: gitStub });
    assert.equal(r.rows[0].packagesReverted, 0);
  } finally { wipe(w); }
});

test('git not runnable: the ledger does not abort, and says so (no silent "0")', () => {
  const w = build();
  try {
    logStructured(w, { pkg: 'K1', model: 'Sonnet 5', firstTry: true });
    const brokenGit = () => { throw new Error('git not found'); };
    const r = ledger.ledger(w, { git: brokenGit });
    assert.equal(r.git, false);
    assert.equal(r.rows[0].jobs, 1);
    assert.match(ledger.reportText(r), /git could not run/);
  } finally { wipe(w); }
});

test('buildJobFields: package is required, first_try must be a bool', () => {
  assert.throws(() => ledger.buildJobFields({ first_try: true }), /package is missing/);
  assert.throws(() => ledger.buildJobFields({ package: 'X', first_try: 'yes' }), /first_try/);
});

test('buildJobFields: missing agent_kind/model become the string "unknown", not null', () => {
  const fields = ledger.buildJobFields({ package: 'X9', first_try: false });
  assert.equal(fields.agent_kind, 'unknown');
  assert.equal(fields.model, 'unknown');
  assert.equal(fields.first_try, 'no');
  assert.equal(fields.follow_ups, 0);
});

test('reportText names the count with every verdict — never a claim without one', () => {
  const w = build();
  try {
    for (let i = 0; i < 20; i += 1) {
      logStructured(w, { pkg: `T${i}`, model: 'Sonnet 5', firstTry: true });
    }
    const r = ledger.ledger(w, { git: NO_GIT });
    const text = ledger.reportText(r);
    assert.match(text, /20/);
    assert.match(text, /notably strong/);
  } finally { wipe(w); }
});

test('an empty journal reports "no jobs recorded", not a silent green zero', () => {
  const w = build();
  try {
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.match(ledger.reportText(r), /no jobs recorded/);
  } finally { wipe(w); }
});

// --- A REAL git repo, not a stub -------------------------------------
//
// Every other revert probe hands the module a canned commit line. This
// one runs `git revert` for real, against the module's own default git
// call (no `{ git }` stub at all), so a change to the argument shape
// `commitSignals` passes to `execFileSync` would show up here even if
// every stub above stayed green.
//
// House rule: never `git` inside cheap-mem itself. This builds its OWN,
// brand-new repository under the OS temp dir.
function realGitRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ledger-git-'));
  execFileSync('git', ['init', '-q'], { cwd: r });
  execFileSync('git', ['config', 'user.email', 'ledger@example.test'], { cwd: r });
  execFileSync('git', ['config', 'user.name', 'ledger test'], { cwd: r });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.mkdirSync(path.join(r, 'projects'), { recursive: true });
  return r;
}
// Commits exactly the files already `git add`ed by the caller — never
// `-A`. The job entries live under global/ in the SAME directory, and
// `-A` would sweep them into the commit too: reverting it would then
// delete the memory's own log line along with the code, which is not
// what a real package revert does.
function commit(r, message) {
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: r });
}

test('REAL GIT: a real `git revert` commit is picked up with no stub at all', () => {
  const w = realGitRoot();
  try {
    logStructured(w, { pkg: 'V1', model: 'Sonnet 5', firstTry: true });
    // Committed separately from the job entry itself: reverting this
    // commit must undo the CODE it names, never the memory's own log
    // file — the job entry has to survive the revert exactly as a real
    // package revert would leave it.
    fs.writeFileSync(path.join(w, 'code.txt'), 'v1\n');
    execFileSync('git', ['add', 'code.txt'], { cwd: w });
    commit(w, 'V1-done: something worth reverting');
    execFileSync('git', ['revert', '--no-edit', 'HEAD'], { cwd: w });

    const r = ledger.ledger(w); // no { git } — the module's own execFileSync call
    assert.equal(r.git, true);
    assert.equal(r.rows[0].jobs, 1);
    assert.equal(r.rows[0].packagesReverted, 1);
    // The revert alone is not evidence of a follow-up.
    assert.equal(r.rows[0].firstTryOk, 1);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('REAL GIT: a followup commit on an OPEN branch (never merged) is still seen', () => {
  const w = realGitRoot();
  try {
    logStructured(w, { pkg: 'V2', model: 'Sonnet 5', firstTry: true });
    fs.writeFileSync(path.join(w, 'code.txt'), 'initial\n');
    execFileSync('git', ['add', 'code.txt'], { cwd: w });
    commit(w, 'initial job entry');
    execFileSync('git', ['checkout', '-q', '-b', 'agent/open-branch'], { cwd: w });
    fs.writeFileSync(path.join(w, 'note.txt'), 'a follow-up fix\n');
    execFileSync('git', ['add', 'note.txt'], { cwd: w });
    commit(w, 'V2-followup: fixed on an open branch, never merged to main');

    const r = ledger.ledger(w);
    assert.equal(r.git, true);
    assert.equal(r.rows[0].followUps, 1);
    assert.equal(r.rows[0].firstTryOk, 0);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});
