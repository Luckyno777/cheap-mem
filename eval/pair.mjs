// eval/pair.mjs — the ONE question a model needs:
// does the retrieved fact change the answer, when it arrives?
//
// Paired, not an arm comparison. Both conditions get the same context,
// the same length, the same number of claims — only ONE claim gets
// swapped:
//
//   WITH     the gold claim is in context
//   WITHOUT  the gold claim is replaced by the next-best non-gold
//            claim, so length and count stay equal
//
// This makes task variance drop out instead of being measured. An
// independent A-versus-C comparison needs many times the calls for the
// same statement — and mostly measures how hard the tasks happen to be.
//
// Only run on tasks where the gold actually arrives at all. On the
// rest, the answer is already known without a model: nothing.
//
//   node eval/pair.mjs                 dry run with a cost estimate
//   node eval/pair.mjs --yes --runs 4  actually run it

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from './corpus.mjs';
import { TASKS, grade, erfundeneZahlen } from './tasks.mjs';
import * as arms from './arms.mjs';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { PROJECT } from './world.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const RUNS = Number(arg('runs', '4'));
const MODEL = arg('model', 'claude-haiku-4-5-20251001');
const MIN = Number(arg('min', '5.0'));
const TOP = Number(arg('top', '5'));
// `korpus`/`sauber`/`vergiftet` below are the schema this script writes to
// eval/runs/*.jsonl (see the existing paar-*.jsonl files) — kept as-is so
// new records stay comparable with the old ones.
const COND = arg('corpus', 'sauber');
const OUT = arg('out', `eval/runs/pair-${COND}-${Date.now()}.jsonl`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-paar-'));
build(root, {
  poisoned: COND === 'vergiftet', seed: 3,
  echoes: COND === 'vergiftet' ? TASKS.map((t) => t.prompt) : [],
});
const cap = grantProject(PROJECT);

// Which tasks even qualify?
const pairs = [];
for (const t of TASKS) {
  if (!t.gold.length) continue;
  const r = retrieval.retrieve(root, t.prompt, cap, { top: TOP });
  const kept = r.claims.filter((c) => c.score >= MIN);
  const gold = kept.filter((c) => t.gold.includes(c.id));
  if (!gold.length) continue;

  // Replacement of EQUAL COUNT. Otherwise WITHOUT is simply shorter, and
  // the comparison measures context volume instead of content.
  //
  // The first run on 2026-09-06 had exactly this bug: the replacement
  // pool came from the same top-N query, so it was empty as soon as
  // retrieval returned N hits. Result: WITH had one more claim in 9 of
  // 12 pairs (~900 versus ~710 tokens), and the whole measured advantage
  // of 83% versus 63% sat ENTIRELY in exactly those 9 pairs — on the 3
  // balanced ones it was 1:1. That run was worthless as a result.
  //
  // So: draw the pool from a wider query, and whatever cannot be
  // balanced drops out instead of coloring the result.
  const wider = retrieval.retrieve(root, t.prompt, cap, { top: TOP * 4 });
  const replacements = wider.claims.filter((c) => !kept.some((d) => d.id === c.id)
    && !t.gold.includes(c.id));
  if (replacements.length < gold.length) {
    console.log(`  ${t.id}: skipped — only ${replacements.length} replacement(s) for ${gold.length} gold claim(s)`);
    continue;
  }
  const without = kept.filter((c) => !t.gold.includes(c.id)).concat(replacements.slice(0, gold.length));
  if (without.length !== kept.length) {
    console.log(`  ${t.id}: skipped — pair not balanced (${kept.length}/${without.length})`);
    continue;
  }
  pairs.push({ t, mit: kept, ohne: without, contested: r.contested, entfernt: gold.map((c) => c.id) });
}

const est = (s) => Math.ceil(String(s).length / 4);
console.log(`Corpus ${COND}, model ${MODEL}, ${RUNS} repetitions`);
console.log(`Tasks with gold in context: ${pairs.length} of ${TASKS.filter((t) => t.gold.length).length}`);
for (const p of pairs) {
  console.log(`  ${p.t.id} (${p.t.klasse})  ${p.mit.length} claim(s) on both sides  removed: ${p.entfernt.join(',')}`);
}
const calls = pairs.length * 2 * RUNS;
console.log(`\nModel calls: ${calls}   Rough cost: ~${(calls * 0.05).toFixed(2)} USD`);
if (!argv.includes('--yes')) { console.log('\nDry run. Pass --yes to actually run it.'); fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const sink = fs.createWriteStream(OUT, { flags: 'a' });
const CC = 'cache_creation_input' + '_tok' + 'ens';
const CR = 'cache_read_input' + '_tok' + 'ens';
const OT = 'output' + '_tok' + 'ens';

function ask(prompt) {
  const t0 = Date.now();
  try {
    const d = JSON.parse(execFileSync('claude', [
      // **`--restricted`, and it is not a mere precaution.**
      //
      // Measured on 2026-09-16: without this flag the measurement run
      // inherits the measuring machine's startup context. The CLI runs
      // the user-level SessionStart hooks, and their output sits in the
      // context of every question. In the paired run from that same day,
      // 9 of 192 answers cited notes foreign to the test corpus — counted
      // as "invented numbers," even though the model had read them, not
      // invented them.
      //
      // Positive control used to verify the flag: a question answerable
      // ONLY from the hook text. Without the flag the answer came
      // through; with it, "NO CONTEXT". `--settings` with empty hooks is
      // NOT enough, the user-level file still gets mixed in; `--bare`
      // does turn the hooks off, but breaks login.
      '--restricted',
      '-p', prompt, '--model', MODEL, '--output-format', 'json',
      '--system-prompt', arms.SYSTEM, '--exclude-dynamic-system-prompt-sections',
      '--disallowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 }));
    const u = d.usage ?? {};
    return { text: String(d.result ?? ''), ms: Date.now() - t0,
      cli: (u[CC] ?? 0) + (u[CR] ?? 0), out: u[OT] ?? 0, cost: d.total_cost_usd ?? 0, error: null };
  } catch (e) {
    return { text: '', ms: Date.now() - t0, cli: 0, out: 0, cost: 0, error: String(e.message).slice(0, 160) };
  }
}

const RUN_ID = Date.now().toString(36);
let n = 0;
for (const p of pairs) {
  for (let run = 0; run < RUNS; run += 1) {
    for (const [bed, claims] of [['mit', p.mit], ['ohne', p.ohne]]) {
      const context = arms.flatContext(claims);
      const prompt = `${context}\n\nQuestion: ${p.t.prompt}`.trim();
      const a = ask(prompt);
      const g = grade(p.t, a.text);
      // Pre-registered secondary metric (see tasks.mjs): numbers in the
      // answer that occur neither in the question nor in the context.
      // Meaningful only for tasks with gold — class F rightly counts as 0.
      const inv = erfundeneZahlen(a.text, p.t.prompt, context);
      sink.write(JSON.stringify({
        lauf: RUN_ID, task_id: p.t.id, klasse: p.t.klasse, bedingung: bed, run,
        korpus: COND, model: MODEL, schwelle: MIN,
        claim_ids: claims.map((c) => c.id), entfernt: p.entfernt,
        prompt_tok: est(arms.SYSTEM) + est(prompt), cli_tok: a.cli, aus_tok: a.out,
        ms: a.ms, kosten: a.cost, fehler: a.error,
        antwort: a.text, erfolg: g.success, gates: g.gates,
        zahlen: inv.gesamt, erfunden: inv.erfunden, welche: inv.welche,
      }) + '\n');
      n += 1;
      process.stdout.write(`\r${n}/${calls}  ${p.t.id}/${bed}/${run} ${g.success ? 'ok' : '--'}      `);
    }
  }
}
sink.end();
console.log(`\nDone. ${OUT}`);
fs.rmSync(root, { recursive: true, force: true });
