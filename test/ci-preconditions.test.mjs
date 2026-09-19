// A CI step that carries a precondition in its name must establish it
// and then measure it.
//
// **What this is here for (measured 2026-09-17).** The step
// `mem-digest.ps1 exits cleanly when nothing is due` created an empty
// root — the precondition was correctly established — and then checked
// `$LASTEXITCODE -ne 0`. But `exit 0` is what the tick returns for
// "not due" AND for a digest that ran to completion. One code, two
// outcomes. No fake model was planted and no call was counted, so a
// tick that fired a model on an empty pile passed the step that exists
// to forbid exactly that.
//
// The sibling memory had the mirror image of the same defect, twice in
// the same file, and fixing one half left the other standing. That is
// why this probe states the RULE and finds the steps itself, instead of
// naming the ones that exist today. A third digest step added next
// month falls out on its first day.
//
// The rule: whoever starts a digest script in CI must first ask
// `mem digest due` and act on the answer. Both halves must exist — one
// that demands "not due", one that demands "due" — because either on
// its own is passable by a tick that does nothing at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = path.join(REPO, '.github', 'workflows', 'ci.yml');

/**
 * The file's steps as `{name, body}`.
 *
 * No YAML parser — the repo does not carry one as a dependency. A step
 * starts at `- name:`; its body is the following, more deeply indented
 * lines.
 */
function steps() {
  const lines = fs.readFileSync(CI, 'utf8').split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
    const head = l.match(/^(\s*)-\s*name:\s*(.+?)\s*$/);
    if (head) {
      if (cur) out.push(cur);
      cur = { name: head[2], indent: head[1].length, body: [] };
      continue;
    }
    if (!cur) continue;
    if (l.trim() !== '' && (l.length - l.trimStart().length) <= cur.indent) {
      out.push(cur); cur = null; continue;
    }
    cur.body.push(l);
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ name: s.name, body: s.body.join('\n') }));
}

/**
 * Does this step body actually START a digest tick?
 *
 * **It used to answer "does it MENTION one" (found 2026-09-18).** The
 * test read `/bin\/mem-digest(\.ps1)?\b/` against the whole body,
 * comments included — so an unrelated step whose comment named the file
 * as an example was pulled in and failed all three rules. The step did
 * nothing wrong; the reader did. A guard that matches a mention instead
 * of a call measures the wrong thing, and the damage runs the other way
 * too: it would just as happily count a step that only talks about the
 * digest as one of the two halves it demands.
 *
 * So: comment lines are stripped first, and what remains must contain
 * the SAME invocation tokens the rules below split on. One spelling in
 * one place — the reader and the rules cannot drift apart.
 */
const RUFT_DIGEST = /bash bin\/mem-digest|-File bin\/mem-digest\.ps1/;
export function startsDigest(body) {
  const ohneKommentare = String(body ?? '')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  return RUFT_DIGEST.test(ohneKommentare);
}

/** Steps that actually start a digest tick. */
const digestSteps = () => steps().filter((s) => startsDigest(s.body));

test('POSITIVE: the reader finds named steps at all', () => {
  // Without this, every rule below would hold against an empty list.
  const all = steps();
  assert.ok(all.length >= 10, `only ${all.length} steps read — the reader no longer fits the file`);
  assert.ok(digestSteps().length >= 2,
    `only ${digestSteps().length} digest step(s) — both halves must exist`);
});

test('the reader separates a CALL from a MENTION', () => {
  // Both directions, or the rule above is passable by a reader that
  // always says yes (or always no).
  assert.equal(startsDigest('          run: bash bin/mem-digest'), true,
    'a real invocation is no longer recognised — every rule below goes mute');
  assert.equal(startsDigest('          run: pwsh -File bin/mem-digest.ps1'), true,
    'the PowerShell invocation is no longer recognised');
  assert.equal(startsDigest('          # a glob would skip bin/mem-digest entirely'), false,
    'a comment naming the path counts as a digest step');
  assert.equal(startsDigest('          # run: bash bin/mem-digest'), false,
    'a commented-out invocation counts as a digest step');
});

test('every digest step asks whether anything is due, before it starts one', () => {
  for (const s of digestSteps()) {
    const before = s.body.split(/bash bin\/mem-digest|-File bin\/mem-digest\.ps1/)[0];
    assert.match(before, /digest due/,
      `the step "${s.name}" starts a digest tick without asking `
      + '`mem digest due` first — its precondition is assumed, not measured');
    assert.match(before, /-ne\s+\d/,
      `the step "${s.name}" asks about dueness but never checks the answer `
      + '— a measurement that separates nothing');
  }
});

test('the two halves demand OPPOSITE preconditions', () => {
  // The point. If both halves set up the same state, one of them is mute
  // and the pair proves half of what it claims.
  const wanted = digestSteps().map((s) => {
    const m = s.body.match(/-ne\s+(\d)/);
    return m ? Number(m[1]) : null;
  });
  assert.ok(!wanted.includes(null),
    'a digest step has no `-ne N` check — then which state it establishes is unreadable');
  const found = new Set(wanted);
  assert.ok(found.has(0) && found.has(1),
    `the digest steps only demand ${[...found].join(', ')} — `
    + 'one of the two halves (due / not due) measures nothing of its own');
});

test('every digest step counts model calls instead of trusting the exit code', () => {
  // The original defect: `exit 0` means both "nothing to do" and "all
  // done". Only a planted model that leaves a mark tells them apart.
  for (const s of digestSteps()) {
    assert.match(s.body, /MEM_DIGEST_CMD/,
      `the step "${s.name}" starts a tick without planting a fake model — `
      + 'then it cannot tell "started nothing" from "started something"');
    assert.match(s.body, /tally|TALLY/,
      `the step "${s.name}" plants a model but never counts its calls`);
  }
});

test('dueness is established by a threshold, not borrowed from the checkout', () => {
  // The sibling memory's flicker: the same unchanged step was red at
  // 441 KB of raw material and green at 780 KB, 45 minutes apart.
  const due = digestSteps().find((s) => /-ne\s+1/.test(s.body));
  assert.ok(due, 'no step demands that something IS due');
  assert.match(due.body, /MEM_DIGEST_VOLUME_NOW_KB|--volume-now/,
    `the step "${due.name}" relies on the default volume threshold — `
    + 'its colour then depends on how much raw material the checkout happens to carry');
});

test('both the POSIX tick and the PowerShell tick are covered', () => {
  // bin/mem-digest had no CI at all until 2026-09-17 — only the .ps1
  // was exercised, and only in the vacuous way above. The script most
  // people actually run was the untested one.
  const bodies = digestSteps().map((s) => s.body).join('\n');
  assert.match(bodies, /bash bin\/mem-digest\b/, 'the POSIX tick is never started in CI');
  assert.match(bodies, /bin\/mem-digest\.ps1/, 'the PowerShell tick is never started in CI');
});

// --- Does CI actually run on the branch this commit lands on? ---------
//
// Measured 2026-09-19: `on: push: branches: [main]` meant zero workflow
// runs across 21 commits on claude/geteilte-zusicherungen-in-ci, a
// feature branch with no open pull request. The comment above the `on:`
// block claimed "runs on every push and pull request" the entire time —
// true for main, false for everywhere else CI's own contributor
// actually works. A guard here is cheap and the failure mode is
// specifically silent: a workflow that never runs produces no red
// build to notice, only an absence.
function pushBranchesFilter() {
  const text = fs.readFileSync(CI, 'utf8');
  const m = text.match(/\bpush:\s*\n\s*branches:\s*\[([^\]]*)\]/);
  if (!m) return null; // no filter under push: -> every branch triggers it
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('the push trigger is not narrowed to main alone', () => {
  const branches = pushBranchesFilter();
  // No filter at all also runs on every branch, and passes this rule —
  // it is exactly as capable of feature-branch CI as `['**']` is.
  if (branches === null) return;
  assert.ok(branches.includes('**'),
    `on.push.branches is ${JSON.stringify(branches)} — a feature branch with `
    + 'no open pull request gets no CI at all, the exact defect measured '
    + '2026-09-19 on this branch');
});
