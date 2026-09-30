// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/warm-recall.mjs — latency of the recall server per question, with
// and without the in-process index memo (cold-path work, 2026-09-30).
//
// Per corpus size (bench/scale.mjs, seed 42): a real server child process
// (src/recallserver.mjs), questions over its Unix socket, per-question
// round trip measured. Two modes:
//   nomemo  the M10 server as it was: `setProcessMemo(false)` right after
//           start, so every question loads the index from the cache
//   memo    the server as it is now (memo on)
// The first question of a run is reported apart (`firstMs`: it pays the
// load in either mode); `p50Ms`/`p95Ms` are over the questions after it.
// RSS is the server child's VmRSS after the last question.
//
//   node bench/warm-recall.mjs --sizes 2000,20000 --questions 30
// Put the corpora somewhere with room: TMPDIR=<dir>. The socket goes to a
// short directory of its own (a Unix socket path is limited to ~100 bytes).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildCorpus } from './scale.mjs';
import * as place from '../src/recallserver-place.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const QUERIES = ['rate limiter latency', 'cache invalidation bug', 'retry backoff timeout', 'schema migration rollback'];

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

function ask(root, key, sock, query) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(`${JSON.stringify({ v: place.VERSION, key, root, query, top: '5', deadline_ms: Date.now() + 600000 })}\n`));
    c.on('data', (s) => { buf += s; });
    c.on('error', reject);
    c.on('end', () => { try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); } });
  });
}

const rssMb = (pid) => {
  try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024); } catch { return null; }
};

async function run(root, mode, questions, sockDir) {
  const env = { ...process.env, MEM_RECALL_SERVER_DIR: sockDir };
  const after = mode === 'nomemo' ? 'import(' + JSON.stringify(path.join(CODE, 'src', 'search.mjs')) + ').then((s) => s.setProcessMemo(false))' : 'Promise.resolve()';
  const kid = spawn(process.execPath, ['--max-old-space-size=8192', '-e', `
    import(${JSON.stringify(path.join(CODE, 'src', 'recallserver.mjs'))}).then((r) => r.start(${JSON.stringify(root)}))
      .then(async (x) => { if (!x.running) process.exit(1); await ${after}; process.on('SIGTERM', () => x.close().then(() => process.exit(0))); });
  `], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  kid.stderr.on('data', (s) => { err += s; });
  const until = Date.now() + 20000;
  while (!/listening on/.test(err) && Date.now() < until && kid.exitCode == null) await new Promise((r) => setTimeout(r, 25));
  if (!/listening on/.test(err)) throw new Error(`server did not start: ${err}`);
  await new Promise((r) => setTimeout(r, 200));
  const where = place.place(root, env);
  const key = fs.readFileSync(where.key, 'utf8').trim();
  const ms = [];
  try {
    for (let i = 0; i < questions; i += 1) {
      const t = performance.now();
      const a = await ask(root, key, where.socket, QUERIES[i % QUERIES.length]);
      if (!a.ok) throw new Error(`question ${i} answered ${a.reason}`);
      ms.push(performance.now() - t);
    }
    const rss = rssMb(kid.pid);
    const rest = ms.slice(1).sort((a, b) => a - b);
    return { mode, questions, firstMs: Math.round(ms[0]), p50Ms: +pct(rest, 50).toFixed(1), p95Ms: +pct(rest, 95).toFixed(1), rssMb: rss };
  } finally {
    const gone = new Promise((r) => kid.once('exit', r));
    kid.kill('SIGTERM');
    await gone;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const sizes = opt('--sizes', '2000,20000,200000').split(',').map(Number);
  const questions = Number(opt('--questions', 30));
  const slow = Number(opt('--questions-slow', 12));   // the nomemo mode pays a load per question
  const out = [];
  for (const n of sizes) {
    process.stderr.write(`corpus ${n} ...\n`);
    const { root } = buildCorpus(n);
    const sockDir = fs.mkdtempSync('/tmp/wr-');
    try {
      const prime = spawnSync(process.execPath, [MEM, '--root', root, 'find', QUERIES[0]], { encoding: 'utf8', maxBuffer: 1 << 28 });
      if (prime.status !== 0) throw new Error(`prime run failed: ${prime.stderr.slice(0, 200)}`);
      for (const mode of ['nomemo', 'memo']) {
        process.stderr.write(`  ${mode} ...\n`);
        out.push({ entries: n, ...(await run(root, mode, mode === 'nomemo' ? slow : questions, sockDir)) });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sockDir, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ node: process.version, cpus: os.cpus().length, results: out }, null, 2));
}

main().catch((e) => { process.stderr.write(`${e.stack || e.message}\n`); process.exit(1); });
