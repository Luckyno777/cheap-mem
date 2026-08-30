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
  f.push(checkIndex(root));
  f.push(checkStopHook(root));
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
  let attempt;
  try { attempt = spawnSync(hookPath, [], { encoding: 'utf8', timeout: 10000 }); }
  catch (e) { attempt = { error: e }; }
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
  const n = dirty ? dirty.split('\n').filter(Boolean).length : 0;
  return finding('git', LEVEL.GOOD, `${branch.trim()}${n ? `, ${n} uncommitted changes` : ', clean'}`);
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
