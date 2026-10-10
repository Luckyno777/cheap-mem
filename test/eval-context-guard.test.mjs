// A measurement run inherits the start context of the machine measuring it.
//
// **The finding (2026-09-16).** The paired benefit run came back with a
// clean result — and with three tasks whose "invented numbers" were not
// invented. One answer read:
//
//   "Die FAKTEN-KRITISCH-Notiz erwähnt die Container `claude`,
//    `diggi-tunnel`, `omniroute` […] die vollständige Datei unter
//    /root/.claude/projects/…"
//
// None of that is in the test corpus. It is the operator's own memory,
// pulled in because `eval/run.mjs` calls the `claude` CLI through
// `execFileSync`, and that CLI runs the user-level SessionStart hooks —
// in a subprocess, for a benchmark, exactly as it would for a session.
//
// Nine of 192 answers (5 %) were affected. The headline result survived
// (p went from 0.0001 to 0.0005 when the three tasks were dropped), but
// the hallucination count for those tasks was worthless: the model had
// read those numbers, not made them up.
//
// **Why this is a guard and not a comment.** It is the third instance of
// the class. On 2026-09-06 the null arm answered out of logged findings
// ABOUT the measurement series. A run that calls an agent tool inherits
// that tool's start context, and the only reliable fix is to say so in
// the invocation. A note in a header gets read once; a test gets read
// every time someone edits the file.
//
// The flag was chosen by measurement, not by reading the help text:
//
//   `--bare`        disables hooks AND breaks auth (wants an API key)
//   `--settings`    with empty hooks does NOT help — the user-level file
//                   is merged in anyway
//   `--restricted`  the positive control answered "KEIN-KONTEXT"
// Since the hardening of the eval harness the call lives in ONE module,
// eval/model-call.mjs (test/eval-model-call.test.mjs tests its behaviour); this
// guard keeps watching that nobody calls the CLI a second way next to it.
//
// Covers assurances from shared/invariants.jsonl. The id is the
// shared language between the houses; the prose there names the
// incident that forced it.
// invariant: messung-ohne-fremdkontext
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SHELL_OUT = /\b(?:execFileSync|spawnSync|execSync|execFile|spawn)\(\s*['"`]claude['"`]/;

/** The shared call module and the harness scripts that must go through it. */
const SHARED = path.join(REPO, 'eval', 'model-call.mjs');
const HARNESS = ['eval/run.mjs', 'eval/pair.mjs'];

/** Every file in eval/ and bench/ that shells out to the agent CLI by itself (not through the shared module). */
function directCallers() {
  const out = [];
  for (const dir of ['eval', 'bench']) {
    const d = path.join(REPO, dir);
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.mjs'))) {
      const rel = `${dir}/${n}`;
      if (SHELL_OUT.test(fs.readFileSync(path.join(REPO, rel), 'utf8'))) out.push(rel);
    }
  }
  return out;
}

/** The text of the argument list `buildArgs` returns. */
function argList() {
  const text = fs.readFileSync(SHARED, 'utf8');
  const i = text.indexOf('export function buildArgs');
  const j = text.indexOf('return [', i);
  const k = text.indexOf('\n  ];', j);
  assert.ok(i > 0 && j > i && k > j, 'cannot find the argument list of buildArgs');
  return { text, start: i, list: text.slice(j, k) };
}

test('POSITIVE: the shared module exists and the harness scripts go through it', () => {
  // Without this, a renamed module would make the guards below pass by
  // finding nothing — the failure mode this whole file exists to catch.
  assert.ok(fs.existsSync(SHARED), 'eval/model-call.mjs is gone — the guards below check nothing');
  for (const rel of HARNESS) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.match(text, /from '\.\/model-call\.mjs'/, `${rel} does not import the shared call`);
    assert.match(text, /\bcallModel\(/, `${rel} does not call the model through callModel`);
  }
});

test('POSITIVE: the probe that finds a direct CLI call does find one', () => {
  assert.ok(SHELL_OUT.test("execFileSync('claude', ['-p'])"));
  assert.ok(SHELL_OUT.test('spawnSync("claude", args)'));
  assert.ok(!SHELL_OUT.test('spawnSync(command, args)'));
});

test('no harness script calls the CLI by itself (one call, one set of flags)', () => {
  assert.deepEqual(directCallers(), [],
    'these scripts call `claude` directly: they would miss --restricted, --tools "" and the thinking level');
});

test('--restricted sits in the argument list, not in a comment', () => {
  // A guard that a comment can satisfy is not a guard. The flag has to
  // be inside the argument array to do anything.
  assert.match(argList().list, /'--restricted'/);
});

test('the reason is written down where the flag is', () => {
  // A flag nobody understands gets removed by the next person who finds
  // it in the way. The measurement that justified it has to travel with
  // it — this project has lost guards to "looked unnecessary" before.
  const { text, start } = argList();
  const before = text.slice(Math.max(0, start - 2600), start);
  assert.match(before, /SessionStart|Hook/i, '--restricted stands there without saying what it keeps out');
});
