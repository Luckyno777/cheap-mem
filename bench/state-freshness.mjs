// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/state-freshness.mjs — the reach of M9 (src/statequestion.mjs)
// on a real memory, and a guard that the frozen eval ceiling did not
// move because of it.
//
// A measuring instrument, not a feature. It changes nothing and writes
// nothing.
//
// Two numbers, over the memory at `--root` (default: cwd):
//
//   1. How many `topic` groups even have the SHAPE this mechanism
//      touches — at least two live entries, at least two of them with
//      a readable `ts`. Everything else is a group the mechanism
//      leaves alone no matter what the question says, so a memory
//      with none of these shows 0 by construction, not by a bug.
//   2. Re-runs `eval/metrics.mjs` as a fixed, deterministic corpus (the
//      frozen TASKS have no state signal word in any prompt, so this
//      is expected to hold BYTE-FOR-BYTE) and fails loudly if the
//      "Gold in fed context" ceiling line differs from the recorded
//      baseline — the guard the task asked for ("the eval reference
//      must not sink"), automated instead of a one-off manual diff.
//
// Usage:
//   node bench/state-freshness.mjs [--root <path>]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

/** Recorded on 2026-09-27, the day this bench was written — see the test suite's own diff against the pre-change tree for how this was first confirmed. */
const BASELINE_CEILING = 'Gold in fed context                           |    30/63 |     29/63 | CEILING on the benefit';

function topicShapeReport(root) {
  const byTopic = new Map();
  for (const e of memory.topicEntries(root)) {
    if (!byTopic.has(e._topic)) byTopic.set(e._topic, []);
    byTopic.get(e._topic).push(e);
  }
  let eligible = 0;
  for (const entries of byTopic.values()) {
    if (entries.length < 2) continue;
    const withTs = entries.filter((e) => Number.isFinite(Date.parse(e.ts ?? ''))).length;
    if (withTs >= 2) eligible += 1;
  }
  return { topics: byTopic.size, eligible };
}

const ROOT = path.resolve(flag('root') ?? process.cwd());
const { topics, eligible } = topicShapeReport(ROOT);
console.log(`State-question freshness (M9) — reach on ${ROOT}`);
console.log(`  ${topics} topic(s) tracked, ${eligible} of them have the shape this mechanism can touch`);
console.log('  (>= 2 live entries, >= 2 with a readable ts) — the rest are untouched by construction.');
console.log();

let out;
try {
  out = execFileSync('node', [path.join(REPO, 'eval', 'metrics.mjs')], { encoding: 'utf8', cwd: REPO });
} catch (e) {
  console.log('Could not run eval/metrics.mjs — nothing to compare against.');
  console.log(String(e.message || e));
  process.exit(2);
}
const line = out.split('\n').find((l) => l.startsWith('Gold in fed context'));
console.log(`Frozen eval ceiling: ${line ?? '(line not found)'}`);
if (line !== BASELINE_CEILING) {
  console.log('\nREGRESSION: the frozen eval ceiling moved. None of the frozen tasks\'');
  console.log('prompts carry a state signal word, so this line was expected to stay');
  console.log('byte-identical. Investigate before shipping.');
  process.exit(1);
}
console.log('\nUnchanged — the eval reference did not sink.');
