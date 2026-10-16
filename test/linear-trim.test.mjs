// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Text that is one long run of the same character does not stall the sites that read foreign text.
//
// **The finding, 2026-10-16** (found by the redaction-keys round). A pattern that ends in a run and `$` (`/\s+$/`, `/-+$/`,
// `/ +$/`, `/\n*$/`) starts a match at every character of the run, walks to its end, fails at the `$`, and starts one
// character later: quadratic. 100,000 blanks, hyphens or line breaks plus a letter took 3.7 to 4.3 s per pattern; 1 MB takes
// minutes. The same came out of the inventory of `src/`, `bin/` and `install/` for patterns with a run in front of what may
// not come (`[\w./@-]*\/`, a lazy run in front of a name, `\d*>`), for a quoted stretch that never closes, and for a rule
// read with `^\s*` in a multiline pattern. Each repaired site is one probe in test/helpers/linear-probes.mjs: the pathological
// input of 1 MB, built outside the clock, and the site, run inside it.
//
// **A child per probe.** A site that is still quadratic would hold this process for minutes, and a synchronous pattern cannot
// be interrupted from inside; the child is killed after `GIVE_UP_MS` and the probe reports "did not finish". The ceiling is
// generous (the machine may be loaded; the child takes the best of three runs, at two sizes); the old state needs minutes for the same
// input, so these probes turn red there instead of passing. That is checked, not assumed: the probe list was run against
// the state before the repair and every repaired site was killed or over the ceiling there.
//
// The answers (that the linear spelling says what the pattern said) are in test/linear-trim-golden.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROBES, MB } from './helpers/linear-probes.mjs';
import { tempDir } from './temp-dir.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'linear-probes.mjs');
// A coarse ceiling, generous: a slow runner may take ten times what a laptop takes; the old state takes minutes. The finer test is
// the ratio: the probe measures 1 MB and a quarter of it, linear time makes the big run about 4 times the small one, quadratic
// about 16. Below `RATIO_FROM_MS` the clock says too little to read a ratio from (and a quadratic site would be far above it);
// the small run counts at least `SMALL_FLOOR_MS`, so a fast small run does not turn a normal jitter into a ratio.
const CEILING_MS = 2000;
const RATIO_FROM_MS = 100;
const SMALL_FLOOR_MS = 25;
const RATIO_MAX = 9;
const GIVE_UP_MS = 20000;

// The child's scratch directories live under one directory of ours (`os.tmpdir()` reads these variables on every platform),
// so a child that is killed does not leave its megabytes behind.
function runProbe(name, scratch) {
  return new Promise((resolve) => {
    const env = { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch };
    const child = spawn(process.execPath, [CHILD, name], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ gaveUp: true }); }, GIVE_UP_MS);
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve({ ...JSON.parse(out), gaveUp: false }); } catch { resolve({ gaveUp: false, ok: false, ms: NaN, error: err.slice(0, 300) || out.slice(0, 300) }); }
    });
  });
}

test('the probes feed the sites 1 MB', () => {
  assert.equal(MB, 1e6);
  assert.ok(Object.keys(PROBES).length >= 17, 'a probe was dropped');
});

for (const name of Object.keys(PROBES)) {
  test(`linear: ${name}`, { timeout: GIVE_UP_MS + 10000 }, async (t) => {
    const r = await runProbe(name, tempDir('cm-linear-run-', t));
    assert.equal(r.gaveUp, false, `did not finish in ${GIVE_UP_MS} ms - the site is quadratic`);
    assert.equal(r.error, null, `the site threw: ${r.error}`);
    assert.equal(r.ok, true, 'the site gave a different answer than on a normal input');
    assert.ok(r.ms < CEILING_MS, `${Math.round(r.ms)} ms (ceiling ${CEILING_MS}) - the site backtracks`);
    if (r.ms >= RATIO_FROM_MS) {
      const ratio = r.ms / Math.max(r.smallMs, SMALL_FLOOR_MS);
      assert.ok(ratio < RATIO_MAX, `1 MB took ${Math.round(r.ms)} ms, a quarter of it ${Math.round(r.smallMs)} ms: ${ratio.toFixed(1)} times (linear is about 4, quadratic about 16)`);
    }
  });
}
