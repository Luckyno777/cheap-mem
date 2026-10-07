#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/gold-compare.mjs — run the fixed retrieval gold set against one
// code state, or against TWO code states side by side (X5 + O5,
// BAUPLAN-mem-admin_02.md).
//
//     node bench/gold-compare.mjs                       # this checkout only
//     node bench/gold-compare.mjs --base origin/main    # origin/main vs this checkout
//     node bench/gold-compare.mjs --base A --head B     # two git refs
//     node bench/gold-compare.mjs --json                # machine-readable
//     node bench/gold-compare.mjs --gate                # exit 1 on worse, 2 on unknown
//
// **Why this exists next to bench/retrieval.mjs and `atlas --compare`.**
// retrieval.mjs measures ONE code state; `atlas --compare` diffs against a
// JSON file saved earlier, on whatever corpus was current then. Neither
// can answer the question a ranking change actually raises: "on the SAME
// data, is the new code better or worse than the old code, and where?".
// This is the port of lucky-mem's `bin/mem-gold-pruefen.mjs --vergleich`:
// each ref is checked out as a detached git worktree (never `git stash`),
// and both run against one world built once and copied byte for byte.
//
// **What is measured.** The gold set (bench/gold/cases.jsonl) runs over a
// synthetic demo world (bench/gold/world.jsonl) — an invented team with
// two invented projects, never anybody's real memory. Each case names
// `expected` ids (at least one must be in the top k) and `forbidden` ids
// (none may be in the top k). Six categories: lexical, paraphrase, scope
// (project A must not answer with project B), temporal (a superseded
// entry must not stand in front of the one that holds; `--as-of`),
// status (withdrawn rule, done duty, discarded decision) and
// cross-language (both directions).
//
// **Through the CLI, on purpose.** Each case is one `bin/mem find --json`
// process of the code state under test. That is the path a person or an
// agent actually takes, and it keeps this runner independent of either
// state's internal module layout: an old ref whose `find` does not know a
// flag (say `--as-of`) exits non-zero, and that case is reported as
// UNKNOWN for that ref — never as a pass, never as a fail. A ref whose
// CLI does not start at all makes every case unknown.
//
// **Verdict per category**: better / worse / same / unknown.
//   unknown  at least one case of the category is unknown on either side
//   worse    at least one case went from pass to fail — even if another
//            one improved at the same time; a regression must not be
//            netted away by an unrelated gain
//   better   no regression and at least one case went from fail to pass
//   same     nothing moved
//
// It writes nothing into any real memory. The world lives in a temp dir
// and is removed at the end; worktrees this run created are removed too
// (`--keep` leaves them, and says where).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.join(HERE, '..');
export const CASES_FILE = path.join(HERE, 'gold', 'cases.jsonl');
export const WORLD_FILE = path.join(HERE, 'gold', 'world.jsonl');
export const CATEGORIES = Object.freeze(['lexical', 'paraphrase', 'scope', 'temporal', 'status', 'cross-language']);
export const DEFAULT_K = 3;

// --- Loading -----------------------------------------------------------

function readJsonl(file) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch (e) {
      throw new Error(`${file}:${i + 1}: not JSON (${e.message})`);
    }
  });
  return out;
}

/**
 * The cases, with their KNOWN GAPS attached.
 *
 * A known gap is a case that fails on purpose: the situation it
 * describes has no ranking rule by design, and is addressed somewhere
 * else (G1b: time-08, an unlinked newer decision without topic — word
 * overlap cannot tell which of two rulings holds; the write path shows
 * the writer the similar decision instead). Such a case stays in the set
 * UNCHANGED — it still runs, and the day it passes is visible — but it is
 * reported on its own line, not netted into its category: a category
 * that is permanently one short hides every real regression behind "it
 * was already red".
 *
 * The marking is its own appended line (`{"gap_of": <id>, "gap": <why>}`),
 * not an edit of the case line: *.jsonl here is append-only too.
 */
export function loadCases(file = CASES_FILE) {
  const rows = readJsonl(file);
  const gaps = new Map(rows.filter((r) => r && r.gap_of).map((r) => [r.gap_of, r.gap]));
  const cases = rows.filter((r) => !(r && r.gap_of));
  for (const c of cases) if (c && gaps.has(c.id)) c.gap = gaps.get(c.id);
  // A gap marker for a case that does not exist is a defect of the set —
  // carried so `checkSet` can name it instead of silently dropping it.
  const known = new Set(cases.map((c) => c?.id));
  cases.orphanGaps = [...gaps.keys()].filter((id) => !known.has(id));
  return cases;
}

/** `{ config, entries }` — the first line with a `config` key is the
 * memory's config, every other line is one entry to write. */
export function loadWorld(file = WORLD_FILE) {
  const rows = readJsonl(file);
  const head = rows.find((r) => r && r.config);
  return { config: head?.config ?? null, entries: rows.filter((r) => r && !r.config) };
}

/**
 * Form check of the gold set against its world — the guard against dead
 * ids. Returns a list of problems (empty = sound). A case pointing at an
 * id the world does not hold would pass or fail for a reason that has
 * nothing to do with ranking, so it is a defect of the set, not a result.
 */
export function checkSet(cases, world) {
  const problems = [];
  const ids = new Set(world.entries.map((e) => e?.data?.id).filter(Boolean));
  const seen = new Set();
  for (const id of cases.orphanGaps ?? []) problems.push(`gap marker for '${id}': no such case`);
  for (const c of cases) {
    const where = `case ${c?.id ?? '?'}`;
    if (!c || typeof c.id !== 'string' || !c.id) { problems.push(`${where}: id missing`); continue; }
    if (seen.has(c.id)) problems.push(`${where}: duplicate id`);
    seen.add(c.id);
    if (!CATEGORIES.includes(c.category)) problems.push(`${where}: unknown category ${JSON.stringify(c.category)}`);
    if (typeof c.query !== 'string' || !c.query.trim()) problems.push(`${where}: query missing`);
    if (!Array.isArray(c.expected) || c.expected.length === 0) problems.push(`${where}: needs at least one expected id`);
    if (!Array.isArray(c.forbidden)) problems.push(`${where}: forbidden must be a list (may be empty)`);
    for (const id of [...(c.expected ?? []), ...(c.forbidden ?? [])]) {
      if (!ids.has(id)) problems.push(`${where}: id '${id}' does not exist in the world`);
    }
    for (const id of c.expected ?? []) {
      if ((c.forbidden ?? []).includes(id)) problems.push(`${where}: '${id}' is both expected and forbidden`);
    }
    if (c.k !== undefined && !(Number.isInteger(c.k) && c.k >= 1)) problems.push(`${where}: k must be a positive integer`);
    if (c.gap !== undefined && !(typeof c.gap === 'string' && c.gap.trim())) problems.push(`${where}: gap needs a reason`);
  }
  return problems;
}

// --- The world ---------------------------------------------------------

/**
 * Materialise the world with THIS checkout's writer, into a fresh temp
 * dir. Built once per run; each side gets a byte-identical copy (see
 * {@link copyWorld}) so an index cache written by one code state can
 * never be read by the other.
 */
export async function buildWorld(world = loadWorld(), { codeDir = REPO } = {}) {
  const memory = await import(pathToFileURL(path.join(codeDir, 'src', 'memory.mjs')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-gold-world-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify(world.config ?? {}));
  for (const row of world.entries) {
    if (row.project) memory.projectInit(root, row.project); // idempotent; logEntry refuses an unknown project
    memory.logEntry(root, row.type, row.data, { project: row.project ?? null, now: new Date(row.at) });
  }
  return root;
}

export function copyWorld(root) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-gold-side-'));
  fs.cpSync(root, copy, { recursive: true });
  return copy;
}

// --- Code states -------------------------------------------------------

/** A detached worktree for `ref` under the temp dir. Reused when one for
 * the same commit already exists. `created` says whether this call made
 * it (only those are removed again). */
export function worktreeFor(ref, { repo = REPO } = {}) {
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
  const dir = path.join(os.tmpdir(), `cheap-mem-gold-ref-${sha.slice(0, 12)}`);
  let created = false;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    execFileSync('git', ['worktree', 'add', '--detach', dir, sha], { cwd: repo, stdio: 'ignore' });
    created = true;
  }
  return { dir, sha, created };
}

export function removeWorktree(dir, { repo = REPO } = {}) {
  try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo, stdio: 'ignore' }); } catch { /* left for a human */ }
}

// --- Running one side --------------------------------------------------

/**
 * One case against one code state: the ids of the top k, or
 * `{ unknown: reason }` when that code state could not answer.
 */
export function askOne(codeDir, root, c, { k = DEFAULT_K, home = null } = {}) {
  const top = c.k ?? k;
  const args = [path.join(codeDir, 'bin', 'mem'), '--root', root, 'find', c.query, '--json', '--top', String(top)];
  if (c.project) args.push('--project', c.project);
  if (c.asOf) args.push('--as-of', c.asOf);
  const env = { ...process.env };
  delete env.CHEAP_MEM_ROOT;
  if (home) env.HOME = home;
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  if (r.error) return { unknown: `did not run: ${r.error.message}` };
  if (r.status !== 0) {
    const why = String(r.stderr || r.stdout || '').trim().split('\n')[0].slice(0, 160);
    return { unknown: `exit ${r.status}${why ? `: ${why}` : ''}` };
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return { unknown: 'output is not JSON' }; }
  if (!parsed || !Array.isArray(parsed.hits)) return { unknown: 'output has no hits list' };
  return { ids: parsed.hits.slice(0, top).map((h) => h?.entry?.id ?? null) };
}

/** Judge one answer. `pass` needs an expected id in the top k AND no
 * forbidden id there. */
export function judge(c, answer) {
  if (!answer || answer.unknown !== undefined) {
    return { id: c.id, category: c.category, state: 'unknown', why: answer?.unknown ?? 'no answer', ...(c.gap ? { gap: c.gap } : {}) };
  }
  const ids = answer.ids;
  const rank = ids.findIndex((id) => c.expected.includes(id));
  const leaked = (c.forbidden ?? []).filter((id) => ids.includes(id));
  const found = rank >= 0;
  const pass = found && leaked.length === 0;
  return {
    id: c.id, category: c.category, state: pass ? 'pass' : 'fail',
    rank: found ? rank + 1 : null, leaked, top: ids,
    ...(c.gap ? { gap: c.gap } : {}),
  };
}

/** Every case against one code state. `ask` is injectable so the probe
 * can put a deliberately broken ranker in without a real code state. */
export function runSide(codeDir, root, cases, { k = DEFAULT_K, ask = askOne } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-gold-home-'));
  try {
    return cases.map((c) => judge(c, ask(codeDir, root, c, { k, home })));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Summaries ---------------------------------------------------------

export function summarise(results) {
  const by = {};
  for (const cat of CATEGORIES) by[cat] = { n: 0, pass: 0, fail: 0, unknown: 0 };
  const total = { n: 0, pass: 0, fail: 0, unknown: 0 };
  const gaps = { n: 0, pass: 0, fail: 0, unknown: 0 };
  for (const r of results) {
    // A known gap counts in neither its category nor the total.
    if (r.gap) { gaps.n += 1; gaps[r.state] += 1; continue; }
    const b = by[r.category] ?? (by[r.category] = { n: 0, pass: 0, fail: 0, unknown: 0 });
    for (const t of [b, total]) { t.n += 1; t[r.state] += 1; }
  }
  return { byCategory: by, total, gaps };
}

/**
 * Compare two sides case by case, then per category. See the file
 * header for the four verdicts and why a regression is never netted away.
 */
export function compareSides(base, head) {
  const headById = new Map(head.map((r) => [r.id, r]));
  const flips = [];
  const cat = {};
  const bump = (c) => (cat[c] ?? (cat[c] = { improved: 0, regressed: 0, unknown: 0, n: 0 }));
  const gapFlips = [];
  for (const b of base) {
    const h = headById.get(b.id);
    // Known gaps stay out of the verdict; a flip is still reported.
    if (b.gap || h?.gap) {
      if (h && b.state !== h.state) gapFlips.push({ id: b.id, category: b.category, from: b.state, to: h.state });
      continue;
    }
    const slot = bump(b.category);
    slot.n += 1;
    if (!h || b.state === 'unknown' || h.state === 'unknown') { slot.unknown += 1; continue; }
    if (b.state === 'pass' && h.state === 'fail') { slot.regressed += 1; flips.push({ id: b.id, category: b.category, from: 'pass', to: 'fail' }); }
    if (b.state === 'fail' && h.state === 'pass') { slot.improved += 1; flips.push({ id: b.id, category: b.category, from: 'fail', to: 'pass' }); }
  }
  const verdict = (s) => {
    if (!s || s.n === 0) return 'unknown';
    if (s.unknown > 0) return 'unknown';
    if (s.regressed > 0) return 'worse';
    if (s.improved > 0) return 'better';
    return 'same';
  };
  const byCategory = {};
  for (const c of new Set([...CATEGORIES, ...Object.keys(cat)])) byCategory[c] = verdict(cat[c]);
  const all = Object.values(cat).reduce((a, s) => ({
    n: a.n + s.n, improved: a.improved + s.improved, regressed: a.regressed + s.regressed, unknown: a.unknown + s.unknown,
  }), { n: 0, improved: 0, regressed: 0, unknown: 0 });
  return { byCategory, overall: verdict(all), flips, gapFlips };
}

// --- Report ------------------------------------------------------------

function tableFor(title, results) {
  const s = summarise(results);
  const rows = [`--- ${title} ---`, 'category          pass  fail  unknown     n'];
  for (const [c, b] of [...Object.entries(s.byCategory), ['TOTAL', s.total]]) {
    rows.push(`${c.padEnd(16)} ${String(b.pass).padStart(5)} ${String(b.fail).padStart(5)} ${String(b.unknown).padStart(8)} ${String(b.n).padStart(5)}`);
  }
  const g = results.filter((r) => r.gap);
  if (g.length) {
    rows.push(`${'known gaps'.padEnd(16)} ${String(s.gaps.pass).padStart(5)} ${String(s.gaps.fail).padStart(5)} ${String(s.gaps.unknown).padStart(8)} ${String(s.gaps.n).padStart(5)}   (not counted above)`);
    for (const r of g) rows.push(`  ${r.id} (${r.category}) ${r.state}: ${r.gap}`);
  }
  const bad = results.filter((r) => r.state !== 'pass' && !r.gap);
  if (bad.length) {
    rows.push('not passing:');
    for (const r of bad) {
      rows.push(r.state === 'unknown'
        ? `  ${r.id} unknown: ${r.why}`
        : `  ${r.id} ${r.rank ? `expected at rank ${r.rank}` : 'expected not in top k'}`
          + `${r.leaked.length ? `, forbidden in top k: ${r.leaked.join(', ')}` : ''} [top: ${r.top.join(', ')}]`);
    }
  }
  return rows.join('\n');
}

function parseArgs(argv) {
  const o = { base: null, head: null, k: DEFAULT_K, json: false, gate: false, keep: false, cases: CASES_FILE, world: WORLD_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--head') o.head = argv[++i];
    else if (a === '--k') o.k = Number(argv[++i]);
    else if (a === '--cases') o.cases = argv[++i];
    else if (a === '--world') o.world = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--gate') o.gate = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('node bench/gold-compare.mjs [--base <ref>] [--head <ref>] [--k 3] [--json] [--gate] [--keep]');
    return;
  }
  const cases = loadCases(o.cases);
  const world = loadWorld(o.world);
  const problems = checkSet(cases, world);
  if (problems.length) {
    console.error(`gold set is not sound (${problems.length}):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 2;
    return;
  }
  const made = [];
  const side = (ref) => {
    if (!ref) return { label: 'working tree', dir: REPO, sha: null };
    try {
      const w = worktreeFor(ref);
      if (w.created) made.push(w.dir);
      return { label: ref, dir: w.dir, sha: w.sha };
    } catch (e) {
      return { label: ref, dir: null, sha: null, error: `ref does not resolve: ${e.message.split('\n')[0]}` };
    }
  };
  const root = await buildWorld(world);
  const run = (s) => {
    if (!s.dir) return cases.map((c) => judge(c, { unknown: s.error }));
    const copy = copyWorld(root);
    try { return runSide(s.dir, copy, cases, { k: o.k }); } finally { fs.rmSync(copy, { recursive: true, force: true }); }
  };
  try {
    const headSide = side(o.head);
    const baseSide = o.base ? side(o.base) : null;
    const headRes = run(headSide);
    const baseRes = baseSide ? run(baseSide) : null;
    const cmp = baseRes ? compareSides(baseRes, headRes) : null;
    if (o.json) {
      console.log(JSON.stringify({
        k: o.k, cases: cases.length,
        head: { ref: headSide.label, sha: headSide.sha, summary: summarise(headRes), results: headRes },
        base: baseSide ? { ref: baseSide.label, sha: baseSide.sha, summary: summarise(baseRes), results: baseRes } : null,
        compare: cmp,
      }, null, 2));
    } else {
      console.log(`${cases.length} gold cases, top ${o.k}, world ${path.relative(REPO, o.world)}`);
      if (baseRes) { console.log(''); console.log(tableFor(`base: ${baseSide.label}${baseSide.sha ? ` (${baseSide.sha.slice(0, 12)})` : ''}`, baseRes)); }
      console.log('');
      console.log(tableFor(`head: ${headSide.label}${headSide.sha ? ` (${headSide.sha.slice(0, 12)})` : ''}`, headRes));
      if (cmp) {
        console.log('');
        console.log('--- head against base ---');
        for (const [c, v] of Object.entries(cmp.byCategory)) console.log(`${c.padEnd(16)} ${v}`);
        console.log(`${'OVERALL'.padEnd(16)} ${cmp.overall}`);
        for (const f of cmp.flips) console.log(`  ${f.id} (${f.category}): ${f.from} -> ${f.to}`);
        for (const f of cmp.gapFlips) console.log(`  ${f.id} (known gap, ${f.category}): ${f.from} -> ${f.to}`);
      }
      if (o.keep && made.length) console.log(`\nworktrees kept: ${made.join(', ')}`);
    }
    if (o.gate && cmp) {
      const verdicts = Object.values(cmp.byCategory);
      // eslint-disable-next-line require-atomic-updates -- only this function sets the exit code; nothing interleaves
      if (verdicts.includes('worse')) process.exitCode = 1;
      // eslint-disable-next-line require-atomic-updates -- only this function sets the exit code; nothing interleaves
      else if (verdicts.includes('unknown')) process.exitCode = 2;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (!o.keep) for (const d of made) removeWorktree(d);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e?.stack || e); process.exitCode = 2; });
}
