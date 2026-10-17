// `node bench/mutation.mjs --help` must print a usage text and stop; an
// argument the script does not know must be refused. Neither may start
// the sweep.
//
// **The finding, 2026-10-17 (twice in one day).** The script read exactly
// two switches (`--security`, `--only=`) and ignored every other word. So
// `--help` meant "no switch" and started the FULL sweep, which rewrites
// source files in the working tree one mutant after another. Two people
// who only wanted the usage text found modified files in their tree.
//
// **How this probe stays safe on a regression.** It never runs the script
// in the repository. It builds a sandbox in the OS temp directory: a copy
// of `bench/mutation.mjs`, a copy of every source file the catalogue
// mutates, and a trivial passing stand-in for every suite the catalogue
// names. The baseline check is then green, so a script that ignores
// `--help` really would start mutating, but only inside the sandbox, and
// the probe's own timeout ends it. The sandbox is checksummed before and
// after, and the run has to finish well inside the timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from '../bench/mutation.mjs';
import { relPosix } from './helpers/relpath.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

// A script that ignores the argument starts a sweep of dozens of mutants,
// each costing two node start-ups. Five seconds is far above what a
// refusal needs and far below what the sweep needs, even on a fast box.
const LIMIT_MS = 5000;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-cli-'));
  fs.mkdirSync(path.join(dir, 'bench'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'bench', 'mutation.mjs'), path.join(dir, 'bench', 'mutation.mjs'));
  // The catalogue also lists the mutants of the atlas gap groups, read from this data-only table (bench/atlas/gap-mutants.mjs).
  fs.mkdirSync(path.join(dir, 'bench', 'atlas'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'bench', 'atlas', 'gap-mutants.mjs'), path.join(dir, 'bench', 'atlas', 'gap-mutants.mjs'));
  // The script decides whether it was started as the program with src/ismain.mjs (CI run 1180), so the copy carries it.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'src', 'ismain.mjs'), path.join(dir, 'src', 'ismain.mjs'));
  for (const f of new Set(MUTANTS.map((m) => m.file))) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  for (const t of new Set(MUTANTS.flatMap((m) => m.tests))) {
    fs.mkdirSync(path.dirname(path.join(dir, t)), { recursive: true });
    fs.writeFileSync(path.join(dir, t),
      "import test from 'node:test';\ntest('stand-in', () => {});\n");
  }
  return dir;
}

function digest(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(relPosix(dir, p)).update('\0').update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

function run(dir, args) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, 'bench', 'mutation.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', timeout: LIMIT_MS, killSignal: 'SIGKILL',
  });
  return { ...r, ms: Date.now() - t0 };
}

function check(args, wantStatus) {
  const dir = sandbox();
  try {
    const before = digest(dir);
    const r = run(dir, args);
    const label = `mutation.mjs ${args.join(' ')}`;
    assert.notEqual(r.error?.code, 'ETIMEDOUT',
      `${label} was still running after ${LIMIT_MS} ms: it started the sweep`);
    assert.equal(r.status, wantStatus,
      `${label} exit ${r.status}, wanted ${wantStatus}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.ms < LIMIT_MS, `${label} took ${r.ms} ms`);
    assert.equal(digest(dir), before, `${label} changed files`);
    return r;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('--help and -h print the usage, exit 0 and touch nothing', () => {
  for (const flag of ['--help', '-h']) {
    const r = check([flag], 0);
    assert.match(r.stdout, /Usage: node bench\/mutation\.mjs/);
    assert.match(r.stdout, /--only=/);
    assert.match(r.stdout, /--security/);
    assert.match(r.stdout, /touches nothing/);
  }
});

test('--help wins over other arguments', () => {
  check(['--security', '--help'], 0);
});

test('an unknown argument is refused with exit 2 and nothing is touched', () => {
  for (const args of [['--frobnicate'], ['-x'], ['--only', 'src/authority.mjs'], ['--security', '--bogus'], ['stray']]) {
    const r = check(args, 2);
    assert.match(r.stderr, /unknown argument/);
    assert.match(r.stderr, /Nothing was touched/);
    assert.equal(r.stdout, '', 'a refusal prints nothing on stdout');
  }
});

test('a known switch is not refused (positive control)', () => {
  // `--only=` with a path no mutant names sweeps nothing: the baseline
  // check runs over the stand-in suites, then the run reports 0/0.
  const r = check(['--only=src/no-such-file.mjs'], 0);
  assert.match(r.stdout, /0\/0 applied mutants caught/);
});
