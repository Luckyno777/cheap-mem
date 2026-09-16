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
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file that shells out to the agent CLI. */
function aufrufer() {
  const raus = [];
  for (const dir of ['eval', 'bench']) {
    const d = path.join(REPO, dir);
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.mjs'))) {
      const rel = path.join(dir, n);
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      if (/execFileSync\(\s*'claude'/.test(text)) raus.push({ rel, text });
    }
  }
  return raus;
}

test('POSITIVE: the probe finds the files that call the CLI', () => {
  // Without this, a renamed harness would make the guard below pass by
  // finding nothing — the failure mode this whole file exists to catch.
  const a = aufrufer();
  assert.ok(a.length >= 2,
    `only ${a.length} CLI callers found — the probe looks in the wrong place, `
    + 'or the harness moved. Either way this guard is checking nothing.');
});

test('every CLI call in a measurement passes --restricted', () => {
  // The flag keeps the operator's SessionStart hooks out of the answer.
  // Without it the run measures the machine as much as the memory.
  const ohne = aufrufer().filter((a) => !/'--restricted'/.test(a.text));
  assert.deepEqual(ohne.map((a) => a.rel), [],
    'these measurement harnesses would inherit the operator\'s session context');
});

test('--restricted sits in the argument list, not in a comment', () => {
  // A guard that a comment can satisfy is not a guard. The flag has to
  // be inside the execFileSync argument array to do anything.
  for (const { rel, text } of aufrufer()) {
    const i = text.indexOf("execFileSync('claude'");
    const bis = text.indexOf('], {', i);
    assert.ok(bis > i, `${rel}: cannot find the end of the argument list`);
    const args = text.slice(i, bis);
    assert.match(args, /'--restricted'/,
      `${rel}: --restricted is mentioned somewhere, but not in the arguments`);
  }
});

test('the reason is written down where the flag is', () => {
  // A flag nobody understands gets removed by the next person who finds
  // it in the way. The measurement that justified it has to travel with
  // it — this project has lost guards to "looked unnecessary" before.
  for (const { rel, text } of aufrufer()) {
    const i = text.indexOf("'--restricted'");
    const davor = text.slice(Math.max(0, i - 1400), i);
    assert.match(davor, /SessionStart|Hook/i,
      `${rel}: --restricted stands there without saying what it keeps out`);
  }
});
