// test/ci-shell-probes.test.mjs — does every shell probe actually run?
//
// Ported from lucky-mem/test/ci-alle-proben.test.mjs (BAUPLAN-mem-admin_02.md
// Block F, F4): a shell probe under the test directory only runs when a
// workflow names its path in a step — unlike a `.test.mjs` file, which
// `npm test` picks up as a whole. A probe nobody's workflow ever calls
// is not passing, no matter how green it would be if it ran.
//
// No YAML parser (this repo carries none as a dependency): whether a
// path occurs ANYWHERE in a workflow file's text is enough — whether the
// step around it is built sensibly is a different question.
//
// **The two glob-looking constants below are built from parts on
// purpose.** Written as a literal, `'test/*.sh'` opens
// `test/english-only.test.mjs`'s block-comment scanner mid-string (the
// `/` right before the `*`) and never closes it — this file's own first
// draft tripped exactly that trap. Same reasoning as the assembled
// secret in `test/integrity.test.mjs`: two extra characters buys a file
// that does not sabotage the very probe meant to guard the prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const SHELL_GLOB = `test${'/'}${'*'}.sh`;
const WORKFLOW_GLOB = `.github${'/'}workflows${'/'}${'*'}.yml`;

/**
 * Exemptions are named, never silent (same shape as the exemption list
 * this repo already keeps for other guards, e.g. `english-only.test.mjs`):
 * an entry here has to carry a reason, printed on every run, not only on
 * a failure.
 */
const EXEMPT = {
  // (kept empty deliberately — every shell probe this repo has today
  // runs in ci.yml. An entry only belongs here with a real reason, same
  // rule the SABOTAGE test below exists to enforce is still checked.)
};

function allShellProbes() {
  const out = execFileSync('git', ['ls-files', SHELL_GLOB], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((z) => z.trim()).filter(Boolean);
}

function workflowFiles() {
  let names = [];
  try { names = fs.readdirSync(WORKFLOW_DIR); } catch { return []; }
  return names.filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
    .map((n) => path.join(WORKFLOW_DIR, n));
}

function workflowsText() {
  return workflowFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n---\n');
}

/** Which of `files` run in NO workflow step and have no exemption. */
function missingProbes(files, text) {
  return files.filter((f) => !Object.hasOwn(EXEMPT, f) && !text.includes(f));
}

test('POSITIVE CONTROL: git actually knows shell probes, and the exemptions still exist', () => {
  const files = allShellProbes();
  assert.ok(files.length >= 1, `only ${files.length} shell probes (${SHELL_GLOB}) found — the reader is broken`);
  for (const exempt of Object.keys(EXEMPT)) {
    assert.ok(files.includes(exempt),
      `exemption '${exempt}' is in EXEMPT, but git ls-files no longer knows this file — `
      + 'dead entry, remove it or fix the path');
  }
});

test(`every ${SHELL_GLOB} runs in some ${WORKFLOW_GLOB}, or is exempt with a reason`, () => {
  const files = allShellProbes();
  const text = workflowsText();
  const missing = missingProbes(files, text);

  const exempt = files.filter((f) => Object.hasOwn(EXEMPT, f));
  if (exempt.length) {
    console.log(`ci-shell-probes: documented exemptions — ${
      exempt.map((f) => `${f} (${EXEMPT[f]})`).join('; ')}`);
  }

  assert.deepEqual(missing, [],
    `${missing.length} shell probe(s) run in NO workflow step: ${missing.join(', ')}. `
    + 'Either give it its own step (`run: bash <path>`, the right job) or — only with '
    + 'a real reason — add it to EXEMPT above.');
});

test('SABOTAGE: a made-up missing file IS caught, not silently let through', () => {
  const invented = 'test/this-probe-certainly-does-not-exist-f4.sh';
  const text = workflowsText();
  assert.ok(!text.includes(invented), 'precondition violated: the invented file is already in a workflow');
  assert.ok(!Object.hasOwn(EXEMPT, invented), 'precondition violated: the invented file is already exempt');

  const missing = missingProbes([...allShellProbes(), invented], text);
  assert.ok(missing.includes(invented), 'the guard did NOT report a genuinely missing file — it is blind');
});

test('the counter-check: a genuinely referenced file is not falsely reported', () => {
  const real = 'test/stop-persists.sh';
  const text = workflowsText();
  assert.ok(text.includes(real), `precondition violated: '${real}' is not (yet) in any workflow`);
  assert.ok(!missingProbes([real], text).includes(real),
    'the guard reported a file that genuinely runs in a workflow — it flags the innocent');
});

test(`POSITIVE: workflowsText actually walks real files (${WORKFLOW_GLOB})`, () => {
  const files = workflowFiles();
  assert.ok(files.length >= 1, `no ${WORKFLOW_GLOB} found — the reader is broken`);
  assert.ok(workflowsText().length > 100, 'the combined workflow text is suspiciously short');
});
