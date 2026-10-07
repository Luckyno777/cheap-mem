// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * ci-history-check.mjs - are the git objects the probes rely on actually here?
 *
 * Usage: node bench/ci-history-check.mjs [<root>]
 * Exit 0: history complete, every baseline found in test/ resolves.
 * Exit 1: shallow clone, or a baseline is missing (named, with location).
 * Exit 2: the check itself is blind (too few baselines found).
 *
 * Why. `actions/checkout` without `fetch-depth` fetches one commit. Red
 * proofs that run `git show <old-commit>:<file>` against a FIXED old state
 * then fail on missing objects (red without meaning), or - where the caller
 * skips when the old state is absent (e.g. test/dash-run-cm-browser.test.mjs,
 * NO_OLD) - silently drop out: a skip is "not measured", and it hides. An
 * honest abort is better than either.
 *
 * Searched in test/ at two places that unambiguously mean a commit:
 *   1. an UPPER-CASE constant = 'hex' (7-40 chars, at least 5 distinct)
 *   2. hex with a revision suffix: `abc1234^`, `abc1234~2`, `abc1234:path/file`
 * A find count below MINIMUM is a finding about the check itself (exit 2):
 * a search that finds nothing looks the same as one that needs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** Hits that are not commits of this repo (probe data), each with its reason. */
const DECOYS = Object.freeze({
  '5e4a1df944d0eb32e4b57ee5cb0d6d2e5e825e63': 'test/src-no-bench-import.test.mjs:19: a pre-rewrite start commit named in a comment; the probe uses a literal snippet, no git object is read',
});
/** Fewer baselines than this and the search is blind (51 today). */
const MINIMUM = 30;

const CONSTANT = /(?:const|let|var|export const)\s+([A-Z][A-Z0-9_]*)\s*=\s*['"`]([0-9a-f]{7,40})['"`]/g;
const REVISION = /(?<![0-9A-Za-z_/.-])([0-9a-f]{7,40})(?:\^|~\d*|:[A-Za-z_.][\w./-]*)(?![0-9A-Za-z])/g;

const usable = (t) => new Set(t).size >= 5 && /[a-f]/.test(t) && /[0-9]/.test(t);

/** @returns {Map<string,string[]>} hash -> locations */
function findBaselines(root) {
  const files = execFileSync('git', ['-C', root, 'ls-files', 'test'], { encoding: 'utf8' })
    .split('\n').filter((f) => /\.(mjs|js|sh)$/.test(f));
  const found = new Map();
  const note = (t, where) => { if (usable(t)) (found.get(t) ?? found.set(t, []).get(t)).push(where); };
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(CONSTANT)) note(m[2], `${f} (${m[1]})`);
    text.split('\n').forEach((line, i) => { for (const m of line.matchAll(REVISION)) note(m[1], `${f}:${i + 1}`); });
  }
  return found;
}

function check(root, { minimum = MINIMUM } = {}) {
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const shallow = git('rev-parse', '--is-shallow-repository').stdout.trim();
  if (shallow !== 'false') {
    return { exit: 1, messages: [`clone is shallow or not checkable (is-shallow-repository: '${shallow}') - checkout needs fetch-depth: 0`] };
  }
  const found = findBaselines(root);
  if (found.size < minimum) {
    return { exit: 2, messages: [`only ${found.size} baselines found (expected at least ${minimum}) - the search is blind`] };
  }
  const missing = [];
  for (const [t, where] of found) {
    if (DECOYS[t]) continue;
    if (git('cat-file', '-e', t).status !== 0) missing.push(`${t}  ${where.slice(0, 3).join(', ')}`);
  }
  if (missing.length) return { exit: 1, messages: ['baselines not in the clone:', ...missing.map((f) => `  ${f}`)] };
  return { exit: 0, messages: [`history complete, ${found.size} probe baselines resolve`] };
}

// CI_HISTORY_MINIMUM only for the probe of this check (test/ci-history.test.mjs).
const min = Number(process.env.CI_HISTORY_MINIMUM || MINIMUM);
const r = check(path.resolve(process.argv[2] ?? process.cwd()), { minimum: min });
for (const m of r.messages) console.log(r.exit === 0 ? m : `::error::${m}`);
process.exit(r.exit);
