// test/session-start-habits.test.mjs — N4b: wire `mem user --session-start`
// (parity with lucky-mem N2, commits 9417fd9a/d992f41b in /home/user/lm-post)
// into install/hooks/session-start.sh, the SessionStart hook that fires at
// the top of EVERY session.
//
// **What N4 already gave us.** `src/userhabits.mjs`'s `sessionStartLines()`
// (unit-tested in test/userhabits.test.mjs) already enforces every
// guarantee this line needs: at most `SESSION_START_MAX_LINES` (5) lines,
// header included; only observations at or above `MIN_EVIDENCE_DISPLAY`
// (8, deliberately higher than the 5-hit measurement threshold) AND
// actionable; empty on "no capture readable" (unknown) and on "some hits,
// below the threshold" (too_little_evidence) alike — never a bare `0` or
// a printed "no habits" claim. `mem user --session-start` (checked in
// src/cli/commands/capture.mjs) already surfaces exactly that.
//
// **What was still missing before this file.** Nothing called it from the
// hook. `bin/mem`'s own help text and the `user` command's help block
// both said, in so many words, "this needs exactly one added line" in
// install/hooks/session-start.sh — and that line did not exist. A feature
// that is fully built and never invoked is invisible to every session; the
// probes below run the REAL hook script (not a grep of its source, and not
// only the module underneath) so that "wired in" is proven by running it,
// the same discipline test/doctor-alarm.test.mjs uses for the alarm line.
//
// **House-rules probe.** Confirmed red by hand on a detached
// `git worktree add --detach` of 7e9bf40 (this branch's base commit,
// before this file existed): `grep -n 'user --session-start'
// install/hooks/session-start.sh` found nothing there, and running that
// old hook against a root seeded with 10 real hits of the
// `delegated_decision` pattern (well above MIN_EVIDENCE_DISPLAY=8) printed
// no habit line at all — the worktree was removed after the check. Green
// on this branch's install/hooks/session-start.sh, proven below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as raw from '../src/raw.mjs';
import * as uh from '../src/userhabits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const HOOK = path.join(REPO, 'install', 'hooks', 'session-start.sh');

// --- Static guard (cheap, but not the proof) --------------------------
//
// A grep alone would stay green even if the call never actually ran or
// its output never reached the session — that is exactly the trap
// test/doctor-alarm.test.mjs's header warns about. So this is one line of
// defence, not the whole case; every other test below runs the hook.
test('static guard: the hook source calls `mem user --session-start`', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.match(src, /"\$CHEAP_MEM_ROOT\/bin\/mem"\s+user\s+--session-start/,
    'install/hooks/session-start.sh no longer calls `mem user --session-start`');
});

// --- Fixture: a real memory root the real bin/mem can act on ----------
//
// The hook runs `node "$CHEAP_MEM_ROOT/bin/mem" ...` — in a real
// deployment CHEAP_MEM_ROOT IS a cheap-mem checkout (bin/, src/, the
// memory data, all in one place; see CLAUDE.md). A throwaway root here
// gets `bin` and `src` symlinked back to THIS checkout so the hook's own
// path assumption holds without copying the tool.
function realRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ssh-root-'));
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.symlinkSync(MEM, path.join(root, 'bin', 'mem'));
  fs.symlinkSync(path.join(REPO, 'src'), path.join(root, 'src'));
  return root;
}
const wipe = (t) => fs.rmSync(t, { recursive: true, force: true });

/** A real, string-content `user` transcript line, minutes apart. */
function userLine(text, i, startISO) {
  const ts = new Date(new Date(startISO).getTime() + i * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { type: 'user', timestamp: ts, message: { role: 'user', content: text } };
}
function assistantLine(i, startISO) {
  const ts = new Date(new Date(startISO).getTime() + i * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: 'ok' } };
}

/** Seeds `root`'s raw archive with `n` real user turns matching the
 *  shipped `delegated_decision` pattern, one capture, `n` real messages. */
function seedHabit(root, n, startISO = '2026-09-20T08:00:00Z') {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(userLine('ok, your call — just go with it, whatever you think is best', i * 2, startISO));
    lines.push(assistantLine(i * 2 + 1, startISO));
  }
  const t = path.join(root, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(t, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const r = raw.capture(root, t, { minBytes: 1 });
  assert.equal(r.status, 'captured', `fixture capture did not go through: ${JSON.stringify(r)}`);
  fs.rmSync(t);
}

function runHook(root, extraEnv = {}) {
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...extraEnv },
  });
}

// --- POSITIVE CONTROL: the fixture and the reader both actually work --

test('POSITIVE CONTROL: a seeded root measures the habit at all (mem user, not the hook)', () => {
  const root = realRoot();
  try {
    seedHabit(root, 10);
    const r = uh.analyze(root, { minEvidence: uh.MIN_EVIDENCE_DISPLAY });
    const delegated = r.observations.find((o) => o.id === 'delegated_decision');
    assert.ok(delegated, 'the shipped pattern is not even loaded');
    assert.equal(delegated.state, uh.STATE.MEASURED, `fixture did not clear the display threshold: ${JSON.stringify(delegated)}`);
    assert.ok(delegated.count >= uh.MIN_EVIDENCE_DISPLAY, `only ${delegated.count} hits — the fixture itself is too weak to prove anything`);
  } finally { wipe(root); }
});

// --- THE GUARANTEE, run through the real hook --------------------------

test('THE CASE: a measured, actionable habit shows up in the real SessionStart hook, capped at 5 lines', () => {
  const root = realRoot();
  try {
    seedHabit(root, 10); // well above MIN_EVIDENCE_DISPLAY (8)
    const r = runHook(root);
    assert.equal(r.status, 0, `hook exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
    const idx = r.stdout.indexOf('User habits (measured over');
    assert.ok(idx >= 0, `no habits section in the hook's output:\n${r.stdout}`);
    // The section runs from its header to the next blank line — exactly
    // what sessionStartLines() promised to inject, nothing added by the
    // hook around it.
    const section = r.stdout.slice(idx).split('\n\n')[0].split('\n').filter((l) => l.length);
    assert.ok(section.length <= uh.SESSION_START_MAX_LINES,
      `ABORT: ${section.length} lines shown, more than the ${uh.SESSION_START_MAX_LINES}-line cap:\n${section.join('\n')}`);
    assert.match(section[0], /^User habits \(measured over \d+ messages? in \d+ capture\(s\)/);
    // Every detail line must name a habit that really is the one seeded —
    // "ABORT: lines without minimum evidence" means a line whose own
    // (count/total) reads below MIN_EVIDENCE_DISPLAY got through.
    for (const line of section.slice(1)) {
      const m = /\((\d+)\/(\d+)\)/.exec(line);
      assert.ok(m, `detail line has no (count/total): ${line}`);
      assert.ok(Number(m[1]) >= uh.MIN_EVIDENCE_DISPLAY,
        `ABORT: "${line}" shows evidence below MIN_EVIDENCE_DISPLAY (${uh.MIN_EVIDENCE_DISPLAY})`);
    }
    assert.ok(section.some((l) => l.includes('Delegates the decision instead of choosing')),
      `the seeded habit itself never appears:\n${section.join('\n')}`);
  } finally { wipe(root); }
});

test('too little evidence: below MIN_EVIDENCE_DISPLAY stays silent, not an error, not "no habits"', () => {
  const root = realRoot();
  try {
    seedHabit(root, 3); // measured (>=5) but below the DISPLAY threshold (8)
    const r = runHook(root);
    assert.equal(r.status, 0, `hook exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /User habits/, 'a sub-threshold habit still got shown');
    assert.doesNotMatch(r.stdout, /no habit/i,
      'not-enough-evidence must read as SILENCE, never as the claim "no habits"');
  } finally { wipe(root); }
});

test('unknown (no capture readable at all) stays silent too, and is never printed as "no habits"', () => {
  const root = realRoot(); // mem init, but nothing captured — unknown, not zero
  try {
    const r = runHook(root);
    assert.equal(r.status, 0, `hook exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /User habits/, 'an empty archive still produced a habits section');
    assert.doesNotMatch(r.stdout, /no habit/i,
      '"unknown" (nothing readable) must not be shown as "no habits" — that is a different claim');
  } finally { wipe(root); }
});

test('a `mem user --session-start` failure does not break the rest of the hook', () => {
  // A broken custom pattern file makes `sessionStartLines()` throw
  // (userhabits.mjs never silently falls back on a broken CUSTOM
  // override — see its module doc). The hook must not let that crash
  // the rest of the session banner: `2>/dev/null || true` around the
  // capture is the guard, and this proves it end-to-end rather than by
  // reading the shell.
  const root = realRoot();
  const badPatterns = path.join(root, 'bad-patterns.json');
  fs.writeFileSync(badPatterns, 'not json');
  try {
    const r = runHook(root, { CHEAP_MEM_USER_PATTERNS: badPatterns });
    assert.equal(r.status, 0, `hook exited ${r.status} instead of tolerating the failure:\n${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /User habits/);
    assert.match(r.stdout, /how to use this memory this session/,
      'the rest of the hook (HINTS block) did not run after the habits call failed');
  } finally { wipe(root); }
});
