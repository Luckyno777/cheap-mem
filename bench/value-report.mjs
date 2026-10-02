#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * bench/value-report.mjs — the numbers a user recognises as a benefit.
 *
 * **What it is.** One command that measures what cheap-mem gives you, at
 * several memory sizes, and writes it as plain sentences, a table per
 * category, the method, and a link to the raw data:
 *
 *   node bench/value-report.mjs                     # 10k and 100k notes
 *   node bench/value-report.mjs --sizes 1000000     # one size (VM run)
 *   node bench/value-report.mjs --mutation          # also the mutation score
 *   node bench/value-report.mjs --mutation-only     # just the mutation score, keep the rest
 *   node bench/value-report.mjs --render-only       # re-render from the raw JSON
 *   node bench/value-report.mjs --readme            # refresh the README block
 *
 * **The rule it enforces on itself.** Every number in the report is (a)
 * one plain-language sentence, (b) a method, (c) a link to the raw data,
 * (d) generated here, never typed. `buildMetrics()` takes ONLY the raw
 * JSON; `assertMetric()` refuses a number whose method is empty, whose
 * raw link does not resolve, or whose value differs from the value found
 * at that link. `renderReport()` calls it for every metric, so a number
 * without method and raw link cannot reach docs/value-report.md.
 * Not measured is `null` with a reason, never 0.
 *
 * **What is reused.** The synthetic corpus is bench/scale.mjs's (the same
 * one bench/cold-find.mjs times), the gold set and its judge are
 * bench/gold-compare.mjs's, redaction and the writer are the shipped
 * modules, the digest rule is src/raw.mjs `due()` itself, and the
 * mutation score is `bench/mutation.mjs --security`. Nothing is
 * re-implemented; this file adds the combination, the decoy and secret
 * sets (bench/gold/decoys.jsonl, generated secrets) and the report.
 *
 * Synthetic data only. No personal data, no real secret: every secret
 * under test is random, generated at run time and never written to the
 * raw JSON (only the category and the verdict are).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { environment, pct, mem } from './atlas/core.mjs';
import { buildCorpus, QUERIES as SCALE_QUERIES } from './scale.mjs';
import { loadCases, loadWorld, askOne, judge } from './gold-compare.mjs';
import { loadIndex, search } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';
import * as raw from '../src/raw.mjs';
import { redact } from '../src/redaction.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
export const DOCS_DIR = path.join(REPO, 'docs');
export const RAW_DIR = path.join(DOCS_DIR, 'value-report');
export const REPORT_FILE = path.join(DOCS_DIR, 'value-report.md');
export const DECOYS_FILE = path.join(HERE, 'gold', 'decoys.jsonl');
export const README_BEGIN = '<!-- value-report:begin -->';
export const README_END = '<!-- value-report:end -->';
export const DEFAULT_SIZES = [10000, 100000];
export const RAW_FILES = Object.freeze(['meta', 'recall', 'speed', 'space', 'cost', 'durability', 'secrets', 'mutation']);

// --- small helpers -----------------------------------------------------

function rngOf(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round = (x, d = 3) => (x == null ? null : +x.toFixed(d));
const sorted = (v) => v.slice().sort((a, b) => a - b);
function dist(v) {
  if (!v.length) return { n: 0, medianMs: null, p95Ms: null, worstMs: null };
  const s = sorted(v);
  return { n: s.length, medianMs: round(pct(s, 50)), p95Ms: round(pct(s, 95)), worstMs: round(s[s.length - 1]) };
}
export function sizeLabel(n) {
  if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`;
  if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}k`;
  return String(n);
}
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
function dirBytes(dir) {
  let b = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) b += dirBytes(p); else { try { b += fs.statSync(p).size; } catch { /* gone */ } }
  }
  return b;
}
function jsonlBytes(root) {
  let b = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) b += fs.statSync(p).size;
    }
  };
  walk(path.join(root, 'global'));
  walk(path.join(root, 'projects'));
  return b;
}
function stamp() {
  const e = environment();
  return { commit: e.gitCommit ?? null, dirty: !!e.workingTreeDirty, measuredAt: new Date().toISOString() };
}

// --- 1 + 2: finds what you mean, does not make things up ---------------

const GROUPS = Object.freeze({
  lexical: 'keywords',
  paraphrase: 'other-words',
  scope: 'right-project',
  temporal: 'latest-fact',
  status: 'still-valid',
  'cross-language': 'other-language',
});
const groupOf = (c) => (c.category === 'paraphrase' && /^plain question/.test(c.note ?? '') ? 'everyday' : GROUPS[c.category]);

export function loadDecoys(file = DECOYS_FILE) { return readJsonl(file); }

/** Pure: judged cases -> per-group counts. Unknown makes a group unmeasured, never a pass. */
export function summariseRecall(judged) {
  const groups = {};
  const add = (g, r) => {
    const s = groups[g] ?? (groups[g] = { n: 0, unknown: 0, at3: 0, at10: 0, pass3: 0, leaked3: 0 });
    s.n += 1;
    if (r.state === 'unknown') { s.unknown += 1; return; }
    if (r.rank != null && r.rank <= 3) s.at3 += 1;
    if (r.rank != null && r.rank <= 10) s.at10 += 1;
    if (r.rank != null && r.rank <= 3 && !(r.top ?? []).slice(0, 3).some((id) => r.leakedIds?.includes(id))) s.pass3 += 1;
    if ((r.top ?? []).slice(0, 3).some((id) => r.leakedIds?.includes(id))) s.leaked3 += 1;
  };
  for (const r of judged) { if (!r.gap) { add(r.group, r); add('all', r); } }
  for (const s of Object.values(groups)) {
    s.measured = s.unknown === 0 && s.n > 0;
    s.at3Pct = s.measured ? round((100 * s.at3) / s.n, 1) : null;
    s.at10Pct = s.measured ? round((100 * s.at10) / s.n, 1) : null;
    s.pass3Pct = s.measured ? round((100 * s.pass3) / s.n, 1) : null;
    s.leaked3Pct = s.measured ? round((100 * s.leaked3) / s.n, 1) : null;
  }
  return groups;
}

export function measureRecall(root, { codeDir = REPO } = {}) {
  const cases = loadCases();
  const judged = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-home-'));
  try {
    for (const c of cases) {
      const ans = askOne(codeDir, root, { ...c, k: undefined }, { k: 10, home });
      const j = judge({ ...c, k: undefined }, ans);
      // judge() names the ids that leaked in the top 10; the value report
      // asks about the top 3 only, so keep the forbidden list itself.
      judged.push({ id: c.id, group: groupOf(c), state: j.state, rank: j.rank ?? null, top: j.top ?? [], leakedIds: c.forbidden ?? [], ...(c.gap ? { gap: c.gap } : {}), ...(j.why ? { why: j.why } : {}) });
    }
    const decoys = [];
    for (const d of loadDecoys()) {
      const ans = askOne(codeDir, root, { query: d.query }, { k: 3, home });
      decoys.push({ id: d.id, kind: d.kind, hits: ans.unknown ? null : ans.ids.length, ...(ans.unknown ? { why: ans.unknown } : {}) });
    }
    const dec = {};
    for (const kind of ['far', 'near']) {
      const set = decoys.filter((d) => d.kind === kind);
      const unknown = set.filter((d) => d.hits == null).length;
      const fp = set.filter((d) => d.hits > 0).length;
      dec[kind] = { n: set.length, unknown, falsePositives: fp, silent: set.length - fp - unknown,
        falsePositiveRatePct: unknown === 0 && set.length ? round((100 * fp) / set.length, 1) : null };
    }
    return { groups: summariseRecall(judged), cases: judged, decoys: dec, decoyCases: decoys };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// --- 3 + 4: speed and space -------------------------------------------

export function measureSpeed(root, { coldRuns = 24, warmRuns = 60, maxMs = 15 * 60 * 1000 } = {}) {
  const t0 = performance.now();
  const cold = [];
  for (let i = 0; i < coldRuns; i += 1) {
    if (performance.now() - t0 > maxMs) break;
    const r = mem(['find', SCALE_QUERIES[i % SCALE_QUERIES.length]], { root, timeoutMs: maxMs });
    if (r.status !== 0) return { state: 'not-measured', why: `a fresh find exited ${r.status}` };
    cold.push(r.ms);
  }
  const index = loadIndex(root, { language: 'en' });
  const options = { top: 30, mmr: true, mmrLambda: 0.7 };
  for (let i = 0; i < 3; i += 1) search(index, SCALE_QUERIES[i], options);
  const warm = [];
  for (let i = 0; i < warmRuns; i += 1) {
    if (performance.now() - t0 > maxMs) break;
    const s = performance.now();
    search(index, SCALE_QUERIES[i % SCALE_QUERIES.length], options);
    warm.push(performance.now() - s);
  }
  return { state: 'measured', cold: dist(cold), warm: dist(warm), queries: SCALE_QUERIES.length };
}

/** Time of the first answer after adding one note (the index is stale), and of the write itself. */
export function measureAfterWrite(root, { runs = 5 } = {}) {
  const afterAdd = [];
  for (let i = 0; i < runs; i += 1) {
    memory.logEntry(root, 'learning', { id: `vr-w${i}`, title: `value report probe ${i}`, text: 'a note added to measure the first answer after a write', agent: 'human:alex' }, { now: new Date() });
    const r = mem(['find', SCALE_QUERIES[0]], { root });
    if (r.status !== 0) return { state: 'not-measured', why: `find after a write exited ${r.status}` };
    afterAdd.push(r.ms);
  }
  return { state: 'measured', ...dist(afterAdd) };
}

/** Pure: growth between consecutive sizes. `exponent` 1.0 = linear. */
export function growth(bySize) {
  const sizes = Object.keys(bySize).map(Number).sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < sizes.length; i += 1) {
    const a = bySize[sizes[i - 1]]; const b = bySize[sizes[i]];
    const g = { from: sizes[i - 1], to: sizes[i], notesFactor: round(sizes[i] / sizes[i - 1], 2) };
    for (const [k, pick] of [['coldMedian', (s) => s?.cold?.medianMs], ['coldP95', (s) => s?.cold?.p95Ms], ['warmMedian', (s) => s?.warm?.medianMs], ['warmP95', (s) => s?.warm?.p95Ms]]) {
      const x = pick(a); const y = pick(b);
      const ok = Number.isFinite(x) && Number.isFinite(y) && x > 0;
      g[`${k}Factor`] = ok ? round(y / x, 2) : null;
      g[`${k}Exponent`] = ok ? round(Math.log(y / x) / Math.log(sizes[i] / sizes[i - 1]), 2) : null;
    }
    out.push(g);
  }
  return out;
}

export function measureSpace(root, notes) {
  const log = jsonlBytes(root);
  const cache = dirBytes(path.join(root, '.mem', 'search-index'));
  return { notes, logBytes: log, indexCacheBytes: cache, logBytesPerNote: round(log / notes, 1), withIndexBytesPerNote: round((log + cache) / notes, 1) };
}

// --- one size, everything that needs a corpus -------------------------

export async function measureSize(n, o) {
  const world = loadWorld();
  const goldN = world.entries.length;
  const { root } = buildCorpus(Math.max(0, n - goldN));
  const log = (m) => process.stderr.write(`  [${sizeLabel(n)}] ${m}\n`);
  try {
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify(world.config ?? {}));
    // The gold world goes in through the real writer: these are the writes timed below.
    const w = [];
    for (const row of world.entries) {
      if (row.project) memory.projectInit(root, row.project); // idempotent; logEntry refuses an unknown project
      const t = performance.now();
      memory.logEntry(root, row.type, row.data, { project: row.project ?? null, now: new Date(row.at) });
      w.push(performance.now() - t);
    }
    log('first search (builds the index)');
    const first = mem(['find', SCALE_QUERIES[0]], { root, timeoutMs: o.maxMs });
    const res = { entries: n, goldNotes: goldN };
    res.firstSearch = first.status === 0 ? { state: 'measured', ms: round(first.ms, 1) } : { state: 'not-measured', why: `exit ${first.status}` };
    res.write = { state: 'measured', ...dist(w) };
    if (o.only.has('recall')) { log('recall + decoys'); res.recall = measureRecall(root); }
    if (o.only.has('speed')) { log('speed'); res.speed = measureSpeed(root, o); }
    if (o.only.has('speed')) { log('after a write'); res.afterWrite = measureAfterWrite(root, { runs: o.rebuildRuns }); }
    if (o.only.has('space')) { mem(['find', SCALE_QUERIES[0]], { root }); res.space = measureSpace(root, n); }
    return res;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** Bytes per note as written by the real writer, on the gold notes (real-shaped). */
export function measureRealNoteBytes() {
  const world = loadWorld();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-bytes-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify(world.config ?? {}));
    for (const row of world.entries) {
      if (row.project) memory.projectInit(root, row.project); // idempotent
      memory.logEntry(root, row.type, row.data, { project: row.project ?? null, now: new Date(row.at) });
    }
    const b = jsonlBytes(root);
    return { notes: world.entries.length, logBytes: b, bytesPerNote: round(b / world.entries.length, 1) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 5: cost of the digest --------------------------------------------

export const COST_SCENARIOS = Object.freeze([
  { id: 'idle', label: 'idle: nothing captured', days: 1, captures: 0, kb: 0 },
  { id: 'away', label: 'away for a week after one small pile', days: 7, captures: 1, kb: 40, firstDayOnly: true },
  { id: 'light', label: 'light day: 6 captures of 20 KB', days: 1, captures: 6, kb: 20 },
  { id: 'typical', label: 'typical day: 12 captures of 40 KB', days: 1, captures: 12, kb: 40 },
  { id: 'heavy', label: 'heavy day: 40 captures of 100 KB', days: 1, captures: 40, kb: 100 },
]);

/**
 * Replays the real dueness rule (src/raw.mjs `due()`) over simulated days:
 * a timer tick every `tickMin` minutes, captures arriving between 09:00 and
 * 17:00. Every tick that finds the digest due is exactly one model call
 * (bin/mem-digest makes exactly one per due tick). Assumes one call clears
 * the pile, which holds below MEM_DIGEST_MAX_BYTES of raw material per call.
 */
export function simulateDigestDay(sc, { tickMin = 10, seed = 7 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-cost-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    const r = rngOf(seed);
    const day0 = Date.UTC(2026, 0, 5, 0, 0, 0);
    const events = [];
    for (let d = 0; d < sc.days; d += 1) {
      const n = sc.firstDayOnly && d > 0 ? 0 : sc.captures;
      for (let i = 0; i < n; i += 1) events.push(day0 + d * 86400000 + (9 * 3600 + Math.floor(r() * 8 * 3600)) * 1000);
    }
    events.sort((a, b) => a - b);
    let calls = 0; const reasons = {}; let e = 0; let seq = 0;
    for (let t = day0; t < day0 + sc.days * 86400000; t += tickMin * 60000) {
      while (e < events.length && events[e] <= t) {
        const when = new Date(events[e]);
        const p = raw.capturePath(root, { session_id: `sim${seq += 1}` }, when);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.alloc(sc.kb * 1024, 1));
        raw.ring(root, when);
        e += 1;
      }
      const d = raw.due(root, { now: new Date(t) });
      if (d.due) {
        calls += 1; reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
        raw.markDigested(root, raw.pending(root).open);
      }
    }
    return { days: sc.days, captures: events.length, captureKB: sc.kb, calls, callsPerDay: round(calls / sc.days, 2), reasons };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

export function measureCost(opts = {}) {
  const scenarios = {};
  for (const sc of COST_SCENARIOS) scenarios[sc.id] = { label: sc.label, ...simulateDigestDay(sc, opts) };
  return {
    tickMin: opts.tickMin ?? 10,
    scenarios,
    dollars: { state: 'not-measured', why: 'the price of one call depends on your model and plan; the code states no price. bin/mem-digest journals the real cost of every run to .pipeline/model-cost.jsonl (read from the CLI, labelled an estimate), so your own figure appears after your first digest.' },
    thresholds: raw.DUE_DEFAULTS,
  };
}

// --- 6: never loses a note --------------------------------------------

/** Child mode: write notes one after another, print each id AFTER the write returned. */
function childWriter(root, tag) {
  const world = loadWorld();
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify(world.config ?? {}));
  for (let i = 0; ; i += 1) {
    const id = `${tag}-${i}`;
    memory.logCheckedEntry(root, 'learning', { id, title: `note ${i}`, text: `body of note ${i} `.repeat(8), agent: 'human:alex' }, { now: new Date() });
    fs.writeSync(1, `${id}\n`);
  }
}

export function readAllNotes(root) {
  const ids = new Set(); let corrupt = 0; let lines = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        lines += 1;
        try { const o = JSON.parse(line); if (o?.id) ids.add(o.id); } catch { corrupt += 1; }
      }
    }
  };
  walk(path.join(root, 'global')); walk(path.join(root, 'projects'));
  return { ids, corrupt, lines };
}

export async function measureDurability({ trials = 30, seed = 11 } = {}) {
  const r = rngOf(seed);
  const errors = new Set(); const after = [];
  const out = { trials, killedWhileWriting: 0, acknowledged: 0, lost: 0, corruptLines: 0, trialsWithLoss: 0, trialsWithCorruption: 0, writeAfterCrashFailed: 0 };
  for (let t = 0; t < trials; t += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-crash-'));
    try {
      const acked = [];
      const kid = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child-writer', root, `t${t}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      kid.stdout.setEncoding('utf8');
      kid.stdout.on('data', (s) => { buf += s; const parts = buf.split('\n'); buf = parts.pop(); acked.push(...parts); });
      const exited = new Promise((res) => kid.once('exit', res));
      // Let it run for a random time after it has started writing, then SIGKILL: no handler, no flush.
      const until = Date.now() + 15000;
      while (acked.length < 3 && Date.now() < until && kid.exitCode == null) await new Promise((res) => setTimeout(res, 5));
      await new Promise((res) => setTimeout(res, 20 + Math.floor(r() * 280)));
      kid.kill('SIGKILL');
      await exited;
      await new Promise((res) => setTimeout(res, 20));
      const seen = readAllNotes(root);
      const lost = acked.filter((id) => !seen.ids.has(id));
      out.acknowledged += acked.length; out.lost += lost.length; out.corruptLines += seen.corrupt;
      if (lost.length) out.trialsWithLoss += 1;
      if (seen.corrupt) out.trialsWithCorruption += 1;
      out.killedWhileWriting += 1;
      const t1 = performance.now();
      try {
        memory.logCheckedEntry(root, 'learning', { id: `after-${t}`, title: 'after the crash', text: 'next write', agent: 'human:alex' }, { now: new Date() });
        const again = readAllNotes(root);
        if (!again.ids.has(`after-${t}`) || again.corrupt > seen.corrupt) { out.writeAfterCrashFailed += 1; errors.add('next write left the files invalid'); }
      } catch (e) { out.writeAfterCrashFailed += 1; errors.add(String(e.message).split(root).join('<memory>').slice(0, 160)); }
      after.push(performance.now() - t1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  out.nextWriteAfterCrash = dist(after);
  out.nextWriteErrors = [...errors].slice(0, 3);
  return out;
}

// --- 7: keeps secrets out ----------------------------------------------

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const URLSAFE = `${ALNUM}_-`;
/** Random body that cannot start like a placeholder word (the harmless-value rule). */
function body(r, len, alphabet = ALNUM) {
  let s = `${Math.floor(r() * 9) + 1}${Math.floor(r() * 9) + 1}`;
  while (s.length < len) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}
const b64 = (r, len) => body(r, len, `${ALNUM}-_`);

/** Secret kinds: [kind, (r) => ({ secret, text }) where `text` carries the secret in realistic shape]. */
export const SECRET_KINDS = Object.freeze([
  ['anthropic-key', (r) => { const s = `sk-ant-api03-${body(r, 40, URLSAFE)}`; return { secret: s, text: `key is ${s}` }; }],
  ['openai-key', (r) => { const s = `sk-${body(r, 48)}`; return { secret: s, text: `OPENAI key ${s} in the notebook` }; }],
  ['voyage-key', (r) => { const s = `pa-${body(r, 40, URLSAFE)}`; return { secret: s, text: `embedding key ${s}` }; }],
  ['github-token', (r) => { const s = `ghp_${body(r, 36)}`; return { secret: s, text: `git push used ${s}` }; }],
  ['github-pat', (r) => { const s = `github_pat_${body(r, 70, `${ALNUM}_`)}`; return { secret: s, text: `PAT ${s}` }; }],
  ['slack-token', (r) => { const s = `xoxb-${body(r, 40, `${ALNUM}-`)}`; return { secret: s, text: `bot token ${s}` }; }],
  ['stripe-key', (r) => { const s = `sk_live_${body(r, 28)}`; return { secret: s, text: `billing ${s}` }; }],
  ['google-key', (r) => { const s = `AIza${body(r, 35, URLSAFE)}`; return { secret: s, text: `maps key ${s}` }; }],
  ['aws-key-id', (r) => { const s = `AKIA${body(r, 16, UPPER)}`.slice(0, 20); return { secret: s, text: `aws id ${s}` }; }],
  ['hf-token', (r) => { const s = `hf_${body(r, 34)}`; return { secret: s, text: `hub token ${s}` }; }],
  ['npm-token', (r) => { const s = `npm_${body(r, 36)}`; return { secret: s, text: `publish with ${s}` }; }],
  ['telegram-token', (r) => { const s = `${Math.floor(1e8 + r() * 8e8)}:AA${body(r, 33, URLSAFE)}`; return { secret: s, text: `bot ${s}` }; }],
  ['jwt', (r) => { const s = `eyJ${b64(r, 20)}.eyJ${b64(r, 30)}.${b64(r, 30)}`; return { secret: s, text: `session cookie ${s}` }; }],
  ['json-blob', (r) => { const s = `eyJ${b64(r, 80)}`; return { secret: s, text: `tunnel token ${s}` }; }],
  ['pem-block', (r) => { const s = body(r, 60); return { secret: s, text: `-----BEGIN RSA PRIVATE KEY-----\n${s}\n${b64(r, 60)}\n-----END RSA PRIVATE KEY-----` }; }],
  ['ssh-key', (r) => { const s = body(r, 80, `${ALNUM}+/`); return { secret: s, text: `authorized: ssh-ed25519 ${s} user@host` }; }],
  ['bearer', (r) => { const s = body(r, 36, `${ALNUM}._~+/-`); return { secret: s, text: `Authorization: Bearer ${s}` }; }],
  ['basic-auth', (r) => { const s = body(r, 28, `${ALNUM}+/`); return { secret: s, text: `Authorization: Basic ${s}==` }; }],
  ['url-credentials', (r) => { const s = body(r, 14); return { secret: s, text: `postgres://admin:${s}@db.internal:5432/app` }; }],
  ['x-api-key', (r) => { const s = body(r, 28, `${ALNUM}._-`); return { secret: s, text: `curl -H "x-api-key: ${s}" https://api.example.test` }; }],
  ['env-secret', (r) => { const s = body(r, 22); return { secret: s, text: `export DB_PASSWORD=${s}` }; }],
  ['cli-flag', (r) => { const s = body(r, 30, URLSAFE); return { secret: s, text: `tunnel run --token ${s}` }; }],
  ['json-secret', (r) => { const s = body(r, 24); return { secret: s, text: `{"secretKey": "${s}", "region": "eu"}` }; }],
  ['credential-pair', (r) => { const s = `${body(r, 12)}!x`; return { secret: s, text: `admin: someone@example.test / ${s}` }; }],
]);

const WRAPS = Object.freeze([
  (t) => t,
  (t) => `Notes from the call. ${t}. Please keep this private.`,
  (t) => `{"level":"info","msg":${JSON.stringify(t)},"ts":1}`,
  (t) => `\`\`\`\n${t}\n\`\`\``,
  (t) => `first line\n${t}\nlast line`,
]);

export const BENIGN = Object.freeze([
  'We chose PostgreSQL because transactions matter for money.',
  'commit 9fceb02d0ae598e95dc970b74767f19372d61af8 fixed the retry bug',
  'request id 123e4567-e89b-12d3-a456-426614174000 timed out',
  'the password reset flow sends an email with a one-time link',
  'token budget for the digest is 4000 tokens per run',
  'export API_TOKEN=your-token-here  # replace before use',
  'set DB_PASSWORD=<your password> in the local env file',
  'password: changeme',
  'see https://example.test/docs/auth?page=2 for the auth flow',
  'secret sharing was discussed; no secret is stored here',
  'the file lives at /var/lib/app/config/settings.yaml',
  'nextPageToken is an opaque cursor, not a credential',
  'fetch(url, { credentials: "same-origin" })',
  'error: ECONNRESET after 3 retries on port 5432',
  'build 2026.09.28-rc1 passed on node 22',
  'the api key rotation happens every 90 days (ticket OPS-1432)',
  'Authorization header missing: returned 401',
  'sha256 of the tarball is recorded in the release notes',
  'we keep invoices for ten years',
  'ssh into the staging box and tail the logs',
  'bearer of bad news: the migration was rolled back',
  'Basic auth is disabled on the public endpoint',
  'the JWT library was upgraded to a new major version',
  'AWS region eu-central-1 hosts the queue',
  'private key rotation is documented in the runbook',
  'user alice@example.test asked about the invoice',
  'color: #3366ff; margin: 0 auto',
  'the cache key is built from the project and the tag',
  'order 8841 was charged twice, refunded on Friday',
  'a long identifier abcdefghijklmnopqrstuvwxyz0123456789 is just a sample name',
]);

export function measureSecrets({ variants = WRAPS.length, seed = 5, redactFn = redact } = {}) {
  const r = rngOf(seed);
  const perKind = {};
  let n = 0; let caught = 0; let landed = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-secret-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify(loadWorld().config ?? {}));
    let i = 0;
    for (const [kind, gen] of SECRET_KINDS) {
      const k = perKind[kind] = { n: 0, caught: 0, landed: 0 };
      for (let v = 0; v < variants; v += 1) {
        const { secret, text } = gen(r);
        const wrapped = WRAPS[v % WRAPS.length](text);
        n += 1; k.n += 1;
        const out = redactFn(wrapped).text;
        if (!out.includes(secret)) { caught += 1; k.caught += 1; }
        // End to end: through the real writer into the log file, then look at the bytes on disk.
        const id = `sec-${i += 1}`;
        let leaked = true;
        try {
          memory.logCheckedEntry(root, 'learning', { id, title: 'secret probe', text: wrapped, agent: 'human:alex' }, { now: new Date() });
          const disk = fs.readFileSync(path.join(root, 'global', 'learnings.jsonl'), 'utf8');
          leaked = disk.includes(secret) || disk.includes(JSON.stringify(secret).slice(1, -1));
        } catch { leaked = false; /* refused to write: nothing landed */ }
        if (!leaked) { landed += 1; k.landed += 1; }
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const benignChanged = BENIGN.filter((s) => redact(s).text !== s).length;
  return {
    kinds: SECRET_KINDS.length, variantsPerKind: variants, secrets: n,
    caughtByRedaction: caught, caughtPct: round((100 * caught) / n, 1),
    keptOutOfLogFile: landed, keptOutOfLogFilePct: round((100 * landed) / n, 1),
    benign: BENIGN.length, benignChanged, benignUntouchedPct: round((100 * (BENIGN.length - benignChanged)) / BENIGN.length, 1),
    perKind,
  };
}

export function measureMutation({ run = false } = {}) {
  if (!run) return { state: 'not-measured', why: 'not run in this pass; add --mutation (it applies each security mutant and runs its own test suites, several minutes)' };
  const r = spawnSync(process.execPath, [path.join(HERE, 'mutation.mjs'), '--security'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 3 * 3600 * 1000 });
  if (/suites these mutants rely on are already failing/.test(r.stdout ?? '')) {
    const first = /^not ok \d+ - (.+)$/m.exec(r.stdout)?.[1] ?? 'unknown test';
    const dep = /needs (@?[\w/.-]+)/.exec(r.stdout)?.[1];
    return { state: 'not-measured', why: `the suites the security mutants rely on already fail here (first: "${first}"${dep ? `; missing optional dependency ${dep}` : ''}), and a score on a red baseline would be meaningless; fix the baseline and re-run \`node bench/value-report.mjs --mutation-only\`` };
  }
  const m = /(\d+)\/(\d+) applied mutants caught by tests \(of (\d+) defined; (\d+) anchor gone, (\d+) ambiguous\)/.exec(r.stdout ?? '');
  if (!m) return { state: 'not-measured', why: `mutation.mjs --security produced no score line (exit ${r.status})` };
  const perModule = {};
  for (const line of (r.stdout.split('Caught mutants per module')[1] ?? '').split('\n')) {
    const mm = /^\s+(src\/\S+)\s+(\d+)\/(\d+)/.exec(line);
    if (mm) perModule[mm[1]] = { caught: +mm[2], total: +mm[3] };
  }
  const caught = +m[1]; const applied = +m[2];
  return { state: 'measured', caught, applied, defined: +m[3], anchorGone: +m[4], ambiguous: +m[5], scorePct: applied ? round((100 * caught) / applied, 1) : null, perModule };
}

// --- metrics: the only way a number reaches the report ----------------

/** RFC 6901-style pointer; `undefined` when it does not resolve. */
export function resolvePointer(obj, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  let cur = obj;
  for (const part of pointer.slice(1).split('/')) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export const METHODS = Object.freeze({
  gold: 'A fixed set of labelled questions (bench/gold/cases.jsonl) is asked of a memory made of an invented demo team (bench/gold/world.jsonl) plus synthetic filler notes up to the stated size (bench/scale.mjs, seed 42). Each question goes through the real `mem find`; the right note must be among the first 3 (or 10) answers. Questions marked as known gaps are left out and listed in the raw data.',
  scoped: 'Same set. A question passes only if the right note is in the first 3 answers and none of the notes that must NOT appear (another project, an outdated or withdrawn note) is in the first 3.',
  decoy: 'Questions about things that were never written down (bench/gold/decoys.jsonl), asked through the real `mem find` against the same memory. "Far" questions share no topic word with the notes (plain question words such as "how" or "for" can still match, as they do for a person); "near" questions share one topic word but ask about something absent. Any answer at all counts as a false answer.',
  speed: 'Cold: a fresh `mem find` process, index read from its cache (what a prompt-time hook pays). Warm: the same search on an index already in memory. Six fixed questions in rotation; median, 95th percentile and worst of all runs. Same synthetic memory as above; the first search after the build is not counted.',
  afterWrite: 'One note is added with the real writer, then the first `mem find` is timed (the index is stale and must catch up); repeated several times.',
  write: 'The demo notes are added one by one with the real writer (`logEntry`) into the memory of the stated size; the time of each write is recorded.',
  growth: 'Median or 95th percentile at a larger size divided by the same figure at the smaller size. The exponent is log(time ratio) / log(size ratio): 1.0 means time grows in step with the number of notes.',
  space: 'Bytes of the note logs and of the search-index cache on disk after the first search, divided by the number of notes. The synthetic filler notes are short; the "demo notes" figure comes from the real writer on the real-shaped demo notes.',
  extrapolation: 'Bytes per note times one million. This is arithmetic, not a measurement, unless a 1M run is part of this report (then the measured size is shown instead).',
  cost: 'The real dueness rule of the digest (`due()` in src/raw.mjs) is replayed over simulated days: a timer tick every 10 minutes, captures arriving between 09:00 and 17:00, one call whenever a tick finds the digest due (bin/mem-digest makes exactly one model call per due tick). It assumes one call clears the pile. No prices are used.',
  price: 'Not measured: the code states no price and none is invented here. The digest records the real cost of every run in `.pipeline/model-cost.jsonl` (an estimate read from the CLI).',
  durability: 'A child process adds notes one after another with the real writer and reports each id only after the write returned. The parent kills it with SIGKILL (no handler, no flush) at a random moment, then reads every log file: acknowledged notes missing from disk count as lost, lines that are not valid JSON count as corrupt. A further write after the crash must succeed and leave the files valid.',
  secrets: 'Random fake secrets of 24 kinds (provider keys, tokens, JWTs, private-key blocks, passwords in URLs, env files, JSON, CLI flags), each in 5 realistic shapes (plain, in prose, in a JSON log line, in a code block, on its own line). Generated at run time; none is stored. "Kept out" = the secret string is not in the redacted text, and (end to end) not in the log file written by the real writer.',
  benign: 'Thirty ordinary lines that mention passwords, tokens and keys without containing one (placeholders, hashes, ids, prose) go through the same redaction; they should come out unchanged.',
  mutation: '`node bench/mutation.mjs --security` breaks each security-relevant guarantee on purpose (redaction, login, capability, chain, shred, append, claim, write gate, path check, file lock, inbox, guard) and checks that the tests notice; the score is caught mutants over applied mutants.',
});

const pctFmt = (x) => (Number.isInteger(x) ? `${x}%` : `${x.toFixed(1)}%`);
const msFmt = (x) => (x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : String(Math.round(x)));
const bytesFmt = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const xFmt = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}x`;

/**
 * Pure: raw JSON (by file name) -> metric list. Nothing else feeds a number
 * into the report. A section that was not measured yields value null and a
 * reason, never 0.
 */
export function buildMetrics(rawData) {
  const M = [];
  const add = (m) => M.push(m);
  const sizes = Object.keys(rawData.recall?.sizes ?? rawData.speed?.sizes ?? rawData.space?.sizes ?? {}).map(Number).sort((a, b) => a - b);

  // 1 + 2: recall and decoys
  const GROUP_TEXT = {
    keywords: ['Ask with the words that are in the note', 'gold'],
    everyday: ['Ask in your own everyday words, not the note’s technical ones', 'gold'],
    'other-words': ['Ask with technical words when the note is written plainly', 'gold'],
    'right-project': ['Ask inside one project and get that project’s note, not the other project’s', 'scoped'],
    'latest-fact': ['Ask for a fact that changed and get the current one, not the old one', 'scoped'],
    'still-valid': ['Ask about a withdrawn rule, a finished duty or a dropped decision and get the live note', 'scoped'],
    'other-language': ['Ask in German about an English note, or the other way round', 'gold'],
  };
  for (const n of sizes) {
    const rec = rawData.recall?.sizes?.[n];
    if (!rec) continue;
    const L = sizeLabel(n);
    for (const [g, [label, methodId]] of Object.entries(GROUP_TEXT)) {
      const s = rec.groups?.[g];
      if (!s) continue;
      const base = `/sizes/${n}/groups/${g}`;
      if (methodId === 'gold') {
        for (const k of [3, 10]) {
          const key = k === 3 ? 'at3Pct' : 'at10Pct';
          const v = s[key];
          add({ key: `recall.${g}.at${k}`, category: 'Finds what you mean', label: `${label}: right note in the top ${k}`, size: n, value: v, unit: '%',
            shown: v == null ? null : pctFmt(v), methodId, raw: { file: 'recall.json', pointer: `${base}/${key}` },
            sentence: v == null ? null : `${label}, and the right note is in the first ${k} answers for ${pctFmt(v)} of questions (${s[k === 3 ? 'at3' : 'at10']} of ${s.n}), in a memory of ${L} notes.`,
            headline: k === 3 && ['keywords', 'everyday', 'other-words'].includes(g), notMeasured: v == null ? `${s.unknown} of ${s.n} questions could not be asked` : undefined });
        }
      } else {
        const v = s.pass3Pct;
        add({ key: `recall.${g}.pass3`, category: 'Finds what you mean', label: label, size: n, value: v, unit: '%', shown: v == null ? null : pctFmt(v), methodId,
          raw: { file: 'recall.json', pointer: `${base}/pass3Pct` },
          sentence: v == null ? null : `${label}: it gets this right for ${pctFmt(v)} of questions (${s.pass3} of ${s.n}) with ${L} notes in the memory.`,
          headline: true, notMeasured: v == null ? `${s.unknown} of ${s.n} questions could not be asked` : undefined });
      }
    }
    for (const kind of ['far', 'near']) {
      const d = rec.decoys?.[kind];
      if (!d) continue;
      const v = d.falsePositiveRatePct;
      const text = kind === 'far' ? 'Ask about something you never wrote down' : 'Ask about something you never wrote down, using one word that does appear in your notes';
      add({ key: `decoy.${kind}`, category: 'Does not make things up', label: `${text}: it still answers (target 0%)`, size: n, value: v, unit: '%', shown: v == null ? null : pctFmt(v), methodId: 'decoy',
        raw: { file: 'recall.json', pointer: `/sizes/${n}/decoys/${kind}/falsePositiveRatePct` },
        sentence: v == null ? null : `${text}, and it stays quiet for ${d.silent} of ${d.n} questions; it answers anyway ${pctFmt(v)} of the time (${d.falsePositives} of ${d.n}), with ${L} notes (target 0%).`,
        headline: true, notMeasured: v == null ? `${d.unknown} of ${d.n} questions could not be asked` : undefined });
    }
  }

  // 3: speed
  for (const n of sizes) {
    const sp = rawData.speed?.sizes?.[n];
    if (!sp) continue;
    const L = sizeLabel(n);
    const ok = sp.state === 'measured';
    for (const [state, what] of [['cold', 'from a fresh start (what each prompt pays)'], ['warm', 'when the index is already loaded']]) {
      for (const [f, name] of [['medianMs', 'median'], ['p95Ms', '95th percentile'], ['worstMs', 'worst']]) {
        const v = ok ? sp[state]?.[f] ?? null : null;
        add({ key: `speed.${state}.${f}`, category: 'Speed', label: `Answer time ${state}, ${name}`, size: n, value: v, unit: 'ms', shown: v == null ? null : `${msFmt(v)} ms`, methodId: 'speed',
          raw: { file: 'speed.json', pointer: ok ? `/sizes/${n}/${state}/${f}` : `/sizes/${n}/state` },
          sentence: v == null ? null : `An answer ${what} takes ${msFmt(v)} ms (${name}) with ${L} notes.`,
          headline: state === 'cold' && f === 'medianMs', notMeasured: v == null ? (sp.why ?? 'not measured') : undefined });
      }
    }
    const aw = rawData.speed?.afterWrite?.[n];
    if (aw) {
      const v = aw.state === 'measured' ? aw.medianMs : null;
      add({ key: 'speed.afterWrite.medianMs', category: 'Speed', label: 'First answer right after adding a note, median', size: n, value: v, unit: 'ms', shown: v == null ? null : `${msFmt(v)} ms`, methodId: 'afterWrite',
        raw: { file: 'speed.json', pointer: aw.state === 'measured' ? `/afterWrite/${n}/medianMs` : `/afterWrite/${n}/state` },
        sentence: v == null ? null : `The first answer right after you add a note takes ${msFmt(v)} ms (median) with ${L} notes, because the index catches up.`,
        headline: false, notMeasured: v == null ? (aw.why ?? 'not measured') : undefined });
    }
    const w = rawData.speed?.write?.[n];
    if (w) {
      const v = w.state === 'measured' ? w.medianMs : null;
      add({ key: 'speed.write.medianMs', category: 'Speed', label: 'Adding one note, median', size: n, value: v, unit: 'ms', shown: v == null ? null : `${msFmt(v)} ms`, methodId: 'write',
        raw: { file: 'speed.json', pointer: w.state === 'measured' ? `/write/${n}/medianMs` : `/write/${n}/state` },
        sentence: v == null ? null : `Adding a note takes ${msFmt(v)} ms (median) with ${L} notes already stored.`,
        headline: false, notMeasured: v == null ? (w.why ?? 'not measured') : undefined });
    }
  }
  (rawData.speed?.growth ?? []).forEach((g, i) => {
    for (const [k, name] of [['coldMedian', 'a fresh answer'], ['warmMedian', 'a warm answer']]) {
      const f = g[`${k}Factor`];
      add({ key: `growth.${k}`, category: 'Speed', label: `${name}: slowdown from ${sizeLabel(g.from)} to ${sizeLabel(g.to)} notes`, size: g.to, value: f, unit: 'x', shown: f == null ? null : xFmt(f), methodId: 'growth',
        raw: { file: 'speed.json', pointer: `/growth/${i}/${k}Factor` },
        sentence: f == null ? null : `${xFmt(g.notesFactor)} more notes (${sizeLabel(g.from)} to ${sizeLabel(g.to)}) makes ${name} ${xFmt(f)} slower (exponent ${g[`${k}Exponent`]}; 1.0 would be exactly in step).`,
        headline: k === 'coldMedian', notMeasured: f == null ? 'one of the two sizes has no measurement' : undefined });
    }
  });

  // 4: space
  for (const n of sizes) {
    const sp = rawData.space?.sizes?.[n];
    if (!sp) continue;
    for (const [f, label] of [['logBytesPerNote', 'Disk per note (notes only)'], ['withIndexBytesPerNote', 'Disk per note (notes and search index)']]) {
      const v = sp[f] ?? null;
      add({ key: `space.${f}`, category: 'Space', label, size: n, value: v, unit: 'B', shown: v == null ? null : `${Math.round(v)} B`, methodId: 'space',
        raw: { file: 'space.json', pointer: `/sizes/${n}/${f}` },
        sentence: v == null ? null : (f === 'logBytesPerNote' ? `A short synthetic note takes ${Math.round(v)} bytes in the log (${sizeLabel(n)} notes).` : `With its share of the search index, a short synthetic note takes ${Math.round(v)} bytes on disk (${sizeLabel(n)} notes).`),
        headline: f === 'withIndexBytesPerNote', notMeasured: v == null ? 'not measured' : undefined });
    }
  }
  const real = rawData.space?.realNotes;
  if (real) {
    const v = real.bytesPerNote ?? null;
    add({ key: 'space.realBytesPerNote', category: 'Space', label: 'Disk per note (real-shaped demo notes)', size: null, value: v, unit: 'B', shown: v == null ? null : `${Math.round(v)} B`, methodId: 'space',
      raw: { file: 'space.json', pointer: '/realNotes/bytesPerNote' },
      sentence: v == null ? null : `A real-shaped note written by the real writer takes ${Math.round(v)} bytes in the log (notes only).`, headline: true,
      notMeasured: v == null ? 'not measured' : undefined });
    const e = rawData.space?.extrapolation;
    if (e) {
      add({ key: 'space.extrapolatedGB', category: 'Space', label: 'One million real-shaped notes, notes only (extrapolated)', size: 1000000, value: e.realNotesGB, unit: 'GB', shown: e.realNotesGB == null ? null : `${e.realNotesGB.toFixed(2)} GB`, methodId: 'extrapolation',
        raw: { file: 'space.json', pointer: '/extrapolation/realNotesGB' },
        sentence: e.realNotesGB == null ? null : `One million notes shaped like the demo notes would take about ${e.realNotesGB.toFixed(2)} GB for the notes alone (extrapolated, not measured).`, headline: true,
        notMeasured: e.realNotesGB == null ? 'not measured' : undefined });
    }
  }

  // 5: cost
  const cost = rawData.cost;
  if (cost) {
    for (const [id, s] of Object.entries(cost.scenarios ?? {})) {
      const total = id === 'away';
      const f = total ? 'calls' : 'callsPerDay';
      const v = s[f] ?? null;
      add({ key: `cost.${id}`, category: 'Cost', label: `Model calls: ${s.label}`, size: null, value: v, unit: total ? 'calls' : 'calls/day', shown: v == null ? null : String(v), methodId: 'cost',
        raw: { file: 'cost.json', pointer: `/scenarios/${id}/${f}` },
        sentence: v == null ? null : (total ? `Away for a week after one small pile, the digest makes ${v} model call${v === 1 ? '' : 's'} in the whole week.` : id === 'idle' ? `When nothing is captured, the digest makes ${v} model calls a day.` : `On a ${s.label.split(':')[0]} (${s.label.split(':')[1].trim()}), the digest makes ${v} model call${v === 1 ? '' : 's'} a day.`),
        headline: true, notMeasured: v == null ? 'not measured' : undefined });
    }
    add({ key: 'cost.dollars', category: 'Cost', label: 'Dollars per day', size: null, value: null, unit: '$', shown: null, methodId: 'price', raw: { file: 'cost.json', pointer: '/dollars/why' },
      sentence: null, headline: false, notMeasured: cost.dollars?.why ?? 'not measured' });
  }

  // 6: durability
  const du = rawData.durability;
  if (du) {
    for (const [f, label, text] of [['lost', 'Notes lost after a crash', (v, d) => `Killing the writer mid-write ${d.trials} times, ${v} of ${d.acknowledged} acknowledged notes were missing afterwards.`],
      ['corruptLines', 'Corrupt lines after a crash', (v, d) => `Killing the writer mid-write ${d.trials} times left ${v} damaged lines in the note files.`],
      ['writeAfterCrashFailed', 'Writes that failed after a crash', (v, d) => `After the crash, the next write failed in ${v} of ${d.trials} trials (the crashed writer\u2019s lock had to expire first).`]]) {
      const v = Number.isFinite(du[f]) ? du[f] : null;
      add({ key: `durability.${f}`, category: 'Never loses a note', label, size: null, value: v, unit: 'count', shown: v == null ? null : String(v), methodId: 'durability', raw: { file: 'durability.json', pointer: `/${f}` },
        sentence: v == null ? null : text(v, du), headline: true, notMeasured: v == null ? 'not measured' : undefined });
    }
  }

  if (du?.nextWriteAfterCrash) {
    const v = du.nextWriteAfterCrash.worstMs ?? null;
    add({ key: 'durability.nextWriteWorstMs', category: 'Never loses a note', label: 'Next write after a crash, worst', size: null, value: v, unit: 'ms', shown: v == null ? null : `${msFmt(v)} ms`, methodId: 'durability',
      raw: { file: 'durability.json', pointer: '/nextWriteAfterCrash/worstMs' },
      sentence: v == null ? null : `The next write after a crash took ${msFmt(du.nextWriteAfterCrash.medianMs)} ms (median) and ${msFmt(v)} ms in the worst of ${du.nextWriteAfterCrash.n} trials.`,
      headline: true, notMeasured: v == null ? 'not measured' : undefined });
  }

  // 7: secrets
  const se = rawData.secrets;
  if (se) {
    add({ key: 'secrets.caught', category: 'Keeps secrets out', label: 'Secrets removed by redaction', size: null, value: se.caughtPct ?? null, unit: '%', shown: se.caughtPct == null ? null : pctFmt(se.caughtPct), methodId: 'secrets', raw: { file: 'secrets.json', pointer: '/caughtPct' },
      sentence: se.caughtPct == null ? null : `Of ${se.secrets} fake secrets (${se.kinds} kinds, several shapes each), ${pctFmt(se.caughtPct)} were removed before storing (${se.caughtByRedaction} of ${se.secrets}).`, headline: true });
    add({ key: 'secrets.landed', category: 'Keeps secrets out', label: 'Secrets kept out of the log file (end to end)', size: null, value: se.keptOutOfLogFilePct ?? null, unit: '%', shown: se.keptOutOfLogFilePct == null ? null : pctFmt(se.keptOutOfLogFilePct), methodId: 'secrets', raw: { file: 'secrets.json', pointer: '/keptOutOfLogFilePct' },
      sentence: se.keptOutOfLogFilePct == null ? null : `Written through the real writer, ${pctFmt(se.keptOutOfLogFilePct)} of the fake secrets stayed out of the log file on disk (${se.keptOutOfLogFile} of ${se.secrets}).`, headline: true });
    add({ key: 'secrets.benign', category: 'Keeps secrets out', label: 'Ordinary text left untouched', size: null, value: se.benignUntouchedPct ?? null, unit: '%', shown: se.benignUntouchedPct == null ? null : pctFmt(se.benignUntouchedPct), methodId: 'benign', raw: { file: 'secrets.json', pointer: '/benignUntouchedPct' },
      sentence: se.benignUntouchedPct == null ? null : `Ordinary text about passwords and keys came through unchanged ${pctFmt(se.benignUntouchedPct)} of the time (${se.benign - se.benignChanged} of ${se.benign} lines).`, headline: false });
  }
  const mu = rawData.mutation;
  if (mu) {
    const ok = mu.state === 'measured';
    add({ key: 'mutation.score', category: 'Keeps secrets out', label: 'Security mutants caught by tests', size: null, value: ok ? mu.scorePct : null, unit: '%', shown: ok ? pctFmt(mu.scorePct) : null, methodId: 'mutation',
      raw: { file: 'mutation.json', pointer: ok ? '/scorePct' : '/state' },
      sentence: ok ? `When each of ${mu.applied} security guarantees was broken on purpose, the tests noticed ${pctFmt(mu.scorePct)} of the time (${mu.caught} of ${mu.applied}).` : null,
      headline: true, notMeasured: ok ? undefined : mu.why });
  }
  return M;
}

/** Refuses a number without method, a raw link that resolves, and a value that matches it. */
export function assertMetric(m, rawData) {
  const where = `metric '${m?.key ?? '?'}'${m?.size ? ` @${m.size}` : ''}`;
  if (!m || typeof m !== 'object') throw new Error('value-report: a metric must be an object');
  if (typeof m.methodId !== 'string' || !(METHODS[m.methodId] ?? '').trim()) throw new Error(`value-report: ${where} has no method`);
  if (!m.raw || typeof m.raw.file !== 'string' || !m.raw.file || typeof m.raw.pointer !== 'string' || !m.raw.pointer) throw new Error(`value-report: ${where} has no link to the raw data`);
  const at = resolvePointer(rawData?.[m.raw.file.replace(/\.json$/, '')], m.raw.pointer);
  if (at === undefined) throw new Error(`value-report: ${where} points at ${m.raw.file}#${m.raw.pointer}, which does not exist`);
  if (m.value === null || m.value === undefined) {
    if (!(typeof m.notMeasured === 'string' && m.notMeasured.trim())) throw new Error(`value-report: ${where} has no value and no reason ("not measured" needs a reason)`);
    return m;
  }
  if (typeof m.value !== 'number' || !Number.isFinite(m.value)) throw new Error(`value-report: ${where} value is not a number`);
  if (at !== m.value) throw new Error(`value-report: ${where} says ${m.value} but the raw data at ${m.raw.file}#${m.raw.pointer} says ${JSON.stringify(at)}`);
  if (typeof m.shown !== 'string' || !m.shown) throw new Error(`value-report: ${where} has no displayed value`);
  return m;
}

const rawLink = (m) => `[${m.raw.file}](value-report/${m.raw.file}) \`${m.raw.pointer}\``;
const CATEGORY_ORDER = ['Finds what you mean', 'Does not make things up', 'Speed', 'Space', 'Cost', 'Never loses a note', 'Keeps secrets out'];

/** Pure: raw JSON by name -> Markdown. Throws (writes nothing) if any metric breaks the rule. */
export function renderReport(rawData) {
  const metrics = buildMetrics(rawData);
  for (const m of metrics) assertMetric(m, rawData);
  const meta = rawData.meta ?? {};
  const sizes = (meta.sizes ?? []).map(sizeLabel).join(', ') || 'none';
  const L = [];
  L.push('# Value report', '');
  L.push('> Generated by `bench/value-report.mjs` from the raw data in [`docs/value-report/`](value-report/). Do not edit by hand: `test/value-report.test.mjs` re-renders this page from the raw data and fails on any difference.');
  L.push('> Synthetic data only: an invented demo team plus generated filler notes. Your notes will differ in size and wording, so read the numbers as what the machinery does, not as a promise about your memory.', '');
  L.push(`Measured at commit \`${meta.commit ?? 'unknown'}\`${meta.dirty ? ' (working tree dirty)' : ''} on ${meta.measuredAt ? meta.measuredAt.slice(0, 10) : 'an unknown date'}; sizes in this run: ${sizes}. Machine: ${meta.environment?.cpuModel ?? 'unknown CPU'} x ${meta.environment?.cpuCount ?? '?'}, Node ${meta.environment?.node ?? '?'}, load average at start ${meta.environment?.loadAvg1AtStart == null ? 'unknown' : Number(meta.environment.loadAvg1AtStart).toFixed(2)} (other work on the machine makes every time here slower than on an idle one).`, '');

  L.push('## What you get, in plain sentences', '');
  for (const cat of CATEGORY_ORDER) {
    const rows = metrics.filter((m) => m.category === cat && m.headline);
    if (!rows.length) continue;
    L.push(`### ${cat}`, '');
    for (const m of rows) {
      if (m.value === null) L.push(`- ${m.label}${m.size ? ` (${sizeLabel(m.size)} notes)` : ''}: **not measured** (${m.notMeasured}). Method: [${m.methodId}](#method). Raw: ${rawLink(m)}.`);
      else L.push(`- ${m.sentence} Method: [${m.methodId}](#method). Raw: ${rawLink(m)}.`);
    }
    L.push('');
  }

  L.push('## The numbers, per category', '');
  for (const cat of CATEGORY_ORDER) {
    const rows = metrics.filter((m) => m.category === cat);
    if (!rows.length) continue;
    const colSizes = [...new Set(rows.map((m) => m.size))].sort((a, b) => (a ?? 0) - (b ?? 0));
    const sized = colSizes.filter((s) => s != null);
    L.push(`### ${cat}`, '');
    const head = sized.length ? sized.map(sizeLabel) : [];
    L.push(`| What | ${[...head, ...(colSizes.includes(null) ? ['any size'] : [])].join(' | ')} | Method | Raw data |`);
    L.push(`|---|${[...head, ...(colSizes.includes(null) ? ['any size'] : [])].map(() => '---:').join('|')}|---|---|`);
    const byKey = new Map();
    for (const m of rows) { if (!byKey.has(m.key)) byKey.set(m.key, []); byKey.get(m.key).push(m); }
    for (const [, ms] of byKey) {
      const cell = (s) => { const m = ms.find((x) => x.size === s); return m ? (m.value === null ? 'not measured' : m.shown) : ''; };
      const cells = [...sized.map(cell), ...(colSizes.includes(null) ? [cell(null)] : [])];
      const first = ms[0];
      const tmpl = first.raw.pointer.replace(/\/sizes\/\d+\//, '/sizes/<size>/').replace(/\/(afterWrite|write)\/\d+\//, '/$1/<size>/');
      L.push(`| ${first.label.replace(/\|/g, '/')} | ${cells.join(' | ')} | [${first.methodId}](#method) | [${first.raw.file}](value-report/${first.raw.file}) \`${tmpl}\` |`);
    }
    L.push('');
  }

  L.push('## Method', '');
  const used = [...new Set(metrics.map((m) => m.methodId))];
  for (const id of Object.keys(METHODS)) if (used.includes(id)) L.push(`- **${id}.** ${METHODS[id]}`);
  L.push('');
  L.push('Known limits, stated once: the filler notes are short and use a small vocabulary, so "near" decoys that share a common word with thousands of notes are a hard case; the cold time includes the start of a Node process (see `bench/cold-find.json` for its share); the digest simulation assumes one call clears the pile; and a SIGKILL test shows what happens when a process dies, not when a disk fails.', '');

  L.push('## Raw data', '');
  for (const f of RAW_FILES) if (rawData[f]) L.push(`- [\`docs/value-report/${f}.json\`](value-report/${f}.json)`);
  L.push('', 'Re-measure: `node bench/value-report.mjs` (sizes 10k and 100k), or `node bench/value-report.mjs --sizes 1000000` for one larger size; add `--mutation` for the mutation score.', '');
  return `${L.join('\n')}`;
}

/** The short "What you get" table for README, between the markers. Pure. */
export function renderReadmeBlock(rawData) {
  const metrics = buildMetrics(rawData);
  for (const m of metrics) assertMetric(m, rawData);
  const sizes = rawData.meta?.sizes ?? [];
  const big = sizes.length ? Math.max(...sizes) : null;
  const pick = (key, size) => metrics.filter((m) => m.key === key && (size === undefined || m.size === size)).pop();
  const cell = (m) => (!m ? 'not measured' : m.value === null ? 'not measured' : m.shown);
  // The README keeps every latency in the perf block (test/readme-perf.test.mjs), so no milliseconds here.
  const rows = [
    ['Finds the note when you use its words (top 3)', pick('recall.keywords.at3', big)],
    ['Finds it when you ask in everyday words (top 3)', pick('recall.everyday.at3', big)],
    ['Answers when asked about something you never wrote (target 0%)', pick('decoy.far', big)],
    ['Slowdown of a fresh answer when the memory grows (see the latency table above for milliseconds)', pick('growth.coldMedian')],
    ['Disk per real-shaped note', pick('space.realBytesPerNote')],
    ['Model calls per day when idle', pick('cost.idle')],
    ['Model calls per day, typical day', pick('cost.typical')],
    ['Notes lost after killing the writer mid-write', pick('durability.lost')],
    ['Fake secrets kept out of the log file', pick('secrets.landed')],
    ['Security mutants caught by tests', pick('mutation.score')],
  ].filter(([, m]) => m);
  const L = [README_BEGIN, ''];
  L.push(`What you get, measured${big ? ` (memory of ${sizeLabel(big)} notes where size matters)` : ''}. Every row is generated by \`bench/value-report.mjs\` from raw data; method and links are in [docs/value-report.md](docs/value-report.md).`, '');
  L.push('| What you get | Measured |', '|---|---:|');
  for (const [label, m] of rows) L.push(`| ${label} | ${cell(m)} |`);
  L.push('', README_END);
  return L.join('\n');
}

export function applyToReadme(readme, rawData) {
  const i = readme.indexOf(README_BEGIN);
  const j = readme.indexOf(README_END);
  if (i < 0 || j < i) throw new Error('README has no value-report:begin/value-report:end markers');
  return readme.slice(0, i) + renderReadmeBlock(rawData) + readme.slice(j + README_END.length);
}

// --- raw files ---------------------------------------------------------

export function loadRaw(dir = RAW_DIR) {
  const out = {};
  for (const f of RAW_FILES) {
    const p = path.join(dir, `${f}.json`);
    if (fs.existsSync(p)) out[f] = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return out;
}
function writeRaw(dir, name, obj) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(obj, null, 2)}\n`);
}

// --- main ---------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child-writer') { childWriter(argv[1], argv[2]); return; }
  const flag = (k) => argv.includes(k);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const outDir = opt('--out', RAW_DIR);
  const reportPath = opt('--report', REPORT_FILE);

  if (flag('--render-only') || flag('--readme')) {
    const data = loadRaw(outDir);
    if (flag('--readme')) {
      const p = path.join(REPO, 'README.md');
      fs.writeFileSync(p, applyToReadme(fs.readFileSync(p, 'utf8'), data));
      console.log('README value-report block rendered from the raw data');
    } else {
      fs.writeFileSync(reportPath, renderReport(data));
      console.log(`${path.relative(REPO, reportPath)} rendered from the raw data`);
    }
    return;
  }

  if (flag('--mutation-only')) {
    // Only the mutation section (slow, several minutes): measure it, keep every other raw file as it is.
    const data = loadRaw(outDir);
    data.mutation = { ...stamp(), ...measureMutation({ run: true }) };
    const text = renderReport(data);
    writeRaw(outDir, 'mutation', data.mutation);
    fs.writeFileSync(reportPath, text);
    console.log(`mutation score written: ${data.mutation.state}`);
    return;
  }
  const sizes = opt('--sizes', DEFAULT_SIZES.join(',')).split(',').map(Number).filter(Boolean);
  const only = new Set(opt('--only', 'recall,speed,space,cost,durability,secrets').split(','));
  const o = {
    only, maxMs: Number(opt('--max-minutes', 30)) * 60000,
    coldRuns: Number(opt('--cold-runs', 24)), warmRuns: Number(opt('--warm-runs', 60)), rebuildRuns: Number(opt('--rebuild-runs', 5)),
  };
  const trials = Number(opt('--trials', 30));
  const st = stamp();
  const env = environment();
  const prev = loadRaw(outDir);
  const base = { ...st, sizes, environment: { cpuModel: env.cpuModel, cpuCount: env.cpuCount, node: env.node, totalMemMB: env.totalMemMB, loadAvg1AtStart: env.loadAvg1 ?? null } };

  const per = {};
  const needSizes = ['recall', 'speed', 'space'].some((k) => only.has(k));
  if (needSizes) for (const n of sizes) { process.stderr.write(`size ${sizeLabel(n)} ...\n`); per[n] = await measureSize(n, o); }

  const out = { ...prev };
  if (needSizes) out.meta = base;
  if (only.has('recall')) out.recall = { ...st, sizes: Object.fromEntries(sizes.map((n) => [n, per[n].recall])) };
  if (only.has('speed')) {
    const bySize = Object.fromEntries(sizes.map((n) => [n, per[n].speed]));
    out.speed = { ...st, queries: SCALE_QUERIES, sizes: bySize,
      firstSearch: Object.fromEntries(sizes.map((n) => [n, per[n].firstSearch])),
      afterWrite: Object.fromEntries(sizes.map((n) => [n, per[n].afterWrite])),
      write: Object.fromEntries(sizes.map((n) => [n, per[n].write])), growth: growth(bySize) };
  }
  if (only.has('space')) {
    process.stderr.write('space ...\n');
    const real = measureRealNoteBytes();
    const measured1M = sizes.includes(1000000);
    out.space = { ...st, sizes: Object.fromEntries(sizes.map((n) => [n, per[n].space])), realNotes: real,
      extrapolation: { basis: 'bytes per note times one million', measuredAt1M: measured1M, realNotesGB: round((real.bytesPerNote * 1e6) / 1e9, 3)} };
  }
  if (only.has('cost')) { process.stderr.write('cost ...\n'); out.cost = { ...st, ...measureCost() }; }
  if (only.has('durability')) { process.stderr.write('crash trials ...\n'); out.durability = { ...st, ...(await measureDurability({ trials })) }; }
  if (only.has('secrets')) { process.stderr.write('secrets ...\n'); out.secrets = { ...st, ...measureSecrets() }; }
  if (flag('--mutation')) { process.stderr.write('mutation (slow) ...\n'); out.mutation = { ...st, ...measureMutation({ run: true }) }; }
  else if (!out.mutation) out.mutation = { ...st, ...measureMutation({ run: false }) };

  const text = renderReport(out);   // throws before anything is written if a number breaks the rule
  for (const f of RAW_FILES) if (out[f]) writeRaw(outDir, f, out[f]);
  fs.writeFileSync(reportPath, text);
  console.log(`wrote ${path.relative(REPO, reportPath)} and the raw JSON files in ${path.relative(REPO, outDir)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { process.stderr.write(`${e.stack || e.message}\n`); process.exit(1); });
}
