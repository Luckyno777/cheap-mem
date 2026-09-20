// bench/atlas/phase-doctor.mjs — the state ladder of `mem doctor`.
//
// **The question.** `mem doctor` prints one line per finding, each with
// one of four marks: `ok`, `WARN`, `FAIL`, `?`. On a memory with nothing
// in it, most of those lines say `ok`. `integrity` says "0 entries in 0
// lines — ok". `fact-conflicts` says "0 tracked facts, no conflicts —
// ok". `orphans` says "0 links, all resolve — ok". Each of those is a
// check that looked at nothing and reported health.
//
// The house's own catalogue already carries the invariant this violates
// (`shared/invariants.jsonl`, `leer-ist-kein-bestehen`): "An instrument
// that checked nothing does not pass." This phase applies that invariant
// to the instrument that states it.
//
// **What is measured.** Every finding `mem doctor` emits, on four rungs:
//
//   1. empty      a fresh root, `mem init`, nothing in it
//   2. one        exactly one entry, written through the real CLI
//   3. thousand   buildCorpus(root, 1000)
//   4. broken     one deliberately prepared root PER FINDING, built to
//                 make that one finding leave `ok`
//
// Rungs 1-3 are the innocence probe: a finding that goes red on a
// healthy memory is a gate that reports the innocent, and a gate that
// reports the innocent gets switched off. Rung 4 is the sabotage
// counter-probe: a finding that stays `ok` while the thing it watches is
// broken is a line that does nothing but promises something.
//
// **The number it all comes down to.** How many findings ever showed a
// state other than `ok`? One that never moves across the whole ladder
// cannot fail, and a check that cannot fail is decoration. That is
// `doctor.can-fail`. Beside it sits the stricter companion
// `doctor.can-alarm` — how many ever reached WARN or FAIL — because `?`
// is honest but it is not an alarm, and the two numbers answer different
// questions.
//
// **Two deliberate deviations, both stated rather than hidden:**
//
//   - Some findings only exist for a versioned memory (`behind`, `git`,
//     `gitignore`, `append-only-git`, `env/merge-driver`,
//     `env/pre-commit`). Their recipes `git init` and commit INSIDE a
//     throwaway root under the OS temp directory — never in this
//     repository, and `assertThrowaway()` below refuses any git write
//     against a path outside `os.tmpdir()`. The repo's own history is
//     never touched.
//   - `redaction` has no external input at all: its canaries are frozen
//     constants in `src/redaction.mjs`. It is probed against a COPY of
//     the tool (`src/` + `bin/`, no dependencies) with one canary sample
//     replaced, and the record says so. A mutant probe answers "can this
//     gate fire", not "is this gate wired to reality"; the difference is
//     written into the record rather than smoothed over.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { CANARIES } from '../../src/redaction.mjs';

/**
 * The aws-key-id sample, read from the redaction module's own canary
 * table rather than written out here.
 *
 * Two probes below need it — one plants it in a capture, one patches it
 * out of a copy of `src/redaction.mjs` — and both used to carry the
 * literal. That was a second source of truth AND a string this repo's
 * pre-commit secret scanner reports, correctly, as a key id. (It is
 * AWS's own published example value, so nothing here is a credential;
 * the point is that a benchmark should not make a scanner cry wolf.)
 * Reading it from the table means a sample that moves breaks loudly,
 * which is what the patch probe already asserts for itself.
 */
const AWS_KEY_SAMPLE = (() => {
  const row = CANARIES.find(([type]) => type === 'aws-key-id');
  if (!row) throw new Error('the aws-key-id canary is gone from src/redaction.mjs');
  return row[1];
})();

import {
  VERDICT, SEVERITY, mem, buildCorpus, tempRoot, REPO,
} from './core.mjs';

// --- reading the doctor's output -------------------------------------
//
// There is no `--json`. Checked in the code, not in the help text:
// `src/cli/commands/admin.mjs` calls
// `checkFlags(args, ['quiet', 'strict', 'alarm'], 'doctor')`, so any
// other flag is refused. The only machine-readable thing on offer is the
// fixed four-mark prefix `report()` writes in `src/doctor.mjs`:
//
//     `${mark[level]}  ${name.padEnd(12)} ${text}`
//     mark = { good: 'ok  ', warn: 'WARN', error: 'FAIL', unknown: '?   ' }
//
// Advice lines are indented, so a leading space is the discriminator. A
// name longer than 12 characters is not truncated, so the separator
// between name and text is "one or more spaces", never a fixed column.

const MARK_TO_LEVEL = Object.freeze({
  ok: 'good', WARN: 'warn', FAIL: 'error', '?': 'unknown',
});

const FINDING_LINE = /^(ok|WARN|FAIL|\?)\s{2,}([A-Za-z][A-Za-z0-9/_-]*)\s+(\S[\s\S]*)$/;
const SUMMARY_LINE = /^(\d+) good, (\d+) warnings, (\d+) errors, (\d+) unchecked\s+—\s+overall: (\w+)/;

/**
 * Parse one `mem doctor` run.
 *
 * Returns the findings in order, the summary line, and — this is the
 * part that matters — `unparsed`, every non-empty line that matched
 * neither. A parser that silently drops what it does not understand
 * reports a clean read of an output it never understood.
 */
export function parseDoctor(stdout) {
  const levels = new Map();
  const texts = new Map();
  const order = [];
  const unparsed = [];
  let summary = null;

  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) continue;            // advice, indented by report()
    const s = SUMMARY_LINE.exec(line);
    if (s) {
      summary = {
        good: Number(s[1]), warn: Number(s[2]),
        error: Number(s[3]), unknown: Number(s[4]), overall: s[5],
      };
      continue;
    }
    const f = FINDING_LINE.exec(line);
    if (!f) { unparsed.push(line.slice(0, 200)); continue; }
    const name = f[2];
    if (levels.has(name)) { unparsed.push(`duplicate finding name: ${name}`); continue; }
    levels.set(name, MARK_TO_LEVEL[f[1]]);
    texts.set(name, f[3].trim());
    order.push(name);
  }

  // The cross-check that makes this a measurement rather than a guess:
  // the doctor counts its own findings, so the parse can be held against
  // that count instead of against a hand-kept list.
  const counted = { good: 0, warn: 0, error: 0, unknown: 0 };
  for (const l of levels.values()) counted[l] += 1;
  const agrees = summary !== null
    && counted.good === summary.good && counted.warn === summary.warn
    && counted.error === summary.error && counted.unknown === summary.unknown;

  return { levels, texts, order, summary, counted, unparsed, agrees };
}

// --- throwaway roots --------------------------------------------------

/**
 * Nothing in this phase writes outside the OS temp directory, and git in
 * particular never runs against anything else.
 *
 * The house rule is "no git write operations". The recipes below need a
 * repository to exist at all — `behind`, `gitignore`, `append-only-git`
 * and both git-layer environment findings are unreachable without one —
 * so they build one from nothing in a directory that is deleted at exit.
 * This guard is what keeps that from ever becoming a write to a real
 * checkout: it throws rather than trusting the caller.
 */
function assertThrowaway(root) {
  const real = path.resolve(root);
  const tmp = path.resolve(os.tmpdir());
  if (!real.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(`refusing to write git state outside ${tmp}: ${real}`);
  }
  if (real.startsWith(path.resolve(REPO))) {
    throw new Error(`refusing to write git state inside the repository: ${real}`);
  }
  return real;
}

/** A fresh memory root with `mem init` run in it. Throws if init failed. */
function newRoot(tag) {
  const root = tempRoot(`atlas-doctor-${tag}-`);
  const r = mem(['init'], { root });
  if (r.status !== 0) throw new Error(`mem init failed in ${root}: ${r.stderr || r.stdout}`);
  return root;
}

/** git, always `-C root`, always against a throwaway. */
function git(root, ...args) {
  assertThrowaway(root);
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

/**
 * Turn a throwaway root into a git repository with one commit.
 *
 * `user.*` and `commit.gpgsign` are set LOCALLY: a runner whose global
 * git config is empty (CI) or signs everything (a developer laptop)
 * would otherwise decide whether this probe runs at all.
 */
function gitRepo(root, { commit = true } = {}) {
  git(root, 'init', '-q');
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(root, 'config', 'user.email', 'atlas@example.invalid');
  git(root, 'config', 'user.name', 'atlas');
  git(root, 'config', 'commit.gpgsign', 'false');
  if (commit) {
    git(root, 'add', '-A');
    const c = git(root, 'commit', '-q', '-m', 'base');
    if (c.status !== 0) throw new Error(`git commit failed: ${c.stderr || c.stdout}`);
  }
  return root;
}

// --- writing material into a root ------------------------------------

function appendLines(root, file, objects, { project = null } = {}) {
  const dir = project ? path.join(root, 'projects', project) : path.join(root, 'global');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.appendFileSync(p, `${objects.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n')}\n`);
  return p;
}

/** `2026-09-19T21-16-25Z` — the shape `timeFromCaptureName` parses. */
function captureStamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/**
 * Write one capture where `raw.listCaptures` and `checkArchiveBacklog`
 * both look: `raw/YYYY/MM/<stamp>--<tag>.jsonl.gz`, gzipped JSONL with a
 * `__stamp` header line.
 */
function writeCapture(root, { daysAgo = 0, tag = 'atlas', lines = [], minBytes = 0 } = {}) {
  const when = new Date(Date.now() - daysAgo * 86400000);
  const dir = path.join(root, 'raw',
    String(when.getUTCFullYear()), String(when.getUTCMonth() + 1).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join('raw', String(when.getUTCFullYear()),
    String(when.getUTCMonth() + 1).padStart(2, '0'), `${captureStamp(when)}--${tag}.jsonl.gz`);
  const abs = path.join(root, rel);
  const head = JSON.stringify({ __stamp: { session_id: tag, surface: 'atlas', at: when.toISOString() } });

  // The threshold this feeds (`raw.due`'s volumeNow) is measured on the
  // file ON DISK, after gzip. A padding whose size is chosen before
  // compression is a padding that pads an unknown amount: the first
  // version of this asked for 600 KB and produced a 265 KB file, and
  // the recipe reported `ok` for a digest it had failed to make due.
  // So: write, measure, grow, and give up loudly rather than quietly
  // handing back a file that is too small.
  let padChars = minBytes > 0 ? minBytes * 2 : 0;
  for (let attempt = 0; ; attempt += 1) {
    const body = [head, ...lines.map((l) => JSON.stringify(l))];
    if (padChars > 0) {
      let filler = '';
      while (filler.length < padChars) filler += Math.random().toString(36).slice(2, 18);
      body.push(JSON.stringify({ role: 'user', text: filler }));
    }
    fs.writeFileSync(abs, zlib.gzipSync(`${body.join('\n')}\n`));
    if (minBytes === 0 || fs.statSync(abs).size >= minBytes) break;
    if (attempt >= 5) {
      throw new Error(`could not pad ${rel} to ${minBytes} bytes (got ${fs.statSync(abs).size})`);
    }
    padChars *= 2;
  }
  return rel.split(path.sep).join('/');
}

function writeConfigKey(root, key, value) {
  const p = path.join(root, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg[key] = value;
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** A `stat` that lies, first on PATH. See the append-atomicity recipe. */
function statShim(root, answer) {
  const dir = path.join(root, '.atlas-shim');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'stat');
  fs.writeFileSync(p, `#!/bin/sh\necho ${answer}\n`);
  fs.chmodSync(p, 0o755);
  return { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` };
}

/**
 * A copy of the tool with one line changed — for the single finding
 * whose input is a frozen constant inside the source.
 *
 * `src/` and `bin/` import nothing outside node builtins (checked), so a
 * copy of those two plus `package.json` is a complete, runnable tool.
 */
function mutantTool(tag, patch) {
  const home = tempRoot(`atlas-doctor-${tag}-tool-`);
  fs.cpSync(path.join(REPO, 'src'), path.join(home, 'src'), { recursive: true });
  fs.cpSync(path.join(REPO, 'bin'), path.join(home, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(home, 'package.json'));
  patch(home);
  return path.join(home, 'bin', 'mem');
}

/** Run a doctor and parse it. `tool` defaults to the repository's own. */
function doctorOn(root, { env = {}, tool = null } = {}) {
  const r = tool
    ? (() => {
      const t0 = process.hrtime.bigint();
      const p = spawnSync(process.execPath, [tool, 'doctor'], {
        cwd: root,
        env: { ...process.env, CHEAP_MEM_ROOT: root, ...env },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return {
        status: p.status, stdout: p.stdout ?? '', stderr: p.stderr ?? '',
        ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2),
      };
    })()
    : mem(['doctor'], { root, env });
  return { ...parseDoctor(r.stdout), raw: r.stdout, stderr: r.stderr, status: r.status, ms: r.ms };
}

// --- the recipes ------------------------------------------------------
//
// One per finding. `aim` is the state the recipe is built to produce;
// it is compared against what actually came out, and a recipe that does
// not move its finding is reported as a finding of its own rather than
// quietly dropped.
//
// `note` says what was done, in one line, so a later reader can disagree
// with the recipe without re-deriving it from the code.

const RECIPES = [
  {
    finding: 'git-hook',
    aim: ['error'],
    note: 'git repo with core.hooksPath pointing at a directory that has no pre-commit',
    build: (t) => {
      const root = newRoot(t); gitRepo(root);
      git(root, 'config', 'core.hooksPath', '.mem/hooks');
      return { root };
    },
  },
  {
    finding: 'drawers',
    aim: ['error'],
    note: 'one unparsable line appended to global/learnings.jsonl',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'learnings.jsonl', [{ id: 'd1', ts: '2026-01-01T00:00:00Z', title: 'fine', text: 'fine' }]);
      appendLines(root, 'learnings.jsonl', ['{"id": "d2", "ts": broken']);
      return { root };
    },
  },
  {
    finding: 'capture',
    aim: ['good'],
    // The other direction: `capture` is WARN on an empty memory, so the
    // interesting move for it is towards ok, not away from it.
    note: 'one capture written into raw/ — the positive control for a finding that starts at WARN',
    build: (t) => {
      const root = newRoot(t);
      writeCapture(root, { daysAgo: 0, lines: [{ role: 'user', text: 'hello' }] });
      return { root };
    },
  },
  {
    finding: 'archive-backlog',
    aim: ['error'],
    note: `oldest capture in raw/ dated 9 days back (BACKLOG_DEAD_DAYS = 7)`,
    build: (t) => {
      const root = newRoot(t);
      writeCapture(root, { daysAgo: 9, tag: 'old', lines: [{ role: 'user', text: 'x' }] });
      return { root };
    },
  },
  {
    finding: 'archive-backlog',
    id: 'archive-backlog-warn',
    aim: ['warn'],
    note: `oldest capture in raw/ dated 3 days back (BACKLOG_LATE_DAYS = 2, DEAD = 7)`,
    build: (t) => {
      const root = newRoot(t);
      writeCapture(root, { daysAgo: 3, tag: 'late', lines: [{ role: 'user', text: 'x' }] });
      return { root };
    },
  },
  {
    finding: 'digest',
    aim: ['warn'],
    note: 'watermark present, one capture over the 500 KB volumeNow line open, no bell — due by volume',
    build: (t) => {
      const root = newRoot(t);
      writeCapture(root, { tag: 'big', minBytes: 520 * 1024 });
      fs.writeFileSync(path.join(root, '.mem', 'raw-watermark.json'),
        JSON.stringify({ digested: [] }));
      return { root };
    },
  },
  {
    finding: 'digest-yield',
    aim: ['warn'],
    note: 'three captures marked digested in the watermark, no entry carrying origin.raw — gap ratio 1.0 > 0.4',
    build: (t) => {
      const root = newRoot(t);
      const caps = [0, 1, 2].map((i) => writeCapture(root,
        { daysAgo: i, tag: `y${i}`, lines: [{ role: 'user', text: 'x' }] }));
      fs.writeFileSync(path.join(root, '.mem', 'raw-watermark.json'),
        JSON.stringify({ digested: caps, last: '2026-09-01T00:00:00Z' }));
      return { root };
    },
  },
  {
    finding: 'fact-conflicts',
    aim: ['warn'],
    note: 'two timeline lines, same key, same valid_from, different value',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'timeline.jsonl', [
        { id: 'f1', ts: '2026-02-01T00:00:00Z', key: 'role', value: 'builder', valid_from: '2026-02-01' },
        { id: 'f2', ts: '2026-02-01T00:00:00Z', key: 'role', value: 'auditor', valid_from: '2026-02-01' },
      ]);
      return { root };
    },
  },
  {
    finding: 'orphans',
    aim: ['warn'],
    note: 'a correction whose replaces_id names an id that was never written',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'decisions.jsonl', [
        { id: 'o1', ts: '2026-02-01T00:00:00Z', topic: 'x', choice: 'a', why: 'b', replaces_id: 'never-written' },
      ]);
      return { root };
    },
  },
  {
    finding: 'topic-quality',
    aim: ['warn'],
    note: 'four decisions, four distinct topics — 1.0 entries per topic, under the 1.2 line',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'decisions.jsonl', [0, 1, 2, 3].map((i) => ({
        id: `t${i}`, ts: '2026-02-01T00:00:00Z', topic: `topic-${i}`, choice: 'a', why: 'b',
      })));
      return { root };
    },
  },
  {
    finding: 'delivery',
    aim: ['error'],
    note: 'a message in inbox/ with no blank line after the header — unreadable, not merely undelivered',
    build: (t) => {
      const root = newRoot(t);
      fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
      fs.writeFileSync(path.join(root, 'inbox', 'broken.md'),
        'From: user\nTo: session\nTime: 2026-02-01T00:00:00Z\nSubject: x\nState: open\nno blank line above me\n');
      return { root };
    },
  },
  {
    finding: 'delivery',
    id: 'delivery-warn',
    aim: ['warn'],
    note: 'an open message addressed to a recipient nobody registered and nobody writes as',
    build: (t) => {
      const root = newRoot(t);
      fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
      fs.writeFileSync(path.join(root, 'inbox', 'lost.md'),
        'From: user\nTo: nobody-at-all\nTime: 2026-02-01T00:00:00Z\nSubject: x\nState: open\n\nhello\n');
      return { root };
    },
  },
  {
    finding: 'index',
    aim: ['good'],
    note: '20 entries — the positive control for a finding that is WARN on an empty memory',
    build: (t) => {
      const root = newRoot(t);
      buildCorpus(root, 20, { seed: 7, anchors: 2 });
      return { root };
    },
  },
  {
    finding: 'synonyms',
    aim: ['warn'],
    // Not done by switching the configured language: the curated list
    // holds German words beside the English ones, so `language: de`
    // still covers a normal vocabulary. What the check actually measures
    // is whether the memory's OWN commonest words are in the list, so
    // the sabotage has to be a vocabulary the list cannot know.
    note: '25 entries written in an invented vocabulary — the curated list knows none of its commonest words',
    build: (t) => {
      const root = newRoot(t);
      const words = [];
      for (let i = 0; i < 80; i += 1) words.push(`zzq${i.toString(36)}vocab`);
      const entries = [];
      for (let i = 0; i < 25; i += 1) {
        const pick = (k) => words[(i * 7 + k * 13) % words.length];
        entries.push({
          id: `v${i}`, ts: '2026-02-01T00:00:00Z',
          title: `${pick(0)} ${pick(1)}`,
          text: [2, 3, 4, 5, 6, 7].map(pick).join(' '),
        });
      }
      appendLines(root, 'learnings.jsonl', entries);
      return { root };
    },
  },
  {
    finding: 'stop-hook',
    aim: ['good'],
    note: 'root/.claude/settings.json with a Stop hook naming mem-capture — the positive control',
    build: (t) => {
      const root = newRoot(t);
      fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bin/mem-capture' }] }] },
      }));
      return { root };
    },
  },
  {
    finding: 'stop-hook',
    id: 'stop-hook-warn',
    aim: ['warn'],
    note: 'the same file naming the old mem-reflect instead',
    build: (t) => {
      const root = newRoot(t);
      fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bin/mem-reflect' }] }] },
      }));
      return { root };
    },
  },
  {
    finding: 'legacy',
    aim: ['error'],
    note: "a capture holding AWS's own documented example key id — a value today's rules catch",
    build: (t) => {
      const root = newRoot(t);
      writeCapture(root, {
        tag: 'leak',
        lines: [{ role: 'user', text: `deploy with ${AWS_KEY_SAMPLE} please` }],
      });
      return { root };
    },
  },
  {
    finding: 'behind',
    aim: ['warn'],
    note: 'two commits, origin/main set to the second, HEAD left on the first — one commit behind',
    build: (t) => {
      const root = newRoot(t); gitRepo(root);
      const first = git(root, 'rev-parse', 'HEAD').stdout.trim();
      appendLines(root, 'learnings.jsonl',
        [{ id: 'b1', ts: '2026-02-01T00:00:00Z', title: 'second', text: 'second commit' }]);
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'second');
      const second = git(root, 'rev-parse', 'HEAD').stdout.trim();
      git(root, 'update-ref', 'refs/remotes/origin/main', second);
      git(root, 'update-ref', 'refs/heads/main', first);
      return { root };
    },
  },
  {
    finding: 'git',
    aim: ['warn'],
    note: 'a committed repository with an uncommitted line in global/learnings.jsonl',
    build: (t) => {
      const root = newRoot(t); gitRepo(root);
      appendLines(root, 'learnings.jsonl',
        [{ id: 'g1', ts: '2026-02-01T00:00:00Z', title: 'uncommitted', text: 'not in git' }]);
      return { root };
    },
  },
  {
    finding: 'integrity',
    aim: ['error'],
    note: 'two entries with the same id',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'learnings.jsonl', [
        { id: 'same', ts: '2026-02-01T00:00:00Z', title: 'one', text: 'one' },
        { id: 'same', ts: '2026-02-02T00:00:00Z', title: 'two', text: 'two' },
      ]);
      return { root };
    },
  },
  {
    finding: 'entry-form',
    aim: ['warn'],
    note: 'an entry with a field name containing whitespace — the swallowed-value shape',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'learnings.jsonl', [
        { id: 'e1', ts: '2026-02-01T00:00:00Z', title: true, '--flag-ish text': true },
      ]);
      return { root };
    },
  },
  {
    finding: 'gitignore',
    aim: ['error'],
    note: 'a git repository whose .gitignore is empty — .mem/embed.env is not ignored',
    build: (t) => {
      const root = newRoot(t);
      fs.writeFileSync(path.join(root, '.gitignore'), '');
      gitRepo(root);
      return { root };
    },
  },
  {
    finding: 'rollback',
    aim: ['error'],
    note: 'watermark taken over three claims, then the log emptied — claims went backwards',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'learnings.jsonl', [0, 1, 2].map((i) => ({
        id: `r${i}`, ts: '2026-02-01T00:00:00Z', title: `claim ${i}`, text: 'x',
      })));
      const rec = mem(['epoch', 'record'], { root });
      if (rec.status !== 0) throw new Error(`mem epoch record failed: ${rec.stderr || rec.stdout}`);
      fs.writeFileSync(path.join(root, 'global', 'learnings.jsonl'), '');
      return { root, extra: { epochRecord: rec.stdout.trim() } };
    },
  },
  {
    finding: 'env/merge-driver',
    aim: ['error'],
    note: 'a git repository with no .gitattributes — *.jsonl merge=union is not declared',
    build: (t) => {
      const root = newRoot(t);
      fs.rmSync(path.join(root, '.gitattributes'), { force: true });
      gitRepo(root);
      return { root };
    },
  },
  {
    finding: 'env/pre-commit',
    aim: ['error'],
    note: 'a git repository with core.hooksPath unset — a fresh clone does not inherit it',
    build: (t) => {
      const root = newRoot(t);
      gitRepo(root);
      return { root };
    },
  },
  {
    finding: 'env/append-atomicity',
    aim: ['error'],
    note: "a `stat` first on PATH answering 'nfs' — the filesystem this check reads cannot be mounted on demand",
    mutant: 'the probe binary the check shells out to, not cheap-mem itself',
    build: (t) => {
      const root = newRoot(t);
      return { root, env: statShim(root, 'nfs') };
    },
  },
  {
    finding: 'env/clock',
    aim: ['error'],
    note: 'one entry timestamped a day in the future',
    build: (t) => {
      const root = newRoot(t);
      const ahead = new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      appendLines(root, 'learnings.jsonl',
        [{ id: 'c1', ts: ahead, title: 'from tomorrow', text: 'x' }]);
      return { root };
    },
  },
  {
    finding: 'corpus-size',
    aim: ['warn'],
    note: 'corpusWarnThreshold lowered to 1 in .mem/config.json — the documented knob, instead of writing 50000 entries',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'learnings.jsonl', [0, 1, 2].map((i) => ({
        id: `s${i}`, ts: '2026-02-01T00:00:00Z', title: `entry ${i}`, text: 'x',
      })));
      writeConfigKey(root, 'corpusWarnThreshold', 1);
      return { root };
    },
  },
  {
    finding: 'append-only-git',
    aim: ['error'],
    note: 'a committed log whose FIRST line is rewritten in the working tree instead of appended to',
    build: (t) => {
      const root = newRoot(t);
      appendLines(root, 'learnings.jsonl', [
        { id: 'a1', ts: '2026-02-01T00:00:00Z', title: 'original', text: 'as committed' },
        { id: 'a2', ts: '2026-02-02T00:00:00Z', title: 'second', text: 'also committed' },
      ]);
      gitRepo(root);
      const p = path.join(root, 'global', 'learnings.jsonl');
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines[0] = JSON.stringify({ id: 'a1', ts: '2026-02-01T00:00:00Z', title: 'REWRITTEN', text: 'edited in place' });
      fs.writeFileSync(p, lines.join('\n'));
      return { root };
    },
  },
  {
    finding: 'finding-parity',
    aim: ['warn'],
    note: 'this repo\'s src/doctor.mjs copied into the root, beside a sibling lucky-mem whose src/doktor.mjs knows two findings',
    build: (t) => {
      // The root is a SUBDIRECTORY of the throwaway, because
      // `siblingClone` looks at `path.dirname(root)/lucky-mem` first —
      // and inventing a /tmp/lucky-mem would be a write outside the
      // directory this phase cleans up.
      const home = tempRoot(`atlas-doctor-${t}-`);
      const root = path.join(home, 'house');
      fs.mkdirSync(root, { recursive: true });
      const init = mem(['init'], { root });
      if (init.status !== 0) throw new Error(`mem init failed: ${init.stderr || init.stdout}`);
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.copyFileSync(path.join(REPO, 'src', 'doctor.mjs'), path.join(root, 'src', 'doctor.mjs'));
      const sibling = path.join(home, 'lucky-mem', 'src');
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(sibling, 'doktor.mjs'),
        "befund('wurzel', 1, 'x');\nbefund('konfiguration', 1, 'x');\n");
      return { root };
    },
  },
  {
    finding: 'redaction',
    aim: ['error'],
    mutant: "src/redaction.mjs, with the aws-key-id canary sample replaced by a string no rule matches",
    note: 'the only finding whose input is a frozen constant — probed against a copy of the tool',
    build: (t) => {
      const root = newRoot(t);
      const tool = mutantTool(t, (home) => {
        const p = path.join(home, 'src', 'redaction.mjs');
        const src = fs.readFileSync(p, 'utf8');
        const patched = src.replace(`'${AWS_KEY_SAMPLE}'`, "'not-a-key-at-all'");
        if (patched === src) throw new Error('the canary sample moved — the patch matched nothing');
        fs.writeFileSync(p, patched);
      });
      return { root, tool };
    },
  },
];

/**
 * Findings with no recipe, and why. Not a list of excuses: each of these
 * becomes a `not-measured` record AND a blind spot, because a harness
 * that drops what it cannot reach reports health for something it never
 * looked at.
 */
const NO_RECIPE = [
  {
    finding: 'root',
    why: 'unreachable through the CLI: `mem doctor` calls requireConfig(root) BEFORE checkAll, '
      + 'and a root that does not exist has no .mem/config.json, so the command dies with '
      + '"No memory config at ..." and checkRoot never runs. The only state this finding can '
      + 'ever print is ok.',
  },
  {
    finding: 'config',
    why: 'same gate: requireConfig(root) reads the same config checkConfig would report on, and '
      + 'dies first with "Config error: ...". Probed directly — an invalid .mem/config.json '
      + 'produces no doctor output at all, so the finding can only ever print ok.',
  },
];

// --- the phase --------------------------------------------------------

export async function run(atlas) {
  atlas.phase('doctor', 'The state ladder of `mem doctor`',
    'Every finding, on four rungs: an empty memory, one entry, a thousand entries, and one '
    + 'root per finding prepared to make exactly that finding leave `ok`. The two numbers at '
    + 'the end are how many findings ever left `ok` at all, and how many report `ok` on a '
    + 'memory that holds nothing — the invariant `leer-ist-kein-bestehen` applied to the '
    + 'instrument that states it.');

  // --- 0. can the output be read by a machine at all? ----------------
  //
  // A tool whose output nobody can parse is not usable in a chain, so
  // this is checked before anything is built on top of it — and checked
  // with a positive control, because a parser that returns an empty map
  // for every input would otherwise look like a parser that works.
  const probe = parseDoctor([
    'ok    root         /tmp/x',
    'WARN  git-hook     core.hooksPath is not set',
    '                   -> mem hooks install',
    'FAIL  env/clock    [operational] the newest entry is 5 min in the future',
    '?     synonyms     too few entries to judge',
    '',
    '1 good, 1 warnings, 1 errors, 1 unchecked  —  overall: error',
  ].join('\n'));
  const controlOk = probe.agrees
    && probe.levels.get('root') === 'good'
    && probe.levels.get('git-hook') === 'warn'
    && probe.levels.get('env/clock') === 'error'
    && probe.levels.get('synonyms') === 'unknown'
    && probe.unparsed.length === 0;
  const noise = parseDoctor('this is not doctor output\nneither is this\n');
  const noiseCaught = noise.unparsed.length === 2 && noise.levels.size === 0 && !noise.agrees;

  atlas.record({
    id: 'doctor.parser.control',
    title: 'the parser reads all four marks, and says so when it reads nothing',
    verdict: controlOk && noiseCaught ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'a hand-made sample parses to good/warn/error/unknown; noise yields 0 findings and unparsed lines',
    actual: `control ${controlOk ? 'read' : 'MISREAD'}, noise ${noiseCaught ? 'flagged' : 'SWALLOWED'}`,
    measured: { control: Object.fromEntries(probe.levels), noiseUnparsed: noise.unparsed },
    severity: SEVERITY.CRITICAL,
  });

  // --- 1..3 the healthy rungs ----------------------------------------
  const rungs = [];

  const emptyRoot = newRoot('empty');
  rungs.push({ name: 'empty', note: 'fresh root, `mem init`, nothing in it', run: doctorOn(emptyRoot) });

  const oneRoot = newRoot('one');
  const logged = mem(['log', 'learning',
    '--title', 'the single entry',
    '--text', 'one entry so the ladder has a rung between nothing and a corpus'], { root: oneRoot });
  rungs.push({
    name: 'one',
    note: `exactly one entry, written through the CLI (exit ${logged.status})`,
    run: doctorOn(oneRoot),
  });

  // A second shape of "empty", because the first one answers a narrower
  // question than it looks like it does. Six findings are UNKNOWN on a
  // bare root only because there is no git repository under it
  // (`behind`, `git`, `gitignore`, `append-only-git` and both git-layer
  // environment checks). On a memory that IS versioned — the normal
  // case, and the one the quoted "23 good, 2 warnings, 0 errors, 5
  // unchecked" describes — those turn into `ok` while the memory still
  // holds nothing. Left out, this phase would undercount the very thing
  // it is measuring.
  const emptyGitRoot = newRoot('empty-versioned');
  gitRepo(emptyGitRoot);
  git(emptyGitRoot, 'update-ref', 'refs/remotes/origin/main',
    git(emptyGitRoot, 'rev-parse', 'HEAD').stdout.trim());
  const emptyVersioned = doctorOn(emptyGitRoot);

  const thousandRoot = newRoot('thousand');
  const corpus = buildCorpus(thousandRoot, 1000, { seed: 42 });
  rungs.push({
    name: 'thousand',
    note: `buildCorpus(root, 1000) — ${corpus.count} entries in ${corpus.files} files`,
    run: doctorOn(thousandRoot),
  });

  for (const rung of rungs) {
    const r = rung.run;
    atlas.record({
      id: `doctor.rung.${rung.name}`,
      title: `rung "${rung.name}" — ${rung.note}`,
      verdict: r.agrees && r.unparsed.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'every printed finding parses, and the count agrees with the doctor\'s own summary',
      actual: r.summary
        ? `${r.levels.size} findings parsed; doctor says ${r.summary.good} good, `
          + `${r.summary.warn} warn, ${r.summary.error} error, ${r.summary.unknown} unknown`
        : 'no summary line found',
      measured: {
        levels: Object.fromEntries(r.levels),
        summary: r.summary,
        unparsed: r.unparsed,
        exit: r.status,
        raw: r.raw,
      },
      evidence: r.unparsed.length ? r.unparsed.join('\n') : null,
      severity: SEVERITY.MAJOR,
      ms: r.ms,
    });
  }

  atlas.record({
    id: 'doctor.rung.empty-versioned',
    title: 'rung "empty" again, this time on a memory under git — nothing in it, one commit, an origin ref',
    verdict: emptyVersioned.agrees && emptyVersioned.unparsed.length === 0
      ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'every printed finding parses, and the count agrees with the doctor\'s own summary',
    actual: emptyVersioned.summary
      ? `${emptyVersioned.summary.good} good, ${emptyVersioned.summary.warn} warn, `
        + `${emptyVersioned.summary.error} error, ${emptyVersioned.summary.unknown} unknown`
      : 'no summary line found',
    measured: {
      levels: Object.fromEntries(emptyVersioned.levels),
      summary: emptyVersioned.summary,
      unparsed: emptyVersioned.unparsed,
      raw: emptyVersioned.raw,
    },
    severity: SEVERITY.MAJOR,
    ms: emptyVersioned.ms,
  });

  // The full roster of findings, taken from the runs themselves. A
  // hand-kept list here would go stale the next time a finding is added
  // — the exact failure `checkFindingParity` exists to catch.
  const allFindings = new Set();
  for (const rung of rungs) for (const n of rung.run.levels.keys()) allFindings.add(n);

  // --- 4. one prepared root per finding ------------------------------
  const ladder = new Map();   // finding -> { rung -> level }
  for (const name of allFindings) {
    const row = {};
    for (const rung of rungs) row[rung.name] = rung.run.levels.get(name) ?? 'absent';
    ladder.set(name, row);
  }

  const brokenResults = [];
  for (const recipe of RECIPES) {
    const id = recipe.id ?? recipe.finding;
    const tag = id.replace(/[^a-z0-9]+/gi, '-');
    let built = null; let out = null; let failure = null;
    try {
      built = recipe.build(tag);
      out = doctorOn(built.root, { env: built.env ?? {}, tool: built.tool ?? null });
    } catch (e) {
      failure = String(e && e.message).slice(0, 400);
    }

    const got = out ? (out.levels.get(recipe.finding) ?? 'absent') : 'not-run';
    const hit = recipe.aim.includes(got);
    if (out) {
      const row = ladder.get(recipe.finding) ?? {};
      // Several recipes can target one finding; keep the worst-news one
      // in the ladder cell and let the per-recipe records carry the rest.
      const rank = { good: 0, unknown: 1, warn: 2, error: 3, absent: -1 };
      if (!row.broken || (rank[got] ?? -1) > (rank[row.broken] ?? -1)) row.broken = got;
      ladder.set(recipe.finding, row);
      brokenResults.push({ id, finding: recipe.finding, level: got });
    }

    atlas.record({
      id: `doctor.break.${id}`,
      title: `${recipe.finding} under sabotage — ${recipe.note}`,
      verdict: failure ? VERDICT.NOT_MEASURED : (hit ? VERDICT.PASS : VERDICT.FAIL),
      expected: `${recipe.finding} reports ${recipe.aim.join(' or ')}`,
      actual: failure ? `recipe could not be built: ${failure}` : got,
      measured: out ? {
        level: got,
        text: out.texts.get(recipe.finding) ?? null,
        mutant: recipe.mutant ?? null,
        summary: out.summary,
        exit: out.status,
        raw: out.raw,
        ...(built?.extra ?? {}),
      } : { error: failure },
      evidence: failure ?? (hit ? null : (out?.texts.get(recipe.finding) ?? out?.raw ?? null)),
      severity: SEVERITY.MAJOR,
      ms: out?.ms ?? null,
    });
    if (failure) {
      atlas.blind(`sabotage recipe for ${recipe.finding} (${recipe.note})`,
        `the recipe could not be built here: ${failure}`);
    }
  }

  // Findings that were named as having no recipe: recorded, never dropped.
  for (const n of NO_RECIPE) {
    atlas.record({
      id: `doctor.break.${n.finding}`,
      title: `${n.finding} under sabotage — no recipe exists`,
      verdict: VERDICT.NOT_MEASURED,
      expected: `${n.finding} can report something other than ok`,
      actual: 'not reachable through the surface this atlas measures (`mem doctor`)',
      measured: { why: n.why },
      evidence: n.why,
      severity: SEVERITY.MAJOR,
    });
    atlas.blind(`sabotage recipe for ${n.finding}`, n.why);
  }

  // A recipe for a finding the doctor no longer prints is itself a
  // finding: it means this phase is watching something that moved.
  const stale = RECIPES.map((r) => r.finding).filter((f) => !allFindings.has(f));
  if (stale.length) {
    atlas.record({
      id: 'doctor.recipes.stale',
      title: 'every sabotage recipe targets a finding the doctor actually prints',
      verdict: VERDICT.FAIL,
      expected: 'no recipe names a finding that is not in the output',
      actual: `${stale.length} stale: ${[...new Set(stale)].join(', ')}`,
      evidence: 'A recipe whose target disappeared tests nothing and reports nothing.',
      severity: SEVERITY.MAJOR,
    });
  }

  // --- the two numbers ------------------------------------------------

  const total = allFindings.size;
  const rows = [...ladder.entries()].sort(([a], [b]) => a.localeCompare(b));

  const neverMoved = rows
    .filter(([, r]) => ['empty', 'one', 'thousand', 'broken']
      .every((k) => r[k] === undefined || r[k] === 'good' || r[k] === 'absent'))
    .map(([n]) => n);
  const moved = total - neverMoved.length;

  const neverAlarmed = rows
    .filter(([, r]) => !['empty', 'one', 'thousand', 'broken']
      .some((k) => r[k] === 'warn' || r[k] === 'error'))
    .map(([n]) => n);
  const alarmed = total - neverAlarmed.length;

  const ladderTable = Object.fromEntries(rows);

  atlas.record({
    id: 'doctor.can-fail',
    title: 'how many findings ever showed a state other than ok',
    verdict: neverMoved.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'every finding changes state at least once',
    actual: `${moved} of ${total}`,
    measured: { ladder: ladderTable, neverMoved, rungs: ['empty', 'one', 'thousand', 'broken'] },
    evidence: neverMoved.length
      ? `never left ok across the whole ladder: ${neverMoved.join(', ')}\n\n`
        + 'A finding that cannot change state is a line that does nothing but promises '
        + 'something. Read this together with the not-measured records above: a finding '
        + 'with no recipe is counted here as "never moved", which is the honest reading — '
        + 'nobody has yet shown it can.'
      : null,
    severity: SEVERITY.CRITICAL,
  });

  atlas.record({
    id: 'doctor.can-alarm',
    title: 'how many findings ever reached WARN or FAIL',
    verdict: neverAlarmed.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'every finding can raise an alarm, not merely admit it did not look',
    actual: `${alarmed} of ${total}`,
    measured: { neverAlarmed },
    evidence: neverAlarmed.length
      ? `never reached warn or error: ${neverAlarmed.join(', ')}\n\n`
        + '`?` is the honest third state, not an alarm. A finding that only ever alternates '
        + 'between ok and ? never tells anybody to do anything.'
      : null,
    severity: SEVERITY.MAJOR,
  });

  // --- ok on an empty memory ------------------------------------------
  //
  // The invariant, applied to the doctor: which findings reported GOOD
  // on a memory that holds nothing? Their own text is the evidence —
  // "0 entries in 0 lines", "0 tracked facts, no conflicts".
  const emptyRun = rungs[0].run;
  const okOnEmpty = [...emptyRun.levels.entries()]
    .filter(([, l]) => l === 'good')
    .map(([n]) => n);
  const unknownOnEmpty = [...emptyRun.levels.entries()]
    .filter(([, l]) => l === 'unknown')
    .map(([n]) => n);

  // Which of those `ok`s are `ok` ABOUT NOTHING — the finding counted
  // zero of the thing it watches and called that health. Taken from the
  // finding's own text, not from a hand-kept list, so it cannot go stale
  // silently; the pattern is a leading zero count.
  const aboutNothing = (run) => [...run.levels.entries()]
    .filter(([n, l]) => l === 'good' && /(^|\s)(0|no|nothing|empty)\b/i.test(run.texts.get(n) ?? ''))
    .map(([n]) => n);
  const okAboutNothing = aboutNothing(emptyRun);
  const okAboutNothingVersioned = aboutNothing(emptyVersioned);

  atlas.record({
    id: 'doctor.ok-on-empty',
    title: 'findings that report ok on a memory that holds nothing',
    verdict: okAboutNothing.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'a check that measured nothing reports unknown, not ok '
      + '(shared/invariants.jsonl: leer-ist-kein-bestehen, "An instrument that checked nothing does not pass")',
    actual: `${okAboutNothing.length} of ${emptyRun.levels.size} findings report ok about nothing `
      + `(${okAboutNothingVersioned.length} once the empty memory is under git); `
      + `${unknownOnEmpty.length} use the third state`,
    measured: {
      okOnEmpty,
      okAboutNothing: Object.fromEntries(okAboutNothing.map((n) => [n, emptyRun.texts.get(n)])),
      unknownOnEmpty,
      // The same count on the versioned-but-empty root: the git-layer
      // findings that had the honesty to say `?` on a bare directory
      // go green there without anything having been measured either.
      okAboutNothingVersioned: Object.fromEntries(
        okAboutNothingVersioned.map((n) => [n, emptyVersioned.texts.get(n)])),
      // Every `ok` on the versioned-but-empty root, including the ones
      // whose text does not admit a zero — `append-only-git` says "4
      // append-only log(s) hold everything git already has" about four
      // files with no lines in them. The narrow count above is what can
      // be derived from the text; this list is what a reader should
      // look at beside it.
      okOnEmptyVersioned: [...emptyVersioned.levels.entries()]
        .filter(([, l]) => l === 'good').map(([n]) => n),
      raw: emptyRun.raw,
    },
    evidence: okAboutNothing.length
      ? okAboutNothing.map((n) => `ok  ${n}  ${emptyRun.texts.get(n)}`).join('\n')
      : null,
    severity: SEVERITY.MAJOR,
  });

  return {
    total,
    moved,
    alarmed,
    neverMoved,
    okAboutNothingOnEmpty: okAboutNothing,
    ladder: ladderTable,
  };
}
