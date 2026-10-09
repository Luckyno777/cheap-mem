// test/ci-annotations.test.mjs — the "npm test" step of ci.yml names every red
// probe in ONE summary annotation, before the per-probe ones.
//
// Why: GitHub shows at most 10 error annotations per step. With more than 10
// red probes the per-probe annotations hide the rest, and the job logs are not
// readable from outside. The summary line `::error::red probes (N): a | b | …`
// carries all of the names.
//
// The step's own `run:` script is cut out of the workflow text (no YAML parser
// in this repo) and run with bash as GitHub does (`-eo pipefail`), with `npm` replaced by a function that
// prints a canned TAP stream and fails. So the awk under test is the awk that
// CI runs, not a copy of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml');

/** The `run:` script of the step named "npm test (red probes ...". */
function stepScript() {
  const lines = fs.readFileSync(CI, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^\s*- name: npm test \(red probes/.test(l));
  assert.ok(at >= 0, 'step "npm test (red probes ...)" not found in ci.yml');
  const run = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  assert.ok(run > at, 'run: | not found in the step');
  const indent = lines[run + 1].match(/^ */)[0].length;
  const out = [];
  for (let i = run + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^ */)[0].length < indent) break;
    out.push(l.slice(indent));
  }
  return out.join('\n');
}

function bashAvailable() {
  const r = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Runs the step's script against a canned TAP stream; returns { rc, out }. */
function runStep(tap, { rc = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ci-annot-'));
  try {
    const script = `npm() { printf '%s\\n' "$FAKE_TAP"; return ${rc}; }\n` + stepScript();
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_TAP: tap, RUNNER_TEMP: dir.split(path.sep).join('/') },
    });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const bashOk = bashAvailable();
const T = bashOk ? test : (name, fn) => test(name, { skip: 'NOTICE: no bash on PATH, the CI step cannot be run here' }, fn);

function tapRed(i, name, extra = '') {
  return `not ok ${i} - ${name}\n  ---\n  duration_ms: 1\n  error: 'boom ${i}'\n${extra}  ...\n`;
}

T('summary annotation names every red probe, ahead of the per-probe ones', () => {
  const names = [];
  let tap = 'TAP version 13\n';
  for (let i = 1; i <= 14; i++) { names.push(`probe number ${i}`); tap += tapRed(i, `probe number ${i}`); }
  tap += 'ok 15 - a green one\n';
  const { rc, out } = runStep(tap);
  assert.equal(rc, 1, 'the exit code stays the one of npm test');
  const lines = out.split('\n');
  const sum = lines.findIndex((l) => l.startsWith('::error::red probes ('));
  assert.ok(sum >= 0, out);
  assert.equal(lines[sum], `::error::red probes (14): ${names.join(' | ')}`);
  const firstSingle = lines.findIndex((l) => l.startsWith('::error::red probe: '));
  assert.ok(firstSingle > sum, 'summary comes before the single annotations');
});

T('a parent suite that is red only because a child is red is not listed twice', () => {
  const tap = [
    '    not ok 1 - child red',
    '      ---',
    "      error: 'x'",
    '      ...',
    'not ok 1 - parent suite',
    '  ---',
    "  failureType: 'subtestsFailed'",
    "  error: '1 subtest failed'",
    '  ...',
    'not ok 2 - top level red',
    '  ---',
    "  error: 'y'",
    '  ...',
    '',
  ].join('\n');
  const { out } = runStep(tap);
  const sum = out.split('\n').find((l) => l.startsWith('::error::red probes ('));
  assert.equal(sum, '::error::red probes (2): child red | top level red');
});

T('names are cut to 100 characters, % is encoded; 60 names of 100 characters fit whole', () => {
  const long = 'x'.repeat(200);
  let tap = tapRed(1, `50% ${long}`);
  const names = [];
  for (let i = 2; i <= 60; i++) { const n = `n${i} ${'y'.repeat(100)}`; names.push(n.slice(0, 97) + '...'); tap += tapRed(i, n); }
  const { out } = runStep(tap);
  const sum = out.split('\n').find((l) => l.startsWith('::error::red probes ('));
  assert.ok(sum.startsWith(`::error::red probes (60): 50%25 ${'x'.repeat(93)}... | n2 `), sum.slice(0, 140));
  assert.ok(!sum.includes(long), 'no 200-character name');
  assert.ok(!/\(\+\d+ more\)/.test(sum), 'nothing cut: all 60 are named');
  for (const n of names) assert.ok(sum.includes(n), n);
});

T('a list far beyond that is cut visibly: "(+N more)", bounded length', () => {
  let tap = '';
  for (let i = 1; i <= 200; i++) tap += tapRed(i, `n${i} ${'y'.repeat(100)}`);
  const { out } = runStep(tap);
  const sum = out.split('\n').find((l) => l.startsWith('::error::red probes ('));
  assert.ok(sum.startsWith('::error::red probes (200): '));
  assert.match(sum, / \| \.\.\. \(\+\d+ more\)$/);
  assert.ok(sum.length < 8400, `bounded, got ${sum.length}`);
  const more = Number(sum.match(/ \(\+(\d+) more\)$/)[1]);
  assert.ok(more > 0 && more < 200);
});

T('no summary when npm test is green, and none when no probe is red', () => {
  const green = runStep('ok 1 - fine\n', { rc: 0 });
  assert.equal(green.rc, 0);
  assert.ok(!green.out.includes('::error::'));
  const died = runStep('the run died\n');
  assert.equal(died.rc, 1);
  assert.ok(!died.out.includes('::error::red probes ('), died.out);
});
