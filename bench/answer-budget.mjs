// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/answer-budget.mjs - how big are the answers of the prompt hook and of the SubagentStart hook, and how
// often does the one budget (src/answerbudget.mjs, 3200 bytes) act?
//
//   node bench/answer-budget.mjs [--base <dir of an older tree>] [--questions N] [--seed S]
//
// **Honest about the data.** There is no real journal in this repository, so the sizes come from a SCRATCH memory the
// script builds in the temp directory: entries whose text length is spread between short and long, workflows with 2 to
// 40 steps, a few procedures, a skill offer. The spread is chosen to be wide, not copied from a user: the numbers say
// what the BUDGET does to such a spread (how many answers it touches, by how much), not what a real memory's answers
// weigh. The sibling house measured its own journal (question answers: p99 1,732 bytes; with the short-form lever at most
// about 1.3 KB of core; a workflow short card and a skill offer together under 1.5 KB) and took 3200 bytes as a ceiling
// above that; the figure here is the same ceiling, ported, and this script is the way to look at it on any memory
// (`--root <memory>` reads a real one instead, read-only).
//
// `--base <dir>` runs the same questions through an older tree (`<dir>/src/...`) so the two distributions stand side by
// side. Nothing is written to a real memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const arg = (name, d = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const N_Q = Number(arg('questions', 120));
let seed = Number(arg('seed', 1)) >>> 0;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

const WORDS = ['upload', 'retry', 'pause', 'deploy', 'release', 'branch', 'worktree', 'lockfile', 'cache', 'index', 'search', 'hook', 'journal',
  'server', 'socket', 'token', 'config', 'migration', 'backup', 'restore', 'timeout', 'queue', 'worker', 'schema', 'render', 'bridge', 'digest'];
const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const lengthOf = () => Math.round(40 * Math.exp(rnd() * Math.log(1200 / 40))); // log-uniform, 40..1200 characters

function buildMemory(dir, mem) {
  const run = (...a) => { const r = spawnSync(process.execPath, [mem, '--root', dir, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  run('init');
  for (let i = 0; i < 90; i += 1) {
    const kind = pick(['learning', 'learning', 'error', 'decision']);
    // One rare word per entry (`rareNN`), so a question that names it scores over the hook's bar, as a real question
    // that names a file or an identifier does.
    const text = `${sentence(6)} rare${i} ${sentence(Math.ceil(lengthOf() / 7))}`;
    if (kind === 'error') run('log', 'error', '--class', 'wrong-cause', '--title', `${sentence(3)} rare${i}`, '--text', text);
    else if (kind === 'decision') run('log', 'decision', '--topic', `${sentence(2)} rare${i}`, '--choice', sentence(5), '--why', text);
    else run('log', 'learning', '--title', `${sentence(3)} rare${i}`, '--text', text);
  }
  for (let i = 0; i < 6; i += 1) {
    const steps = 2 + Math.floor(rnd() * 39);
    const trig = `${WORDS[i * 3]} ${WORDS[i * 3 + 1]}`;
    const line = { id: `wfbench${i}`, ts: '2026-09-01T00:00:00Z', type: 'workflow', title: `Flow ${i} for ${trig}`,
      steps: Array.from({ length: steps }, (_, k) => `Step ${k}: ${sentence(8)}`), triggers: [trig], issued_by: 'owner' };
    fs.mkdirSync(path.join(dir, 'global'), { recursive: true });
    fs.appendFileSync(path.join(dir, 'global', 'workflows.jsonl'), `${JSON.stringify(line)}\n`);
  }
  for (const [i, size] of [[0, 120], [1, 600], [2, 1800]]) {
    run('log', 'procedure', '--title', `Rule ${i}`, '--rule', sentence(Math.ceil(size / 7)), '--issued-by', 'owner', '--tags', 'subagent-start', '--start-as', 'released');
  }
}

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const over = v.filter((x) => x > 3200).length;
  return { n: v.length, min: v[0], median: q(0.5), p90: q(0.9), p99: q(0.99), max: v[v.length - 1], over };
}

async function measure(codeDir, root, questions, label, marks) {
  const imp = (rel) => import(pathToFileURL(path.join(codeDir, 'src', rel)).href);
  const [search, recallhook, subagentstart, wd] = await Promise.all([imp('search.mjs'), imp('recallhook.mjs'), imp('subagentstart.mjs'), imp('workflowdetect.mjs')]);
  const index = search.loadIndex(root);
  const hookBytes = [];
  const withWorkflow = [];
  const texts = { hook: [], withWorkflow: [], start: [] };
  for (const q of questions) {
    const hits = search.search(index, q, { top: 3, noRaw: true, mmr: true, mmrLambda: 0.7 });
    const env = {};
    const r = recallhook.recall(root, JSON.stringify({ hits }), env, { offer: null });
    texts.hook.push(r.out?.hookSpecificOutput?.additionalContext ?? '');
    hookBytes.push(bytes(texts.hook.at(-1)));
    // The same turn with a workflow block from the question's triggers (the card as the detection hands it over).
    const w = await wd.forText(root, q, { session: `bench-${label}`, env: { MEM_WORKFLOW_MARKS: path.join(marks, label) } });
    const r2 = recallhook.recall(root, JSON.stringify({ hits }), { MEM_RH_WORKFLOW: w ? w.text : '' }, { offer: null });
    texts.withWorkflow.push(r2.out?.hookSpecificOutput?.additionalContext ?? '');
    withWorkflow.push(bytes(texts.withWorkflow.at(-1)));
  }
  const startBytes = [];
  for (const q of questions.slice(0, Math.min(questions.length, 60))) {
    const payload = JSON.stringify({ session_id: `bench-sub-${label}`, prompt: `Please work on this: ${q}` });
    const r = await subagentstart.hookResultFor(root, payload, { env: { MEM_WORKFLOW_MARKS: path.join(marks, label) } });
    texts.start.push(r?.hookSpecificOutput?.additionalContext ?? '');
    startBytes.push(bytes(texts.start.at(-1)));
  }
  return { hook: stats(hookBytes.filter((b) => b > 0)), hookWithWorkflow: stats(withWorkflow.filter((b) => b > 0)), subagentStart: stats(startBytes), texts };
}

const print = (label, s) => {
  const f = (o) => `n=${String(o.n).padStart(3)} min ${String(o.min).padStart(5)} median ${String(o.median).padStart(5)} p90 ${String(o.p90).padStart(5)} p99 ${String(o.p99).padStart(5)} max ${String(o.max).padStart(5)}  over 3200: ${o.over}`;
  console.log(`${label}`);
  console.log(`  prompt hook, hits only        ${f(s.hook)}`);
  console.log(`  prompt hook, with workflow    ${f(s.hookWithWorkflow)}`);
  console.log(`  subagent start                ${f(s.subagentStart)}`);
};

const realRoot = arg('root');
const dir = realRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cm-answer-budget-'));
const marks = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-answer-budget-marks-'));
try {
  if (!realRoot) buildMemory(dir, path.join(REPO, 'bin', 'mem'));
  // Questions: one to three of the rare words plus ordinary ones (and, for a part, a workflow's trigger words).
  const rareN = (k) => Array.from({ length: k }, () => `rare${Math.floor(rnd() * 90)}`).join(' ');
  const questions = Array.from({ length: N_Q }, (_, i) => `${sentence(2)} ${rareN(1 + (i % 3))} ${i % 4 === 0 ? `${WORDS[(i % 6) * 3]} ${WORDS[(i % 6) * 3 + 1]}` : sentence(1)}`);
  console.log(`corpus: ${realRoot ? `a real memory, read only (${dir})` : 'SCRATCH, synthetic (see the head of this file)'}; ${questions.length} questions; seed ${arg('seed', 1)}`);
  const base = arg('base');
  const before = base ? await measure(base, dir, questions, 'base', marks) : null;
  const after = await measure(REPO, dir, questions, 'new', marks);
  if (before) print(`BASE ${base}`, before);
  print('NEW', after);
  if (before) {
    // Texts that are not the same any more (the workflow marks differ per side, so a card may read as a pointer on one side only).
    const changed = (a, b) => a.reduce((n, t, i) => n + (t === b[i] ? 0 : 1), 0);
    console.log(`answers that differ from the base: hits only ${changed(before.texts.hook, after.texts.hook)} of ${after.texts.hook.length}, `
      + `with workflow ${changed(before.texts.withWorkflow, after.texts.withWorkflow)} of ${after.texts.withWorkflow.length}, `
      + `subagent start ${changed(before.texts.start, after.texts.start)} of ${after.texts.start.length}`);
  }
} finally {
  fs.rmSync(marks, { recursive: true, force: true });
  if (!realRoot) fs.rmSync(dir, { recursive: true, force: true });
}
