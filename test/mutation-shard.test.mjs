// test/mutation-shard.test.mjs - the mutation sweep in slices, and a mutant whose suite only skipped (CI run 1141).
//
// **The finding.** The guarantees job of CI run 1141 was cancelled at its 25-minute limit inside `bench/mutation.mjs`:
// 198 mutants had taken 16 minutes, and the next one ("BYLINE-UI the dashboard shows a missing rank as a plain tier") was
// checked only by a browser probe. The job has no Chromium, the probe skipped, its suite passed, and the harness re-ran the
// WHOLE suite to see whether anything else caught the mutant - where the browser probe skipped again. The same had happened
// in run 1103. Two changes, two probes here:
//   1. `--shard=i/n` sweeps every n-th mutant; CI runs the sweep as n parallel jobs. The slices together are the catalogue,
//      each mutant exactly once (group A).
//   2. A mutant whose own suites passed with tests SKIPPED is "not judged here" at once (exit 1, the skip reason named), and
//      no full-suite run is spent on it (group B).
//
// **How this probe stays safe.** As test/mutation-cli.test.mjs does: the script never runs in the repository. A sandbox in
// the OS temp directory holds a copy of `bench/mutation.mjs`, a copy of every file the catalogue mutates, and a stand-in for
// every suite the catalogue names; the run has a hard timeout and the sandbox is checksummed before and after (every mutant
// is restored). Windows: paths via `path`, the child is `process.execPath`, no POSIX tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MUTANTS, parseShard, shardOf, skipsOf } from '../bench/mutation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

// --- group A: the slices -----------------------------------------------------------------------------------------------

test('A parseShard: i/n with 1 <= i <= n, nothing else', () => {
  assert.deepEqual(parseShard('1/3'), { i: 1, n: 3 });
  assert.deepEqual(parseShard('3/3'), { i: 3, n: 3 });
  assert.deepEqual(parseShard('1/1'), { i: 1, n: 1 });
  for (const bad of ['0/3', '4/3', '1/0', '1', '/3', '1/3/5', ' 1/3', '1/3 ', '-1/3', '1.5/3', 'a/b', '', null, undefined, '01/3']) {
    assert.equal(parseShard(bad), null, `${JSON.stringify(bad)} is no slice`);
  }
});

test('A the slices of the real catalogue cover every mutant exactly once, for every n from 1 to 7', () => {
  const ids = MUTANTS.map((_, k) => k);
  for (let n = 1; n <= 7; n += 1) {
    const seen = new Map();
    for (let i = 1; i <= n; i += 1) {
      for (const k of shardOf(ids, { i, n })) seen.set(k, (seen.get(k) || 0) + 1);
    }
    assert.equal(seen.size, ids.length, `n=${n}: a mutant is in no slice`);
    assert.ok([...seen.values()].every((c) => c === 1), `n=${n}: a mutant is in two slices`);
    // Round robin: the slices differ in size by one at most (a contiguous cut would put a run of slow neighbours together).
    const sizes = Array.from({ length: n }, (_, j) => shardOf(ids, { i: j + 1, n }).length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n}: slice sizes ${sizes}`);
  }
  assert.deepEqual(shardOf(ids, null), ids, 'no slice: the whole list');
});

// --- the sandbox ---------------------------------------------------------------------------------------------------------

const SKIP_REASON = 'stand-in: no browser here';

function sandbox(standIn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-shard-'));
  fs.mkdirSync(path.join(dir, 'bench'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'bench', 'mutation.mjs'), path.join(dir, 'bench', 'mutation.mjs'));
  for (const f of new Set(MUTANTS.map((m) => m.file))) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  for (const t of new Set(MUTANTS.flatMap((m) => m.tests))) {
    fs.mkdirSync(path.dirname(path.join(dir, t)), { recursive: true });
    fs.writeFileSync(path.join(dir, t), standIn);
  }
  return dir;
}

function digest(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(path.relative(dir, p).split(path.sep).join('/')).update('\0').update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

/**
 * Runs the sandboxed script; a hard edge, never a measuring window. Without NODE_TEST_CONTEXT: this file runs under
 * `node --test`, which marks its children so that a nested `node --test` reports to its parent in a binary form instead of
 * TAP - the harness, a command, reads the TAP of its own `node --test` runs, as it does when CI starts it.
 */
function run(dir, args, edgeMs) {
  const t0 = Date.now();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(dir, 'bench', 'mutation.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', timeout: edgeMs, killSignal: 'SIGKILL', env,
  });
  return { ...r, ms: Date.now() - t0 };
}

const SKIPPING = `import test from 'node:test';\ntest('stand-in', { skip: ${JSON.stringify(SKIP_REASON)} }, () => {});\n`;
const PASSING = "import test from 'node:test';\ntest('stand-in', () => {});\n";

// --- group B: a suite that only skipped judges nothing ---------------------------------------------------------------

test('B a slice without --only: each mutant whose suite only skipped is NOT JUDGED at once, exit 1, no full-suite run', () => {
  const dir = sandbox(SKIPPING);
  // The sentinel: a suite no mutant names. Only a FULL-suite run (`node --test` without files) starts it, and it leaves a
  // mark next to the sandbox. The old harness spent such a run on every mutant whose suite only skipped.
  const mark = `${dir}-full-suite-ran`;
  fs.writeFileSync(path.join(dir, 'test', 'zz-full-suite-sentinel.test.mjs'),
    `import fs from 'node:fs';\nimport test from 'node:test';\ntest('sentinel', () => { fs.writeFileSync(${JSON.stringify(mark)}, 'x'); });\n`);
  try {
    const n = Math.ceil(MUTANTS.length / 5); // about five mutants in the slice
    const want = shardOf(MUTANTS, { i: 1, n });
    const before = digest(dir);
    const r = run(dir, [`--shard=1/${n}`], 90_000);
    assert.notEqual(r.error?.code, 'ETIMEDOUT', `still running after ${r.ms} ms\n${r.stdout}`);
    assert.equal(fs.existsSync(mark), false, `a full-suite run was spent on a mutant whose suite only skipped\n${r.stdout}`);
    assert.equal(r.status, 1, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    const lines = r.stdout.split('\n').filter((z) => z.includes('NOT JUDGED HERE'));
    assert.equal(lines.length, want.length, `one verdict per mutant of the slice (${want.length}):\n${r.stdout}`);
    for (const z of lines) assert.ok(z.includes(SKIP_REASON), `the skip reason is named: ${z}`);
    assert.match(r.stdout, new RegExp(`0/${want.length} applied mutants caught .*in slice 1/${n} of ${MUTANTS.length} defined;.*${want.length} not judged here`));
    assert.equal(digest(dir), before, 'every mutant was restored');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(mark, { force: true }); }
});

test('B POSITIVE CONTROL: the same slice with suites that RUN (and miss) is judged - a survivor, not "not judged"', () => {
  // --only keeps this cheap (no full-suite run for the survivors) and still goes through the verdict the guard sits in front of.
  const dir = sandbox(PASSING);
  try {
    const file = MUTANTS[0].file;
    const want = MUTANTS.filter((m) => m.file === file);
    const r = run(dir, [`--only=${file}`, '--shard=1/1'], 90_000);
    assert.equal(r.status, 1, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /NOT JUDGED/);
    assert.equal((r.stdout.match(/NO — SURVIVED/g) || []).length, want.length, r.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B skipsOf reads the TAP summary and the first skip reason; a run without skips reads 0', () => {
  const tap = 'ok 1 - a\nok 2 - b # SKIP no startable Chromium\nok 3 - c # SKIP other\n1..3\n# tests 3\n# pass 1\n# skipped 2\n';
  assert.deepEqual(skipsOf(tap), { skipped: 2, reason: 'no startable Chromium' });
  assert.deepEqual(skipsOf('ok 1 - a\n# tests 1\n# pass 1\n# skipped 0\n'), { skipped: 0, reason: null });
  assert.deepEqual(skipsOf(''), { skipped: 0, reason: null });
  assert.deepEqual(skipsOf(undefined), { skipped: 0, reason: null });
});

// --- the switch itself ---------------------------------------------------------------------------------------------------

test('a bad slice is refused with exit 2 before anything is touched; --help names --shard', () => {
  const dir = sandbox(PASSING);
  try {
    const before = digest(dir);
    for (const args of [['--shard=0/3'], ['--shard=4/3'], ['--shard=x'], ['--shard=1/2', '--shard=2/2'], ['--shard']]) {
      const r = run(dir, args, 15_000);
      assert.equal(r.status, 2, `${args.join(' ')}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /Nothing was touched/);
      assert.equal(r.stdout, '', 'a refusal prints nothing on stdout');
    }
    const h = run(dir, ['--help'], 15_000);
    assert.equal(h.status, 0);
    assert.match(h.stdout, /--shard=<i>\/<n>/);
    assert.equal(digest(dir), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- group C: CI sweeps every slice, and `npm run verify` stays the whole thing --------------------------------------------

/** One job's block out of ci.yml: from `  <name>:` to the next job at the same indent. */
function job(ci, name) {
  const from = ci.indexOf(`\n  ${name}:\n`);
  if (from < 0) return null;
  const rest = ci.slice(from + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The violations of "the mutation job sweeps every slice of 1..n exactly once" in a ci.yml text, else []. */
function sliceViolations(ci) {
  const j = job(ci, 'mutation');
  if (!j) return ['no `mutation` job'];
  const runs = [...j.matchAll(/node bench\/mutation\.mjs --shard=\$\{\{ matrix\.shard \}\}\/(\d+)/g)];
  if (runs.length !== 1) return [`${runs.length} sweep lines with --shard=\${{ matrix.shard }}/<n> (wanted 1)`];
  const n = Number(runs[0][1]);
  const m = /\n\s+shard: \[([^\]]*)\]/.exec(j);
  if (!m) return ['no `shard: [...]` matrix'];
  const listed = m[1].split(',').map((z) => Number(z.trim()));
  const want = Array.from({ length: n }, (_, k) => k + 1);
  const out = [];
  if (JSON.stringify([...listed].sort((a, b) => a - b)) !== JSON.stringify(want)) out.push(`matrix ${JSON.stringify(listed)} is not 1..${n}`);
  if (/fail-fast:\s*true/.test(j) || !/fail-fast:\s*false/.test(j)) out.push('fail-fast is not false: one red slice would cancel the others');
  if (!/git status --porcelain/.test(j)) out.push('no "no mutant left behind" step');
  return out;
}

test('C the mutation job sweeps every slice 1..n exactly once (matrix and --shard agree)', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.deepEqual(sliceViolations(ci), []);
});

test('C sabotage: a missing slice, a wrong n, or fail-fast is caught', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const matrix = /(\n\s+shard: )\[[^\]]*\]/;
  assert.ok(matrix.test(ci), 'the matrix line moved - the sabotage would bite nothing');
  assert.notDeepEqual(sliceViolations(ci.replace(matrix, '$1[1, 2]')), [], 'a dropped slice');
  assert.notDeepEqual(sliceViolations(ci.replace(/(--shard=\$\{\{ matrix\.shard \}\}\/)(\d+)/, (_, a, n) => a + (Number(n) + 1))), [], 'n bigger than the matrix');
  const j = job(ci, 'mutation');
  assert.notDeepEqual(sliceViolations(ci.replace(j, j.replace('fail-fast: false', 'fail-fast: true'))), [], 'fail-fast');
  assert.notDeepEqual(sliceViolations(ci.replace(j, j.replace(/\n\s+- name: no mutant left behind[\s\S]*$/, '\n'))), [], 'no clean-tree step');
  assert.notDeepEqual(sliceViolations(ci.replace('\n  mutation:\n', '\n  mutation-gone:\n')), [], 'no job');
});

test('C `npm run verify` is the sweep plus exactly the script the guarantees job runs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.verify, 'node bench/mutation.mjs && npm run --silent verify:benches');
  assert.match(pkg.scripts['verify:benches'], /node bench\/fuzz\.mjs/);
  assert.doesNotMatch(pkg.scripts['verify:benches'], /mutation/, 'the sweep runs in its own job, not twice');
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const verify = job(ci, 'verify');
  assert.ok(verify, 'no verify job');
  assert.match(verify, /run: npm run verify:benches\n/);
  assert.doesNotMatch(verify, /run: npm run verify\n/, 'the whole sweep in the guarantees job again');
});
