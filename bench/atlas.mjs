#!/usr/bin/env node
// bench/atlas.mjs — the full-surface atlas: one run, every phase, one report.
//
//     node bench/atlas.mjs                      # everything, ~10 min
//     node bench/atlas.mjs --quick              # smaller corpora, ~2 min
//     node bench/atlas.mjs --phase surface,load # only these
//     node bench/atlas.mjs --compare <old.json> # what changed since then
//     node bench/atlas.mjs --out <dir>          # where to write
//
// **Why this exists next to the other two dozen benches.** They are each
// honest about one question and print for themselves. What was missing is a
// single run with one record shape, so that "is this memory getting better
// or worse" stops being a matter of opinion. Every record carries the same
// four fields — what was expected, what was measured, which of the four
// verdicts, and the evidence — and the whole run serialises to JSON that a
// later run can be diffed against.
//
// **What it deliberately does NOT do.** It does not grade. There is no
// overall score, because a single number is exactly what lets a bad result
// hide behind a good average, and because the thresholds that would
// produce it are the most arguable part of any benchmark. The report
// prints expectation and measurement side by side and leaves the judgement
// where it belongs.
//
// **The fourth verdict is the point.** `not-measured` is not a pass. A
// harness that quietly skips what it cannot reach hands out a clean bill of
// health for a system it never looked at — and this house has a name for
// that, because it has shipped it more than once.
//
// **Do not read a green run as "no problems".** Read it as "no problems
// among the checks that ran", and then read the blind-spot list, which is
// printed by name and never summarised away.

import fs from 'node:fs';
import path from 'node:path';
import {
  Atlas, VERDICT, REPO, writeOut, nodeStartupMs,
} from './atlas/core.mjs';

// The phases, in the order they run. A phase is a module exporting
// `run(atlas, options)`. Missing modules are recorded as blind spots rather
// than skipped, so a half-built atlas reports itself as half-built.
const PHASES = [
  ['surface', './atlas/phase-surface.mjs', 'Every command, actually executed'],
  ['load', './atlas/phase-load.mjs', 'Scale, latency and whether the right answer survives it'],
  ['doctor', './atlas/phase-doctor.mjs', 'The state ladder: which findings can fail at all'],
  ['defence', './atlas/phase-defence.mjs', 'Neutralisation coverage, flooding curve, tamper detection'],
  ['robust', './atlas/phase-robust.mjs', 'Broken state and concurrent writers'],
  ['ceiling', './atlas/phase-ceiling.mjs', 'Where this design stops working, and why'],
  ['register', './atlas/phase-register.mjs', 'The register prototype (sqlite+FTS5) against today\'s linear scan'],
  ['real', './atlas/phase-real.mjs', 'The same measurements against a real, grown memory'],
];

// `real` reads the sister house (lucky-mem), which holds someone's actual
// memory. It measures distributions and never carries entry text into a
// record — the phase enforces that itself. Skip it with
// `--phase surface,load,doctor,defence,robust,ceiling` on a machine where
// that house is not present; the runner then records it as a blind spot by
// name, which is the honest outcome, rather than quietly running five
// phases and calling the run complete.

function parseArgs(argv) {
  const o = {
    quick: false, out: null, compare: null, saveBaseline: false,
    phases: PHASES.map(([id]) => id), label: 'full',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--quick') { o.quick = true; o.label = 'quick'; } else if (a === '--out') { o.out = argv[++i]; } else if (a === '--save-baseline') { o.saveBaseline = true; } else if (a === '--compare') {
      // Bare `--compare` means "against the committed baseline", which
      // is the comparison anybody actually wants; a following path only
      // counts if it is not the next flag.
      o.compare = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : BASELINE;
    } else if (a === '--phase' || a === '--phases') {
      o.phases = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
      o.label = o.phases.join('+');
    } else if (a === '--label') { o.label = argv[++i]; } else if (a === '--help' || a === '-h') { o.help = true; }
  }
  return o;
}

// The one committed artefact: the run a later run measures itself
// against. Everything else a run writes is working output and ignored.
const BASELINE = path.join(REPO, 'bench', 'atlas-baseline.json');

const HELP = `mem atlas — full-surface benchmark

  node bench/atlas.mjs [--quick] [--phase a,b] [--out DIR] [--label NAME]
  node bench/atlas.mjs --compare [FILE]     default: bench/atlas-baseline.json
  node bench/atlas.mjs --save-baseline      also write bench/atlas-baseline.json

Phases: ${PHASES.map(([id]) => id).join(', ')}

Writes atlas.json, report.md, records.csv and findings.json into
bench/atlas-out/<timestamp>-<label>/, which is ignored. The committed
baseline that later runs compare against lives at bench/atlas-baseline.json
and is written by --save-baseline; nothing writes it by accident, because a
baseline that moves on every run compares a thing to itself.
`;

// --- comparing two runs ------------------------------------------------
//
// The reason the schema is versioned and the corpus seed is fixed: so that
// a difference between two runs is a difference in the code. When the
// machine block differs, it is not, and this says so rather than printing a
// regression that is really a different CPU.

function compare(oldPath, current) {
  const before = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  const L = [];
  L.push(`# atlas comparison\n`);
  L.push(`| | before | now |`);
  L.push(`|---|---|---|`);
  L.push(`| run | ${before.startedAt} | ${current.startedAt} |`);
  L.push(`| commit | ${before.environment?.gitCommit ?? '?'} | ${current.environment?.gitCommit ?? '?'} |`);
  L.push(`| node | ${before.environment?.node} | ${current.environment?.node} |`);
  L.push(`| cpu | ${before.environment?.cpuModel ?? '?'} | ${current.environment?.cpuModel ?? '?'} |`);
  L.push('');

  const sameMachine = before.environment?.cpuModel === current.environment?.cpuModel
    && before.environment?.node === current.environment?.node;
  if (!sameMachine) {
    L.push('> **Different machine or Node version.** Timing differences below are '
      + 'not evidence of a code change. Verdict changes still are.');
    L.push('');
  }
  if (before.schemaVersion !== current.schemaVersion) {
    L.push(`> **Schema changed** (v${before.schemaVersion} -> v${current.schemaVersion}). `
      + 'Records may not line up; treat missing entries as "not comparable", not as removed.');
    L.push('');
  }

  const flat = (r) => {
    const m = new Map();
    for (const p of r.phases ?? []) for (const rec of p.records) m.set(`${p.id}/${rec.id}`, rec);
    return m;
  };
  const a = flat(before); const b = flat(current);
  const changed = []; const added = []; const gone = [];
  for (const [k, rec] of b) {
    if (!a.has(k)) { added.push(k); continue; }
    const was = a.get(k);
    if (was.verdict !== rec.verdict || String(was.actual) !== String(rec.actual)) {
      changed.push({ k, was, now: rec });
    }
  }
  for (const k of a.keys()) if (!b.has(k)) gone.push(k);

  L.push(`## Verdict and value changes (${changed.length})`);
  L.push('');
  if (changed.length) {
    L.push('| check | was | now | was measured | now measured |');
    L.push('|---|---|---|---|---|');
    for (const c of changed) {
      L.push(`| ${c.k} | ${c.was.verdict} | ${c.now.verdict} | `
        + `${String(c.was.actual).slice(0, 60)} | ${String(c.now.actual).slice(0, 60)} |`);
    }
  } else L.push('None.');
  L.push('');
  L.push(`## New checks (${added.length})`);
  L.push('');
  L.push(added.length ? added.map((k) => `- ${k}`).join('\n') : 'None.');
  L.push('');
  L.push(`## Checks that disappeared (${gone.length})`);
  L.push('');
  if (gone.length) {
    L.push('A check that vanished between runs is not an improvement. Either it '
      + 'was renamed, or something stopped being measured.');
    L.push('');
    L.push(gone.map((k) => `- ${k}`).join('\n'));
  } else L.push('None.');
  L.push('');
  return L.join('\n');
}

// --- main ---------------------------------------------------------------

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) { process.stdout.write(HELP); return 0; }

  const atlas = new Atlas({ label: opt.label });

  process.stderr.write('atlas: measuring bare node startup ... ');
  const startup = nodeStartupMs();
  process.stderr.write(`${startup.toFixed(1)} ms p50\n`);

  for (const [id, mod, title] of PHASES) {
    if (!opt.phases.includes(id)) continue;
    const abs = path.join(REPO, 'bench', mod.replace('./', ''));
    if (!fs.existsSync(abs)) {
      // Not silently skipped. A phase that is not built yet is a hole in
      // this run, and the report must say so by name.
      atlas.phase(id, title, '**This phase did not run: its module is not present.**');
      atlas.record({
        id: `${id}.module-present`,
        title: `phase module ${mod} exists`,
        verdict: VERDICT.NOT_MEASURED,
        expected: 'present',
        actual: 'missing',
        evidence: abs,
      });
      atlas.blind(`phase "${id}" (${title})`, `module ${mod} not present in this checkout`);
      continue;
    }
    process.stderr.write(`atlas: phase ${id} ...\n`);
    const t0 = Date.now();
    try {
      const m = await import(abs);
      if (typeof m.run !== 'function') throw new Error('module exports no run()');
      await m.run(atlas, { quick: opt.quick });
    } catch (e) {
      // A phase that throws has not passed. It is recorded as a failure of
      // the harness, with the stack, and the run continues — one broken
      // phase must not cost the measurements of the other four.
      if (!atlas.current || atlas.current.id !== id) atlas.phase(id, title);
      atlas.record({
        id: `${id}.phase-crashed`,
        title: `phase ${id} ran to completion`,
        verdict: VERDICT.FAIL,
        expected: 'phase completes',
        actual: `threw: ${e && e.message}`,
        evidence: String(e && e.stack).slice(0, 4000),
      });
    }
    process.stderr.write(`atlas: phase ${id} done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  }

  const result = atlas.finish({ options: { quick: opt.quick, phases: opt.phases } });
  result.environment.nodeStartupMsP50 = startup;

  const stamp = result.startedAt.replace(/[:.]/g, '-').replace(/Z$/, '');
  const outDir = opt.out ?? path.join(REPO, 'bench', 'atlas-out', `${stamp}-${opt.label}`);
  writeOut(result, outDir);

  if (opt.compare && !fs.existsSync(opt.compare)) {
    process.stdout.write(`\natlas: no baseline at ${path.relative(REPO, opt.compare)} — `
      + 'nothing to compare against. Write one with --save-baseline.\n');
  } else if (opt.compare) {
    const text = compare(opt.compare, result);
    fs.writeFileSync(path.join(outDir, 'comparison.md'), text);
    process.stdout.write(`\n${text}\n`);
  }

  const c = result.counts;
  process.stdout.write('\n');
  process.stdout.write(`atlas ${result.label}: `
    + `${c.pass} pass, ${c.fail} fail, ${c.degraded} degraded, `
    + `${c['not-measured']} NOT MEASURED\n`);
  if (result.blindSpots.length) {
    process.stdout.write(`${result.blindSpots.length} blind spot(s) — `
      + 'listed by name in the report; a green run is not a clean bill of health '
      + 'for what was never looked at.\n');
  }
  for (const f of result.findings.filter((x) => x.severity === 'critical')) {
    process.stdout.write(`  CRITICAL  ${f.phase}/${f.id}  ${f.title}\n`);
  }
  process.stdout.write(`report: ${path.relative(REPO, outDir)}/report.md\n`);

  // Deliberately last, and only on request: a baseline that rewrites
  // itself on every run turns every comparison into "this run equals
  // this run", which is the quietest way for a benchmark to stop saying
  // anything at all.
  if (opt.saveBaseline) {
    fs.writeFileSync(BASELINE, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`baseline: ${path.relative(REPO, BASELINE)} (committed artefact, now this run)\n`);
  }

  // Exit code carries meaning, like the rest of this CLI:
  //   0  everything that ran, passed
  //   1  something failed or degraded
  //   3  nothing failed, but something could not be measured
  // 3 is deliberately NOT 0. "I could not check" is its own answer.
  if (c.fail > 0 || c.degraded > 0) return 1;
  if (c['not-measured'] > 0) return 3;
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`atlas: ${e && e.stack}\n`);
  process.exitCode = 1;
});
