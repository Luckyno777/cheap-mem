/**
 * doctor — is this memory healthy?
 *
 * **Every check measures an EFFECT, never a setting.** That rule was
 * learned the expensive way, three times in one deployment:
 *
 *   - The digest wrapper trusted the model call's exit code. A session
 *     that failed on permissions explains itself and exits 0. It
 *     reported "done" and had done nothing.
 *   - This file's git-hook check read `core.hooksPath` and said "ok"
 *     while the hook could not execute at all (a noexec mount). A
 *     planted test token was committed straight through.
 *   - A size cap read an env var that was passed as an argument, so it
 *     was undefined, so every file counted as zero bytes, so the cap
 *     never applied.
 *
 * All three looked healthy from the outside. So: run the hook, count
 * the captures, build the index. If a check cannot measure, it says
 * UNKNOWN — it does not guess.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as memory from './memory.mjs';
import * as raw from './raw.mjs';
import * as search from './search.mjs';
import * as redaction from './redaction.mjs';
import * as cfgmod from './config.mjs';

export const LEVEL = Object.freeze({
  GOOD: 'good',
  WARN: 'warn',
  ERROR: 'error',
  UNKNOWN: 'unknown',
});

/**
 * A finding. `advice` is mandatory for anything that is not good — a
 * complaint without a next step just makes people feel bad.
 */
function finding(name, level, text, advice = null) {
  if (level !== LEVEL.GOOD && !advice && level !== LEVEL.UNKNOWN) {
    // Caught by a test rather than thrown at runtime: a doctor that
    // crashes is worse than one that nags.
    return { name, level, text, advice: '(no advice — that is a bug in doctor.mjs)' };
  }
  return { name, level, text, advice };
}

function quietRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

export function checkAll(root) {
  const f = [];
  f.push(checkRoot(root));
  f.push(checkConfig(root));
  f.push(checkRedaction());
  f.push(checkGitHook(root));
  f.push(...checkDrawers(root));
  f.push(checkCaptures(root));
  f.push(checkDigest(root));
  f.push(checkDigestYield(root));
  f.push(checkFactConflicts(root));
  f.push(checkOrphans(root));
  f.push(checkIndex(root));
  f.push(checkStopHook(root));
  f.push(checkLegacyLeaks(root));
  f.push(checkBehind(root));
  f.push(checkGitState(root));

  // UNKNOWN ranks BELOW good. Some checks are permanently unmeasurable
  // where they run — a timer on the host is invisible from inside a
  // container. If that decided the verdict, a perfectly healthy memory
  // would report "unknown" forever, and people would learn to ignore
  // the output. Only warnings and errors lower the grade.
  const rank = { error: 3, warn: 2, good: 1, unknown: 0 };
  const worst = f.reduce((max, x) => (rank[x.level] > rank[max] ? x.level : max), LEVEL.GOOD);

  const count = { good: 0, warn: 0, error: 0, unknown: 0 };
  for (const x of f) count[x.level] += 1;
  return { findings: f, worst, summary: count };
}

// Digest yield: makes the silent loss measurable. The digest (lane 2)
// is the net under discipline — when I forget to log, IT should pull the
// decision/error out of the raw material. An unmeasured net is as good
// as none. So count: how many digested captures produced NO entry (no
// entry's origin.raw points at them)? A high ratio is the signal that
// the digest is dropping content.
function checkDigestYield(root) {
  const ratioThreshold = 0.4;
  let captures = [];
  try { captures = raw.listCaptures(root); } catch { /* no raw/ */ }
  // Without any record, which captures are digested is unknowable — same
  // boundary as checkDigest, and it narrows the same way: the ledger is
  // tracked, so where it exists the state is readable from any clone and
  // the yield is computable. Otherwise the ledger would have answered one
  // finding and left the one beside it at `?`, over the same data. With no
  // raw material at all there is provably nothing to measure (GOOD, below).
  const watermarkHere = fs.existsSync(path.join(root, raw.WATERMARK_FILE));
  const ledgerHere = fs.existsSync(path.join(root, raw.LEDGER_FILE));
  if (captures.length > 0 && !watermarkHere && !ledgerHere) {
    return finding('digest-yield', LEVEL.UNKNOWN,
      'no digest record in this clone — which captures are digested is not known from here',
      'Measure on the machine that digests, or digest once and commit there: '
      + `${raw.LEDGER_FILE} travels, ${raw.WATERMARK_FILE} is gitignored.`);
  }
  let open = new Set();
  try { open = new Set(raw.pending(root).open); } catch { /* no watermark */ }
  const digested = captures.filter((f) => !open.has(f));
  if (digested.length === 0) {
    return finding('digest-yield', LEVEL.GOOD, 'nothing digested yet — nothing to measure');
  }
  const referenced = new Set();
  let withOrigin = 0;
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      const { entries } = memory.readLog(root, type, { project });
      for (const e of entries) {
        const src = e && e.origin && e.origin.raw;
        if (src) { withOrigin += 1; referenced.add(src); }
      }
    }
  }
  const gaps = digested.filter((f) => !referenced.has(f));
  const ratio = gaps.length / digested.length;
  const core = `digest yield: ${withOrigin} entries from ${digested.length} digested `
    + `captures; ${gaps.length} produced nothing (${Math.round(ratio * 100)}%).`;
  if (digested.length >= 3 && ratio > ratioThreshold) {
    return finding('digest-yield', LEVEL.WARN, core,
      'Many digested captures produced no entry — the digest may be dropping '
      + `content (or it was just tool noise). Spot-check: ${gaps.slice(0, 2).join(', ')}`);
  }
  return finding('digest-yield', LEVEL.GOOD, core);
}

// Fact conflicts: two versions of the same living fact carry the SAME
// valid_from but disagree on the value. That is not a normal update (a new
// date superseding an old one) — it is a contradiction the memory cannot
// resolve on its own, and everyday recall would surface one or the other
// at random. Deterministic; reuses the freshness resolver.
export function checkFactConflicts(root) {
  let facts = [];
  try { facts = memory.currentFacts(root); }
  catch { return finding('fact-conflicts', LEVEL.UNKNOWN, 'could not resolve timeline facts'); }
  const clashes = facts.filter((f) => f.conflict);
  if (clashes.length === 0) {
    return finding('fact-conflicts', LEVEL.GOOD, `${facts.length} tracked facts, no conflicts`);
  }
  const keys = clashes.map((f) => f.key).slice(0, 5).join(', ');
  return finding('fact-conflicts', LEVEL.WARN,
    `${clashes.length} fact${clashes.length === 1 ? '' : 's'} have two versions with the same date but different values: ${keys}`,
    'Resolve each with a newer `mem log timeline --key <k> --value <correct> --valid_from <later date>`, '
    + 'or retire the wrong version with `mem discard <id>`.');
}

// Orphans: a correction or a duty-closing line that points at an id which
// does not exist in the corpus. The pointer resolves to nothing, so the
// supersede/close silently never takes effect. Deterministic.
export function checkOrphans(root) {
  const ids = new Set();
  const pointers = []; // { field, to }
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      let entries;
      try { ({ entries } = memory.readLog(root, type, { project })); } catch { continue; }
      for (const e of entries) {
        if (e.__broken || !e.id) continue;
        ids.add(e.id);
        if (e.replaces_id) pointers.push({ field: 'replaces_id', to: e.replaces_id });
        if (e.closes_id) pointers.push({ field: 'closes_id', to: e.closes_id });
        // A link is two pointers. An edge into nothing is exactly the same
        // defect as an orphaned correction: it resolves to no entry, so it
        // silently does nothing — and a graph is only worth walking if its
        // edges are known to land.
        if (type === 'link') {
          const from = e.from ?? e.source ?? null;
          const to = e.to ?? e.target ?? null;
          if (from) pointers.push({ field: 'link.from', to: from });
          if (to) pointers.push({ field: 'link.to', to: to });
        }
      }
    }
  }
  const orphans = pointers.filter((p) => !ids.has(p.to));
  if (orphans.length === 0) {
    return finding('orphans', LEVEL.GOOD, `${pointers.length} correction/close links, all resolve`);
  }
  const sample = orphans.slice(0, 3).map((o) => `${o.field}->${o.to}`).join(', ');
  const one = orphans.length === 1;
  return finding('orphans', LEVEL.WARN,
    `${orphans.length} pointer${one ? '' : 's'} (correction, close or link edge) `
    + `${one ? 'points' : 'point'} at a missing id: ${sample}`,
    'The target was never written or the id is mistyped, so the supersede/close does not take effect. '
    + 'Check the id, or write the correction against the real entry.');
}

function checkRoot(root) {
  if (!fs.existsSync(root)) {
    return finding('root', LEVEL.ERROR, `${root} does not exist`,
      'Point --root at a memory, or run `mem init` there.');
  }
  return finding('root', LEVEL.GOOD, root);
}

function checkConfig(root) {
  try {
    const cfg = cfgmod.readConfig(root);
    const who = Object.keys(cfg.participants ?? {}).length;
    return finding('config', LEVEL.GOOD,
      `${who} participants, language ${cfg.language ?? 'en'}, branch ${cfg.defaultBranch}`);
  } catch (e) {
    return finding('config', LEVEL.ERROR, e.message, 'Run `mem init` in the memory root.');
  }
}

function checkRedaction() {
  const t = redaction.selfTest();
  if (t.ok) return finding('redaction', LEVEL.GOOD, `intact, ${t.checked} canaries`);
  return finding('redaction', LEVEL.ERROR,
    `FAILING: ${t.failed.map((a) => `${a.type}:${a.reason}`).join(', ')}`,
    'Capture refuses to run while this is broken — on purpose. '
    + 'A gap in the memory beats a secret in the version history.');
}

/**
 * The git hook, checked by STARTING it.
 *
 * Reading `core.hooksPath` proves nothing. On a mount with `noexec`
 * the file is 0755, the config is right, and git still cannot run it —
 * it prints "hook was ignored because it's not set as executable" and
 * commits anyway.
 */
function checkGitHook(root) {
  const set = quietRun('git', ['-C', root, 'config', '--get', 'core.hooksPath']);
  if (!set || !set.trim()) {
    return finding('git-hook', LEVEL.WARN, 'core.hooksPath is not set',
      'mem hooks install — it also proves the hook actually fires.');
  }

  // Start the hook git would start, not the file in the repo. On a
  // noexec mount those are two different things.
  const p = set.trim();
  const hookPath = path.isAbsolute(p) ? path.join(p, 'pre-commit') : path.join(root, p, 'pre-commit');
  if (!fs.existsSync(hookPath)) {
    return finding('git-hook', LEVEL.ERROR, `core.hooksPath=${p}, but ${hookPath} is missing`,
      'mem hooks install');
  }
  // On Windows git runs hooks through its bundled bash, so that is
  // what has to be probed; starting the file itself would always fail
  // and report a broken hook that works perfectly.
  let attempt;
  try {
    attempt = process.platform === 'win32'
      ? spawnSync('bash', [hookPath], { encoding: 'utf8', timeout: 10000 })
      : spawnSync(hookPath, [], { encoding: 'utf8', timeout: 10000 });
  } catch (e) { attempt = { error: e }; }
  if (attempt.error) {
    const reason = attempt.error.code === 'EACCES'
      ? 'execve refused (noexec mount? container volume?)'
      : `could not start: ${attempt.error.message}`;
    return finding('git-hook', LEVEL.ERROR,
      `core.hooksPath=${p}, but the hook does not run — ${reason}`,
      'mem hooks install — it detects this and puts the hook somewhere '
      + 'executable, then proves the result with a decoy secret.');
  }
  return finding('git-hook', LEVEL.GOOD, `core.hooksPath=${p}, hook starts (exit ${attempt.status})`);
}

function* checkDrawers(root) {
  let found = 0;
  let lines = 0;
  let broken = 0;
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      const p = memory.logPath(root, type, project);
      if (!fs.existsSync(p)) continue;
      found += 1;
      for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        lines += 1;
        try { JSON.parse(l); } catch { broken += 1; }
      }
    }
  }
  if (found === 0) {
    yield finding('drawers', LEVEL.WARN, 'no log files yet',
      'Fine for a fresh memory. Otherwise check that `mem log` writes where you expect.');
    return;
  }
  if (broken > 0) {
    yield finding('drawers', LEVEL.ERROR, `${broken} unparsable lines in ${found} files`,
      'A JSONL line that is not JSON was hand-edited or half-written. '
      + 'Find it with: grep -n . <file> | while read -r l; do ... ; done');
    return;
  }
  yield finding('drawers', LEVEL.GOOD, `${found} files, ${lines} lines`);
}

function checkCaptures(root) {
  const list = raw.listCaptures(root);
  if (list.length === 0) {
    return finding('capture', LEVEL.WARN, 'no captures at all',
      'Is the Stop hook wired up? See the "stop-hook" finding below.');
  }
  let bytes = 0;
  for (const c of list) {
    try { bytes += fs.statSync(path.join(root, c)).size; } catch { /* gone */ }
  }
  // Did the redaction actually catch anything lately? A capture run
  // with a dead redaction looks exactly like a clean one.
  let withRedactions = 0;
  const recent = list.slice(-5);
  for (const c of recent) {
    try {
      const { header } = raw.readCapture(root, c);
      if ((header?.__redacted ?? []).length > 0) withRedactions += 1;
    } catch { /* a broken capture is reported elsewhere */ }
  }
  return finding('capture', LEVEL.GOOD,
    `${list.length} captures, ${Math.round(bytes / 1024)} KB, `
    + `${withRedactions} of the last ${recent.length} carry redactions`);
}

function checkDigest(root) {
  // Without the watermark, this check cannot judge the digest state — and
  // the watermark (.mem/, gitignored) does not travel with the repo. Every
  // checked-in capture then looks pending. A clone that captures locally
  // even writes its own bell, so "bell present" cannot separate a real
  // backlog from git-imported captures: that exact confusion once made a
  // cloud session report "87 pending, 19.8 MB, 41 h" while the digesting
  // machine was healthy with 3 truly-open captures. So: no watermark ->
  // `?`, never a fabricated count. With no raw material at all there is
  // provably nothing pending (handled after the guard).
  // The ledger is tracked, so when it exists the digest state IS knowable
  // from any clone — that is the whole point of it, and the `?` below
  // narrows to the case where neither record is present.
  const ledgerHere = fs.existsSync(path.join(root, raw.LEDGER_FILE));
  const watermarkHere = fs.existsSync(path.join(root, raw.WATERMARK_FILE));
  if (!watermarkHere && !ledgerHere) {
    let count = 0;
    try { count = raw.listCaptures(root).length; } catch { /* no raw/ */ }
    if (count === 0) {
      return finding('digest', LEVEL.GOOD, 'nothing pending');
    }
    const bell = raw.bellState(root);
    return finding('digest', LEVEL.UNKNOWN,
      bell
        ? `no watermark in this clone — it captures here (bell is set), but which of the ${count} `
          + 'checked-in captures are already digested is not judgeable from here'
        : `no digest state on this machine — the ${count} captures came in via git, nothing is `
          + 'captured or digested here',
      'Neither ' + raw.LEDGER_FILE + ' (tracked) nor ' + raw.WATERMARK_FILE
      + ' (gitignored, .mem/) is here. The ledger travels with the repo, so once the '
      + 'digest has run once and committed, this question is answerable from any clone. '
      + 'Until then the watermark does not travel with '
      + 'the repo. Without it every checked-in capture looks pending, even long-digested ones — '
      + 'neither the count nor the age of a backlog can be derived. Measure on the digesting '
      + 'machine: mem raw due.');
  }
  const st = raw.pending(root);
  if (st.open.length === 0) {
    return finding('digest', LEVEL.GOOD,
      st.last ? `nothing pending, last run ${st.last}` : 'nothing pending');
  }
  const d = raw.due(root);
  const kb = Math.round(st.bytes / 1024);
  if (d.due) {
    return finding('digest', LEVEL.WARN,
      `${st.open.length} pending (${kb} KB), due since ${d.reason}`,
      'The timer should pick this up within minutes. If it does not, '
      + 'check that the digest job is installed and running.');
  }
  return finding('digest', LEVEL.GOOD,
    `${st.open.length} pending (${kb} KB), not due yet (${d.reason})`);
}

function checkIndex(root) {
  try {
    const cfg = (() => { try { return cfgmod.readConfig(root); } catch { return { language: 'en' }; } })();
    const t0 = Date.now();
    const idx = search.loadIndex(root, { language: cfg.language });
    const ms = Date.now() - t0;
    if (idx.N === 0) {
      return finding('index', LEVEL.WARN, 'empty index — nothing to search',
        'Normal for a fresh memory. Otherwise check that the drawers are really filled.');
    }
    return finding('index', LEVEL.GOOD,
      `${idx.N} documents, ${idx.docFreq.size} terms, ${idx.tagGraph.size} tags in the graph, `
      + `${ms}ms${idx.fromCache ? ' (cached)' : ' (fresh build)'}`);
  } catch (e) {
    return finding('index', LEVEL.ERROR, e.message, '`mem find --fresh` forces a rebuild.');
  }
}

function checkStopHook(root) {
  const candidates = [
    path.join(process.env.HOME ?? '', '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
  ];
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const asText = JSON.stringify(cfg.hooks?.Stop ?? []);
    if (asText.includes('mem-capture')) {
      return finding('stop-hook', LEVEL.GOOD, `mem-capture is wired up (${p})`);
    }
    if (asText.includes('mem-reflect')) {
      return finding('stop-hook', LEVEL.WARN, `still the old reflector (${p})`,
        'Switch to bin/mem-capture — it starts no model.');
    }
  }
  return finding('stop-hook', LEVEL.UNKNOWN,
    'no Stop hook found in the settings files I know about',
    'Without it nothing is captured. See docs/capture.md.');
}

function checkGitState(root) {
  const branch = quietRun('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return finding('git', LEVEL.UNKNOWN, 'not a git clone (or git missing)');
  const dirty = quietRun('git', ['-C', root, 'status', '--porcelain']);
  const lines = dirty ? dirty.split('\n').filter(Boolean) : [];
  if (lines.length === 0) return finding('git', LEVEL.GOOD, `${branch.trim()}, clean`);

  // Uncommitted MEMORY is the visible end of a silent failure. The Stop
  // hook and the digest both commit best-effort and swallow what goes
  // wrong — two sessions sharing a clone collide on git's index lock,
  // one of them writes its capture and never commits it, and the hook
  // still reports success. In an environment that gets reclaimed, that
  // capture is simply gone.
  //
  // This check used to report GOOD no matter how much was uncommitted,
  // which made the one place that could have surfaced the loss stay
  // quiet about it. Content is now a warning; a dirty working copy of
  // the tooling is not.
  const CONTENT = /^..\s+(raw\/|global\/|projects\/|inbox\/|digested\.jsonl|FACTS\.md)/;
  const content = lines.filter((l) => CONTENT.test(l));
  if (content.length === 0) {
    return finding('git', LEVEL.GOOD,
      `${branch.trim()}, ${lines.length} uncommitted (none of them memory)`);
  }
  return finding('git', LEVEL.WARN,
    `${branch.trim()}, ${content.length} uncommitted memory files`,
    'Memory that is not committed does not travel and does not survive a '
    + 'rebuilt container. Commit and push them: git add -A && git commit && git push. '
    + `First: ${content.slice(0, 2).map((l) => l.slice(3)).join(', ')}`);
}

/** Findings as text. `problemsOnly` hides what is fine. */
export function report({ findings, worst, summary }, { problemsOnly = false } = {}) {
  const mark = { good: 'ok  ', warn: 'WARN', error: 'FAIL', unknown: '?   ' };
  const lines = [];
  for (const b of findings) {
    if (problemsOnly && b.level === LEVEL.GOOD) continue;
    lines.push(`${mark[b.level]}  ${b.name.padEnd(12)} ${b.text}`);
    if (b.advice) lines.push(`      ${' '.repeat(12)} -> ${b.advice}`);
  }
  lines.push('');
  lines.push(`${summary.good} good, ${summary.warn} warnings, ${summary.error} errors, `
    + `${summary.unknown} unchecked  —  overall: ${worst}`
    + (worst === LEVEL.GOOD && summary.unknown
      ? ` (${summary.unknown} not checkable from here)` : ''));
  return lines.join('\n');
}

/**
 * Do already-captured files contain secrets that TODAY's rules would
 * catch?
 *
 * The redaction only protects what was captured after it. Every gap
 * closed later leaves material behind that was written under weaker
 * rules — and nobody looks again.
 *
 * That is not hypothetical: in the private ancestor, a capture made at
 * 05:52 held three dashboard tokens in URLs; the gap was closed at
 * 06:37, and the values stayed in the repository. It surfaced only
 * because a human grepped by hand.
 *
 * **The finding never names a value.** Only kind and count.
 */
function checkLegacyLeaks(root) {
  let captures;
  try { captures = raw.listCaptures(root); }
  catch { return finding('legacy', LEVEL.UNKNOWN, 'raw material unreadable'); }
  if (captures.length === 0) return finding('legacy', LEVEL.GOOD, 'no raw material');

  const CAP = 8 * 1024 * 1024;
  let read = 0;
  let truncated = false;
  const hits = new Map();

  for (const rel of captures) {
    if (read >= CAP) { truncated = true; break; }
    let lines;
    try { ({ lines } = raw.readCapture(root, rel)); }
    catch { continue; }
    for (const l of lines) {
      const text = JSON.stringify(l);
      read += text.length;
      if (read >= CAP) { truncated = true; break; }
      for (const f of redaction.redact(text).found) {
        hits.set(f.type, (hits.get(f.type) ?? 0) + f.count);
      }
    }
  }

  const total = [...hits.values()].reduce((a, b) => a + b, 0);
  if (total === 0) {
    return finding('legacy', LEVEL.GOOD,
      `${captures.length} captures checked${truncated ? ' (cap reached)' : ''}, nothing found`);
  }
  const kinds = [...hits].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} x${n}`).join(', ');
  return finding('legacy', LEVEL.ERROR,
    `${total} spots in old raw material that today's rules would catch: ${kinds}`,
    'These values were written under weaker rules and sit unredacted in the repository. '
    + 'Rotate the affected keys — cheaper and safer than rewriting git history. '
    + 'Locations without values: mem raw check');
}

/**
 * Is this clone behind origin?
 *
 * **Pushed is not fixed.** Capture loads src/redaction.mjs from THIS
 * clone and never pulls by itself. A security fix sitting on main takes
 * effect here only after a pull — and in between, the machine keeps
 * capturing with the old rules.
 *
 * Uses only `git rev-list` against the already-fetched origin: no
 * network, so doctor does not hang offline.
 */
function checkBehind(root) {
  const branch = quietRun('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return finding('behind', LEVEL.UNKNOWN, 'git not runnable');
  const b = branch.trim();
  const count = quietRun('git', ['-C', root, 'rev-list', '--count', `HEAD..origin/${b}`]);
  if (count === null) {
    return finding('behind', LEVEL.UNKNOWN, `no origin/${b} known — never fetched?`,
      `git -C ${root} fetch origin ${b}`);
  }
  const n = Number(count.trim());
  if (!Number.isFinite(n)) return finding('behind', LEVEL.UNKNOWN, 'count unreadable');
  if (n === 0) return finding('behind', LEVEL.GOOD, `up to date with origin/${b}`);
  return finding('behind', LEVEL.WARN, `${n} commits behind origin/${b}`,
    'Capture uses the redaction from THIS clone. While it lags, it captures with '
    + `old rules: git -C ${root} pull`);
}
