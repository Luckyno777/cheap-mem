// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-gemini-cm): bench/expand-fair/run.mjs with
// the Gemini-written questions (bench/expand-gemini/questions.jsonl) as the
// only question set. Store build, expansions and the traced `mem find` call
// are the same code as expand-fair's run.
//   node bench/expand-gemini/run.mjs <notes> <out.json>
// MEM_EXPAND=1 (+ MEM_EXPAND_WEIGHT) switches expansions on: every gold note
// gets its hand-written asked_as, every filler note its composed one.
// Every question/decoy goes through the real `mem find --json --weak` with
// MEM_FAIR_TRACE=1, so the H3 gate's inputs come back and the gate can be
// replayed offline (analyze.mjs) with the shipped or a recalibrated row.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCorpus } from '../scale.mjs';
import { loadWorld } from '../gold-compare.mjs';
import * as memory from '../../src/memory.mjs';
import { goldAskedAs, fillerAskedAs, fillerClass } from '../expand-fair/expand.mjs';
import { loadQuestions } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const [nArg, outFile] = process.argv.slice(2);
const n = Number(nArg);
const EXPAND = process.env.MEM_EXPAND === '1';
const jl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const t0 = Date.now();
const world = loadWorld();
const { root } = buildCorpus(Math.max(0, n - world.entries.length));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-home-'));
try {
  // Filler: classes for lenient judging, and expansions when on.
  const classOf = new Map(); const members = new Map();
  for (const f of fs.readdirSync(path.join(root, 'global'))) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(root, 'global', f);
    const rows = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    for (const e of rows) {
      const k = fillerClass(e); classOf.set(e.id, k);
      if (!members.has(k)) members.set(k, []); members.get(k).push(e.id);
      if (EXPAND) e.asked_as = fillerAskedAs(e);
    }
    if (EXPAND) fs.writeFileSync(p, rows.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify(world.config ?? {}));
  for (const row of world.entries) {
    const a = EXPAND ? goldAskedAs(row.data?.id) : null;
    memory.logEntry(root, row.type, a ? { ...row.data, asked_as: a } : row.data, { project: row.project ?? null, now: new Date(row.at) });
  }
  const env = { ...process.env, HOME: home, MEM_FAIR_TRACE: '1' };
  delete env.CHEAP_MEM_ROOT;
  const argsOf = (q) => {
    const a = [path.join(REPO, 'bin', 'mem'), '--root', root, 'find', q.query, '--json', '--top', '10', '--weak'];
    if (q.project) a.push('--project', q.project);
    if (q.asOf) a.push('--as-of', q.asOf);
    return a;
  };
  const warm = spawnSync(process.execPath, argsOf({ query: 'warm the index' }), { cwd: root, env, encoding: 'utf8', timeout: 3600_000 });
  if (warm.status !== 0) throw new Error(`warm-up find failed: ${warm.stderr}`);
  const buildMs = Date.now() - t0;

  const ask = (q) => new Promise((resolve) => {
    const c = spawn(process.execPath, argsOf(q), { cwd: root, env });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      if (code !== 0) return resolve({ unknown: `exit ${code}: ${err.split('\n')[0].slice(0, 160)}` });
      try {
        const j = JSON.parse(out);
        resolve({ hits: j.hits.map((h) => ({ id: h.entry?.id ?? null, score: h.score, covered: h.covered ?? null, exact: h.exact ?? null })), trace: j.fairTrace });
      } catch (e) { resolve({ unknown: `bad json: ${e.message}` }); }
    });
  });
  const items = loadQuestions().map((q) => ({ set: 'gm', ...q }));
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = { ...items[i], answer: await ask(items[i]) }; } };
  await Promise.all([worker(), worker(), worker()]);
  // Lenient target set for filler questions: every note of the same class.
  for (const r of results) {
    if (r.src === 'filler') r.accept = members.get(classOf.get(r.expected[0])) ?? r.expected;
  }
  fs.writeFileSync(outFile, JSON.stringify({ n, expand: EXPAND, weight: EXPAND ? Number(process.env.MEM_EXPAND_WEIGHT ?? 0.3) : null, buildMs, totalMs: Date.now() - t0, results }));
  console.log(`n=${n} expand=${EXPAND} ${results.length} asked in ${Math.round((Date.now() - t0) / 1000)} s`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
