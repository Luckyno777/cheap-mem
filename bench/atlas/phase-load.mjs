// bench/atlas/phase-load.mjs — scale, latency, and whether the right
// answer survives the growth.
//
// **What this phase is for, and why it is not bench/scale.mjs.**
// `bench/scale.mjs` measured on 2026-09-05 that search is linear: 1k ->
// 0.785 ms p50, 10k -> 7.4 ms, 100k -> 114 ms, 1M -> 1.77 s. Two things
// are missing from that number, and both of them are what a user actually
// pays.
//
//   1. It imports `buildIndex`/`search` DIRECTLY. Node startup, `loadIndex`
//      from the cache, the cache write, `requireConfig` and `findRoot` are
//      all invisible — and together they are an order of magnitude larger
//      than the search itself. That total is the latency the retrieval hook
//      pays on every single prompt. Here everything is measured through
//      `mem()`, as a real child process, exactly as a user or a hook runs it.
//   2. It only times. A benchmark that only times confirms the code: it
//      cannot say whether the answer that came back was the right one. So
//      the second half of this phase asks, at every corpus size, whether
//      the anchor — an entry carrying a phrase that exists nowhere else —
//      is still returned, and where.
//
// **Four verdicts.** A cell that could not be run is `not-measured` and is
// named in the blind-spot list. Percentiles taken from fewer than five runs
// are reported as `null`, not as a number that looks like a distribution:
// the expensive commands here cost tens of seconds per call, and pretending
// a p99 exists after one sample is the same lie as an empty green.
//
// **Every threshold is named in the record it decides**, so a later reader
// can disagree with the threshold without re-deriving the measurement.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VERDICT, SEVERITY, mem, buildCorpus, tempRoot, pct, dirBytes,
  cacheExists, cacheBytes, removeCacheDir,
} from './core.mjs';

// --- thresholds, in the open ------------------------------------------
//
// These are the arguable part. They are constants with names so that a
// disagreement is a one-line change and shows up in a diff, rather than a
// magic number buried in a comparison.

/** Growth exponent above which a command is recorded as DEGRADED. */
const EXP_DEGRADED = 1.3;
/** Growth exponent above which a command is recorded as FAIL. */
const EXP_FAIL = 1.8;
/**
 * Below this many timed runs, p95/p99 are reported as null.
 *
 * Nearest-rank percentiles over four samples return the maximum for both
 * p95 and p99 — a number that looks like a tail and is only the slowest of
 * four. The commands that hit this floor are exactly the slow ones, which
 * is the honest reason to leave the cell empty rather than fill it.
 */
const PERCENTILE_FLOOR = 5;
/**
 * Per-cell wall-clock budget and repetition ceiling, per mode.
 *
 * The full run has twelve minutes and the quick run three, and the quick
 * run's job is to be runnable, not to have a tail. So `quick` buys fewer
 * repetitions rather than fewer measurements: every check still runs, and
 * the ones whose percentiles fall below the floor say so.
 */
const TUNING = {
  full: { cellBudgetMs: 6000, maxReps: 7 },
  quick: { cellBudgetMs: 2500, maxReps: 5 },
};

/**
 * How far recall@3 may fall between the smallest and the largest corpus
 * before the drop is recorded as a degradation.
 *
 * Only for the DILUTED query forms. For the bare anchor phrase the
 * threshold is absolute and stated by the task: recall@3 below 1.0 is a
 * FAIL, because the phrase occurs exactly once in the corpus.
 */
const RECALL_DROP_DEGRADED = 0.1;

// --- shared query material --------------------------------------------

/**
 * The one question both `find` and `retrieve` are asked, at every size.
 *
 * Common words on purpose: a rare identifier answers from the exact lane
 * and never touches the ranking, so it would time the wrong path. This is
 * shaped like what an agent actually asks.
 */
const WORK_QUERY = 'deploy database cache';

/** Queries used for the tie measurement. All common words, all match wide. */
const TIE_QUERIES = [
  'deploy database', 'cache memory session', 'error timeout retry',
  'index search ranking', 'config branch commit', 'probe guard boundary',
  'latency throughput budget', 'agent skill procedure',
  'entry corpus token', 'archive digest inbox',
  'capability redaction boundary', 'commit merge test',
];

/**
 * The noise words a diluted anchor question carries.
 *
 * The bare anchor phrase is a single rare token and is answered by the
 * exact lane, so it measures almost nothing about ranking. A real question
 * is a sentence: one distinctive word surrounded by words the whole corpus
 * shares. `noise(k)` is that sentence with k shared words in it.
 */
const NOISE_WORDS = ['deploy', 'database', 'memory', 'cache', 'session', 'index'];
function noise(k) { return NOISE_WORDS.slice(0, k).join(' '); }

/** The three question shapes asked at every corpus size. */
const QUERY_FORMS = [
  { key: 'bare', noiseWords: 0, why: 'the anchor phrase alone — the exact lane answers it' },
  { key: 'diluted3', noiseWords: 3, why: 'the phrase plus three words the whole corpus shares' },
  { key: 'diluted5', noiseWords: 5, why: 'the phrase plus five words the whole corpus shares' },
];

// --- small helpers -----------------------------------------------------

/** Choose a repetition count that fits one cell inside its budget. */
function repsFor(oneRunMs, tuning) {
  if (!Number.isFinite(oneRunMs) || oneRunMs <= 0) return tuning.maxReps;
  return Math.max(1, Math.min(tuning.maxReps, Math.floor(tuning.cellBudgetMs / oneRunMs)));
}

/**
 * Time one CLI command as a real process, with an adaptive repeat count.
 *
 * One probe run first: it both warms whatever the command caches and tells
 * us how many repetitions the budget allows. Normally the probe is thrown
 * away — the first call after a corpus change pays for the index build,
 * and mixing that into p50 measures the build, not the command.
 *
 * **Except when the budget allows exactly one run.** Then discarding the
 * probe would mean paying twice for a single sample, and for `viewer` at
 * 20k that is two minutes for one number. In that case the probe IS the
 * sample, and `probeIsSample` says so in the record — the reader can see
 * that this one cell may carry a cold cache.
 */
function timeCli(args, root, tuning, { timeoutMs = 900000 } = {}) {
  const probe = mem(args, { root, timeoutMs });
  const n = repsFor(probe.ms, tuning);
  const probeIsSample = n === 1;
  const runs = [];
  let last = probe;
  if (probeIsSample) {
    runs.push(probe.ms);
  } else {
    for (let i = 0; i < n; i += 1) {
      last = mem(args, { root, timeoutMs });
      runs.push(last.ms);
    }
  }
  const sorted = [...runs].sort((a, b) => a - b);
  const enough = n >= PERCENTILE_FLOOR;
  return {
    command: args.join(' '),
    n,
    probeIsSample,
    probeMs: +Number(probe.ms).toFixed(1),
    min: sorted[0] ?? null,
    p50: pct(sorted, 50),
    // Not a number that looks like a tail when it is only the slowest of
    // three. Three states, not two: measured, or explicitly not measured.
    p95: enough ? pct(sorted, 95) : null,
    p99: enough ? pct(sorted, 99) : null,
    max: sorted[sorted.length - 1] ?? null,
    percentilesFrom: enough ? n : null,
    bytes: last?.bytes ?? null,
    status: last?.status ?? null,
    stderr: (last?.stderr ?? '').slice(0, 200) || null,
  };
}

/** log(t2/t1) / log(n2/n1) — the growth exponent between two stages. */
function exponent(t1, n1, t2, n2) {
  if (!(t1 > 0) || !(t2 > 0) || !(n1 > 0) || !(n2 > 0) || n1 === n2) return null;
  return Math.log(t2 / t1) / Math.log(n2 / n1);
}

function round(v, d = 2) {
  return (v === null || v === undefined || !Number.isFinite(v)) ? null : +v.toFixed(d);
}

/** The corpus ladder. Fixed seed, so two runs are comparable at all. */
function ladder(quick) {
  return quick
    ? [{ n: 500, label: '500' }, { n: 2000, label: '2k' }]
    : [{ n: 1000, label: '1k' }, { n: 5000, label: '5k' }, { n: 20000, label: '20k' }];
}

/** `find --json --brief` for one query; null when the call did not work. */
function briefHits(root, query, top = 10) {
  const r = mem(['find', query, '--json', '--brief', '--top', String(top)],
    { root, timeoutMs: 900000 });
  if (r.status !== 0) return { error: `exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`, hits: null };
  try {
    return { error: null, hits: JSON.parse(r.stdout).hits ?? [], ms: r.ms };
  } catch (e) {
    return { error: `unparsable stdout: ${String(e.message).slice(0, 120)}`, hits: null };
  }
}

/** The UTC day an ISO timestamp falls on, as an integer. */
function utcDay(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? Math.floor(t / 86400000) : null;
}

// --- the phase ---------------------------------------------------------

export async function run(atlas, { quick = false } = {}) {
  const stages = ladder(quick);
  const tuning = quick ? TUNING.quick : TUNING.full;
  const outDir = tempRoot('atlas-load-out-');
  const phaseT0 = Date.now();
  const loadAtStart = os.loadavg()[0];

  atlas.phase('load',
    'Scale, latency and whether the right answer survives it',
    [
      `Corpora ${stages.map((s) => s.label).join(' / ')}, fixed seed 42, anchors included.`,
      '',
      'Every latency here is a **whole process**: Node startup, `findRoot`,',
      '`requireConfig`, `loadIndex` from the cache and the command itself.',
      'That is what the retrieval hook pays per prompt, and it is between one',
      'and two orders of magnitude above the in-process search time that',
      '`bench/scale.mjs` reports.',
      '',
      `Repetitions per cell are adaptive: as many as fit in ${tuning.cellBudgetMs} ms,`,
      `at most ${tuning.maxReps}. Where fewer than ${PERCENTILE_FLOOR} runs fit, p95 and`,
      'p99 are `null` rather than the slowest of three dressed up as a tail.',
      '',
      `Growth exponent = log(t2/t1)/log(n2/n1) over the outer two stages.`,
      `Above ${EXP_DEGRADED} is recorded DEGRADED, above ${EXP_FAIL} FAIL.`,
      'Both thresholds are constants at the top of this module, named so a',
      'later reader can disagree with them without re-deriving anything.',
    ].join('\n'));

  // Built once per stage and shared by A, B, C and D. D runs last inside a
  // stage because it deletes the cache; everything before it wants it warm.
  const corpora = [];
  for (const s of stages) {
    const root = tempRoot(`atlas-load-${s.label}-`);
    const c = buildCorpus(root, s.n, { seed: 42, anchors: 12 });
    corpora.push({ ...s, root, corpus: c });
  }

  // =====================================================================
  // A — the scaling curve
  // =====================================================================

  const COMMANDS = [
    // The floor first, and it is not decoration.
    //
    // `mem version` touches no log. Whatever it costs is what EVERY other
    // row below also pays before its own work begins: Node startup, module
    // loading, argument parsing. Over a ladder that starts at 1k entries
    // that floor is most of the cheap commands' latency, and an exponent
    // computed on the raw number therefore comes out SUBLINEAR while the
    // work inside is perfectly linear. So every exponent below is reported
    // twice: raw, which is what a user waits, and net of this floor, which
    // is what the code does.
    ['floor', () => ['version']],
    ['find', () => ['find', WORK_QUERY, '--top', '10']],
    ['retrieve', () => ['retrieve', WORK_QUERY, '--json']],
    ['context', () => ['context']],
    ['core', () => ['core']],
    ['experiences', () => ['experiences']],
    ['topics', () => ['topics']],
    ['facts', () => ['facts']],
    ['board', () => ['board']],
    ['doctor', () => ['doctor']],
    ['viewer', (label) => ['viewer', '--out', path.join(outDir, `viewer-${label}.html`)]],
  ];

  /** cell[command][stageLabel] = timing record */
  const cells = {};
  for (const [name] of COMMANDS) cells[name] = {};

  for (const st of corpora) {
    // One warm-up call per corpus, outside any measurement, so the index
    // cache exists before the first timed command. Otherwise whichever
    // command happens to run first is charged for the whole build.
    mem(['find', 'warmup'], { root: st.root, timeoutMs: 900000 });
    for (const [name, mk] of COMMANDS) {
      try {
        cells[name][st.label] = timeCli(mk(st.label), st.root, tuning);
      } catch (e) {
        cells[name][st.label] = { error: String(e.message).slice(0, 200) };
      }
    }
  }

  const first = corpora[0];
  const last = corpora[corpora.length - 1];

  /** p50 with the process floor of the same stage taken off. */
  const net = (name, label) => {
    const c = cells[name][label];
    const f = cells.floor[label];
    if (!c || c.p50 == null || !f || f.p50 == null) return null;
    return c.p50 - f.p50;
  };

  for (const [name] of COMMANDS) {
    const a = cells[name][first.label];
    const b = cells[name][last.label];
    const ok = a && b && a.p50 > 0 && b.p50 > 0;
    if (!ok) {
      atlas.record({
        id: `load.a.${name}`,
        title: `${name}: growth from ${first.label} to ${last.label}`,
        verdict: VERDICT.NOT_MEASURED,
        expected: `exponent <= ${EXP_DEGRADED}`,
        actual: 'no usable timing at one or both ends',
        measured: cells[name],
      });
      atlas.blind(`growth exponent for \`mem ${name}\``,
        `no usable p50 at ${first.label} and/or ${last.label}`);
      continue;
    }
    const e = exponent(a.p50, first.corpus.count, b.p50, last.corpus.count);
    const na = net(name, first.label);
    const nb = net(name, last.label);
    const eNet = name === 'floor' ? null
      : exponent(na, first.corpus.count, nb, last.corpus.count);
    // The verdict follows the NET exponent where one exists: the raw
    // number flatters every cheap command, because a fixed ~130 ms of
    // process startup divided into a growing total always looks sublinear.
    // Judging on the flattering number is how a linear scan passes for
    // free.
    const forVerdict = eNet ?? e;
    const verdict = forVerdict === null ? VERDICT.NOT_MEASURED
      : forVerdict > EXP_FAIL ? VERDICT.FAIL
        : forVerdict > EXP_DEGRADED ? VERDICT.DEGRADED
          : VERDICT.PASS;
    atlas.record({
      id: `load.a.${name}`,
      title: `${name}: growth exponent ${first.label} -> ${last.label}`,
      verdict,
      // The threshold travels WITH the record, in words, because this is
      // the number a later reader is most likely to want to argue with.
      expected: `n^1 or better on the exponent net of the process floor; `
        + `DEGRADED above ${EXP_DEGRADED}, FAIL above ${EXP_FAIL}`,
      actual: `raw n^${round(e)}, ${name === 'floor' ? 'itself the floor'
        : eNet === null
          // Not "n^0": the command simply costs no more than starting the
          // process does, so there is nothing left to take an exponent of.
          ? 'net of floor: not separable at this ladder — the command costs '
            + 'no measurably more than starting the process'
          : `net of floor n^${round(eNet)}`} `
        + `(${round(a.p50, 1)} ms -> ${round(b.p50, 1)} ms `
        + `over ${first.corpus.count} -> ${last.corpus.count} entries)`,
      severity: verdict === VERDICT.FAIL ? SEVERITY.MAJOR : SEVERITY.MINOR,
      ms: round(b.p50, 1),
      measured: {
        exponentRaw: round(e, 3),
        exponentNetOfProcessFloor: round(eNet, 3),
        judgedOn: eNet === null ? 'raw' : 'net',
        netMsFirst: round(na, 1),
        netMsLast: round(nb, 1),
        thresholds: { degradedAbove: EXP_DEGRADED, failAbove: EXP_FAIL },
        stages: cells[name],
      },
      evidence: stages.map((s) => {
        const c = cells[name][s.label];
        return c && c.p50 != null
          ? `${s.label}: p50 ${round(c.p50, 1)} ms, p95 ${c.p95 === null ? 'n/a' : round(c.p95, 1)}`
            + `, ${c.bytes} B out, n=${c.n}`
          : `${s.label}: not measured`;
      }).join('\n'),
    });
  }

  // Cells whose percentiles were not taken are named, not dropped.
  const thin = [];
  for (const [name] of COMMANDS) {
    for (const s of stages) {
      const c = cells[name][s.label];
      if (c && c.p50 != null && c.percentilesFrom === null) thin.push(`${name}@${s.label} (n=${c.n})`);
    }
  }
  if (thin.length) {
    atlas.blind('p95/p99 for the slow cells',
      `fewer than ${PERCENTILE_FLOOR} runs fit the ${tuning.cellBudgetMs} ms cell budget: `
      + thin.join(', '));
  }

  // --- 2. find against retrieve, same question -------------------------
  //
  // `retrieval.mjs` loops over `authority.TIERS` and calls `search()` once
  // per tier — six full document scans for one question. This is the path
  // every agent prompt takes.

  for (const st of corpora) {
    const f = cells.find[st.label];
    const r = cells.retrieve[st.label];
    if (!f?.p50 || !r?.p50) {
      atlas.record({
        id: `load.a.ratio.${st.label}`,
        title: `retrieve / find on the same question at ${st.label}`,
        verdict: VERDICT.NOT_MEASURED,
        expected: 'a ratio',
        actual: 'one of the two has no p50',
      });
      continue;
    }
    const ratio = r.p50 / f.p50;
    // Six tiers, six scans. Anything at or below ~1.5x would mean the loop
    // is not what it looks like; the stated expectation is the documented
    // structure, and the measurement says how much of it is real.
    atlas.record({
      id: `load.a.ratio.${st.label}`,
      title: `retrieve costs N x find on the same question (${st.label})`,
      verdict: ratio > 6 ? VERDICT.FAIL : ratio > 2 ? VERDICT.DEGRADED : VERDICT.PASS,
      expected: 'at most 2x (DEGRADED above 2x, FAIL above 6x = one full scan per authority tier)',
      actual: `${round(ratio)}x (${round(f.p50, 1)} ms -> ${round(r.p50, 1)} ms)`,
      severity: SEVERITY.MAJOR,
      ms: round(r.p50, 1),
      measured: {
        query: WORK_QUERY, findP50: round(f.p50, 1), retrieveP50: round(r.p50, 1),
        ratio: round(ratio, 3), tiers: 6,
        note: 'src/retrieval.mjs calls search() once per authority tier',
      },
    });
  }

  // --- 3. viewer against topic count, corpus size held near-fixed ------
  //
  // `src/viewer.mjs` calls `memory.topicState()` per topic, and each of
  // those reads the whole corpus through `topicEntries()`. The cost is
  // therefore topics x entries. The A ladder above already shows the
  // exponent against n — but there topics and entries grow together, so it
  // cannot say WHICH factor is responsible. This does: the base corpus is
  // held at one size and only the number of distinct topics is raised.

  try {
    const BASE = quick ? 1000 : 2000;
    const extras = quick ? [0, 200, 600] : [0, 200, 400, 800];
    const points = [];
    for (const extra of extras) {
      const root = tempRoot('atlas-load-topics-');
      buildCorpus(root, BASE, { seed: 42, anchors: 12 });
      if (extra) {
        const lines = [];
        for (let i = 0; i < extra; i += 1) {
          lines.push(JSON.stringify({
            id: `x${i.toString(36)}`,
            ts: '2026-03-01T00:00:00Z',
            topic: `extratopic/${i}`,
            choice: 'a', why: 'a topic that exists so the count can be raised',
            title: `extratopic ${i}`,
            text: 'deploy cache index entry',
          }));
        }
        fs.appendFileSync(path.join(root, 'global', 'decisions.jsonl'), `${lines.join('\n')}\n`);
      }
      mem(['find', 'warmup'], { root, timeoutMs: 900000 });
      const t = mem(['topics'], { root, timeoutMs: 900000 });
      const topics = Number((t.stdout.match(/^(\d+) topics/m) || [])[1] ?? NaN);
      const v = mem(['viewer', '--out', path.join(outDir, `topics-${extra}.html`)],
        { root, timeoutMs: 900000 });
      points.push({
        extraTopics: extra,
        entries: BASE + 12 + extra,
        topics: Number.isFinite(topics) ? topics : null,
        viewerMs: v.ms,
        topicsCmdMs: t.ms,
        viewerStatus: v.status,
      });
    }
    const p0 = points[0];
    const pN = points[points.length - 1];
    const eTopics = (p0.topics && pN.topics)
      ? exponent(p0.viewerMs, p0.topics, pN.viewerMs, pN.topics) : null;
    // Two models, and the measurement picks between them.
    //
    //   entriesOnly  the viewer reads the corpus a fixed number of times.
    //                Then raising the topic count costs nothing beyond the
    //                few extra entries that carry the new topics.
    //   product      the viewer reads the corpus once PER TOPIC. Then the
    //                time ratio is the product of both growth ratios.
    //
    // Naming both, and the tolerance around each, is what makes this a
    // check rather than a number to nod at.
    const entriesOnly = pN.entries / p0.entries;
    const predicted = (p0.topics && pN.topics)
      ? (pN.topics / p0.topics) * entriesOnly : null;
    const observed = pN.viewerMs / p0.viewerMs;
    atlas.record({
      id: 'load.a.viewer-topics',
      title: 'viewer cost follows topics x entries, not entries alone',
      verdict: predicted === null ? VERDICT.NOT_MEASURED
        : observed <= entriesOnly * 1.5 ? VERDICT.PASS
          : observed >= predicted / 2 ? VERDICT.FAIL : VERDICT.DEGRADED,
      expected: 'raising only the topic count should cost about what the extra '
        + `entries cost (x${round(entriesOnly)}); PASS below x${round(entriesOnly * 1.5)}, `
        + 'FAIL at or above half the topics x entries product — that is the '
        + 'signature of one full corpus read per topic',
      actual: predicted === null ? 'topic count unreadable'
        : `topics x${round(pN.topics / p0.topics)}, entries x${round(entriesOnly)}, `
          + `product model predicts x${round(predicted)}, observed x${round(observed)} `
          + `(${round(p0.viewerMs, 0)} ms -> ${round(pN.viewerMs, 0)} ms)`,
      severity: SEVERITY.MAJOR,
      ms: round(pN.viewerMs, 0),
      measured: {
        points,
        exponentAgainstTopicCount: round(eTopics, 3),
        note: 'entries held near-fixed; `mem topics` itself stays flat, which '
          + 'rules out topic ENUMERATION and leaves topicState() per topic',
      },
      evidence: points.map((p) => `${p.topics} topics, ${p.entries} entries: `
        + `viewer ${round(p.viewerMs, 0)} ms, topics ${round(p.topicsCmdMs, 0)} ms`).join('\n'),
    });
  } catch (e) {
    atlas.record({
      id: 'load.a.viewer-topics',
      title: 'viewer cost against topic count',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'a curve against topic count',
      actual: `threw: ${String(e.message).slice(0, 200)}`,
    });
    atlas.blind('viewer against topic count', String(e.message).slice(0, 200));
  }

  // =====================================================================
  // B — does the right answer survive the growth?
  // =====================================================================

  const recall = {};   // recall[form][label] = {...}
  for (const form of QUERY_FORMS) recall[form.key] = {};

  const anchorBudget = 8;

  for (const st of corpora) {
    const anchors = st.corpus.anchors.slice(0, anchorBudget);
    for (const form of QUERY_FORMS) {
      const ranks = [];
      let failed = 0;
      for (const a of anchors) {
        const q = form.noiseWords ? `${a.query} ${noise(form.noiseWords)}` : a.query;
        const res = briefHits(st.root, q, 10);
        if (res.hits === null) { failed += 1; continue; }
        const idx = res.hits.findIndex((h) => h.id === a.id);
        ranks.push(idx === -1 ? null : idx + 1);   // null = not in the top 10 at all
      }
      const found = ranks.filter((r) => r !== null);
      const N = ranks.length || 1;
      recall[form.key][st.label] = {
        asked: ranks.length,
        callsFailed: failed,
        'recall@1': +(ranks.filter((r) => r === 1).length / N).toFixed(4),
        'recall@3': +(ranks.filter((r) => r !== null && r <= 3).length / N).toFixed(4),
        'recall@10': +(ranks.filter((r) => r !== null && r <= 10).length / N).toFixed(4),
        meanRank: found.length ? +(found.reduce((x, y) => x + y, 0) / found.length).toFixed(2) : null,
        // Not folded into meanRank as "11" or "99": an answer that never
        // came back has no rank, and inventing one flatters the mean.
        notInTop10: ranks.filter((r) => r === null).length,
        ranks,
      };
    }
  }

  for (const form of QUERY_FORMS) {
    const rows = stages.map((s) => ({ label: s.label, ...recall[form.key][s.label] }));
    const usable = rows.filter((r) => r.asked > 0);
    if (!usable.length) {
      atlas.record({
        id: `load.b.recall.${form.key}`,
        title: `anchor recall under load (${form.key})`,
        verdict: VERDICT.NOT_MEASURED,
        expected: 'recall at every corpus size',
        actual: 'no query returned usable JSON',
      });
      atlas.blind(`anchor recall, ${form.key} form`, 'no usable JSON from `mem find --json --brief`');
      continue;
    }
    const r3 = usable.map((r) => r['recall@3']);
    const worst = Math.min(...r3);
    const drop = r3[0] - r3[r3.length - 1];

    if (form.key === 'bare') {
      // The task's own criterion, and it is not a matter of taste: the
      // phrase occurs exactly once in the whole corpus.
      atlas.record({
        id: 'load.b.recall.bare',
        title: 'anchor with its unique phrase is still returned at every size',
        verdict: worst < 1 ? VERDICT.FAIL : VERDICT.PASS,
        expected: 'recall@3 = 1.0 at every corpus size — the phrase exists exactly '
          + 'once, so anything below 1.0 is a wrong answer, not a preference',
        actual: usable.map((r) => `${r.label}: @1=${r['recall@1']} @3=${r['recall@3']} `
          + `meanRank=${r.meanRank}`).join('; '),
        severity: SEVERITY.CRITICAL,
        measured: { form: form.why, stages: recall[form.key] },
      });
    } else {
      atlas.record({
        id: `load.b.recall.${form.key}`,
        title: `anchor recall when the question also carries ${form.noiseWords} shared words`,
        verdict: worst === 0 ? VERDICT.FAIL
          : drop > RECALL_DROP_DEGRADED ? VERDICT.DEGRADED : VERDICT.PASS,
        expected: `recall@3 must not fall as the corpus grows; DEGRADED if it drops `
          + `by more than ${RECALL_DROP_DEGRADED} between the smallest and the largest `
          + `corpus, FAIL if it reaches 0 anywhere`,
        actual: usable.map((r) => `${r.label}: @1=${r['recall@1']} @3=${r['recall@3']} `
          + `@10=${r['recall@10']} meanRank=${r.meanRank} lost=${r.notInTop10}/${r.asked}`).join('; '),
        severity: worst === 0 ? SEVERITY.CRITICAL : SEVERITY.MAJOR,
        measured: {
          form: form.why,
          dropSmallestToLargest: round(drop, 4),
          stages: recall[form.key],
        },
        evidence: `query shape: "<anchor phrase> ${noise(form.noiseWords)}"`,
      });
    }
  }

  // --- where the cliff is ----------------------------------------------
  //
  // The three forms above show a collapse somewhere between three and five
  // shared words. Sharper: at one corpus size, walk k and record the
  // largest k at which the anchor is still first. That number — how many
  // ordinary words a question may carry before the one distinctive word in
  // it stops deciding — is the single most useful thing this phase learned.

  try {
    const mid = corpora[Math.floor(corpora.length / 2)];
    const anchors = mid.corpus.anchors.slice(0, quick ? 4 : 6);
    const ks = quick ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6];
    const ladderRows = [];
    for (const k of ks) {
      let hitsAt1 = 0;
      let asked = 0;
      for (const a of anchors) {
        const q = k ? `${a.query} ${noise(k)}` : a.query;
        const res = briefHits(mid.root, q, 10);
        if (res.hits === null) continue;
        asked += 1;
        if (res.hits[0]?.id === a.id) hitsAt1 += 1;
      }
      ladderRows.push({ noiseWords: k, asked, 'recall@1': asked ? +(hitsAt1 / asked).toFixed(3) : null });
    }
    const lastGood = [...ladderRows].reverse().find((r) => r['recall@1'] === 1);
    const tolerance = lastGood ? lastGood.noiseWords : null;
    atlas.record({
      id: 'load.b.dilution-tolerance',
      title: `how many shared words a question may carry before the unique word stops winning (${mid.label})`,
      verdict: tolerance === null ? VERDICT.FAIL
        : tolerance >= ks[ks.length - 1] ? VERDICT.PASS : VERDICT.DEGRADED,
      expected: 'a word that occurs exactly once in the corpus should decide the '
        + 'answer whatever else is in the question; DEGRADED below 6 shared words, '
        + `FAIL if even the bare phrase does not win; the ladder here stops at `
        + `${ks[ks.length - 1]} shared words, so a PASS means "not lost within the ladder"`,
      actual: tolerance === null
        ? 'the anchor is not first even with no noise at all'
        : `first place survives up to ${tolerance} shared words, and is lost at ${tolerance + 1}`,
      severity: SEVERITY.MAJOR,
      measured: {
        corpus: mid.label, entries: mid.corpus.count, anchors: anchors.length,
        ladder: ladderRows,
        cause: 'src/search.mjs multiplies the score by (covered/typed)**coverage; '
          + 'the anchor covers one typed word of k+1, the corpus covers k',
      },
      evidence: ladderRows.map((r) => `${r.noiseWords} shared words: recall@1 = ${r['recall@1']}`).join('\n'),
    });
  } catch (e) {
    atlas.record({
      id: 'load.b.dilution-tolerance',
      title: 'dilution tolerance of the unique phrase',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'the largest k at which recall@1 is still 1.0',
      actual: `threw: ${String(e.message).slice(0, 200)}`,
    });
    atlas.blind('dilution tolerance', String(e.message).slice(0, 200));
  }

  // =====================================================================
  // C — how many top-10 places are decided by a tie instead of a score
  // =====================================================================
  //
  // Since commit 1e1a738 the recency bonus is computed in whole UTC days.
  // Two entries from the same day therefore get exactly the same factor,
  // and if their BM25 scores also agree the order is decided by
  // `stableKey` — a fixed identity, not relevance.
  //
  // Two things are counted, because they answer two different questions:
  //   ties        adjacent hits whose scores agree to the last bit. This
  //               is the literal question: how many places are handed to
  //               identity.
  //   flatRecency adjacent hits that fall on the same UTC day, or that are
  //               both stamped in the future (the `ageDays >= 0` guard
  //               gives every future entry the factor 1.0 exactly). For
  //               those pairs the recency bonus contributed NOTHING to the
  //               comparison, whether or not the totals happened to tie.

  // Fewer queries in quick mode; the same queries, not different ones, so
  // the quick number is a subset of the full one rather than another thing.
  const tieQueries = quick ? TIE_QUERIES.slice(0, 8) : TIE_QUERIES;
  const tieRows = [];
  for (const st of corpora) {
    let pairs = 0; let tied = 0; let sameDay = 0; let bothFuture = 0; let slots = 0;
    let futureSlots = 0;
    let queriesUsed = 0;
    const today = Math.floor(Date.now() / 86400000);
    for (const q of tieQueries) {
      const res = briefHits(st.root, q, 10);
      if (res.hits === null || res.hits.length < 2) continue;
      queriesUsed += 1;
      const h = res.hits;
      slots += h.length;
      for (const x of h) { if ((utcDay(x.ts) ?? -1) > today) futureSlots += 1; }
      for (let i = 1; i < h.length; i += 1) {
        pairs += 1;
        if (h[i].score === h[i - 1].score) tied += 1;
        const d1 = utcDay(h[i - 1].ts); const d2 = utcDay(h[i].ts);
        if (d1 !== null && d2 !== null) {
          if (d1 === d2) sameDay += 1;
          if (d1 > today && d2 > today) bothFuture += 1;
        }
      }
    }
    tieRows.push({
      label: st.label,
      entries: st.corpus.count,
      queriesUsed,
      adjacentPairs: pairs,
      tiedPairs: tied,
      tiedShare: pairs ? +(tied / pairs).toFixed(4) : null,
      sameUtcDayPairs: sameDay,
      bothFutureStampedPairs: bothFuture,
      recencyContributedNothingShare: pairs ? +((sameDay + bothFuture) / pairs).toFixed(4) : null,
      top10Slots: slots,
      futureStampedSlots: futureSlots,
    });
  }

  const worstTie = Math.max(...tieRows.map((r) => r.tiedShare ?? 0));
  atlas.record({
    id: 'load.c.tied-places',
    title: 'share of adjacent top-10 places decided by a bit-identical score',
    verdict: tieRows.every((r) => r.adjacentPairs === 0) ? VERDICT.NOT_MEASURED
      : worstTie > 0.2 ? VERDICT.FAIL
        : worstTie > 0 ? VERDICT.DEGRADED : VERDICT.PASS,
    expected: 'no top-10 place decided by `stableKey` instead of by relevance; '
      + 'DEGRADED above 0 share, FAIL above 0.2',
    actual: tieRows.map((r) => `${r.label}: ${r.tiedPairs}/${r.adjacentPairs} = ${r.tiedShare}`).join('; '),
    severity: SEVERITY.MAJOR,
    measured: { rows: tieRows, queries: tieQueries },
    evidence: 'src/search.mjs:579,640 — byScoreThenIdentity falls back to '
      + 'stableKey(source:line) when scores agree to the last bit.',
  });

  atlas.record({
    id: 'load.c.flat-recency',
    title: 'share of adjacent top-10 places where the recency bonus contributed nothing',
    // A pure measurement of exposure: how much of the top-10 ordering the
    // day-granular recency bonus cannot reach at all. There is no honest
    // threshold for it, so — following the apparatus — the expectation is
    // `null` and the verdict is `not-measured`. That keeps it visible as
    // something still owed instead of dressing a number up as a pass.
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: tieRows.map((r) => `${r.label}: ${r.recencyContributedNothingShare} of pairs `
      + `(${r.futureStampedSlots}/${r.top10Slots} slots are future-stamped and get factor 1.0)`).join('; '),
    measured: { rows: tieRows },
    evidence: 'src/search.mjs:865 — ageDays is floor(now/86400000) - floor(ts/86400000), '
      + 'and the `ageDays >= 0` guard drops the bonus entirely for future stamps. '
      + 'buildCorpus spreads timestamps across all of 2026, so a large part of '
      + 'the corpus is future-dated relative to the run.',
  });

  // --- same day against ninety days ------------------------------------
  //
  // The same corpus twice, byte for byte identical apart from `ts`: once
  // with every entry on one UTC day (every recency factor equal, so the
  // bonus can break no tie) and once spread over ninety days in the past
  // (every factor distinct). The difference in recall@3 is what the day
  // granularity costs, or does not cost.

  try {
    const N = quick ? 1500 : 5000;
    const variants = [];
    for (const mode of ['same-day', 'spread-90d']) {
      const root = tempRoot(`atlas-load-${mode}-`);
      const c = buildCorpus(root, N, { seed: 42, anchors: 12 });
      restamp(c.dir, mode);
      // The cache was written against the old stamps. It is keyed on file
      // size and mtime, and a rewrite can leave the size identical — so
      // the cache is removed rather than trusted to notice. B8
      // (2026-09-20) moved the cache from a single file to a directory of
      // shards (`CACHE_DIR`); removing the whole directory is the
      // directory-shaped equivalent of the old `fs.rmSync(file, { force
      // })`. Before this fix, this line targeted the retired single-file
      // path, which never exists post-B8 — the `force: true` swallowed
      // the resulting ENOENT silently, so the real cache (at `CACHE_DIR`)
      // was never actually cleared and this scenario ran against a STALE
      // cache keyed on the pre-restamp mtimes, exactly the confound this
      // line exists to remove.
      removeCacheDir(root);
      mem(['find', 'warmup'], { root, timeoutMs: 900000 });
      const anchors = c.anchors.slice(0, quick ? 6 : 8);
      // Diluted, not bare: with the bare phrase only one document matches
      // at all, so no ordering happens and no tie can show.
      let at1 = 0; let at3 = 0; let asked = 0;
      for (const a of anchors) {
        const res = briefHits(root, `${a.query} ${noise(3)}`, 10);
        if (res.hits === null) continue;
        asked += 1;
        const rank = res.hits.findIndex((h) => h.id === a.id) + 1;
        if (rank === 1) at1 += 1;
        if (rank >= 1 && rank <= 3) at3 += 1;
      }
      let pairs = 0; let tied = 0;
      for (const q of tieQueries) {
        const res = briefHits(root, q, 10);
        if (res.hits === null) continue;
        for (let i = 1; i < res.hits.length; i += 1) {
          pairs += 1;
          if (res.hits[i].score === res.hits[i - 1].score) tied += 1;
        }
      }
      variants.push({
        mode,
        entries: c.count,
        asked,
        'recall@1': asked ? +(at1 / asked).toFixed(4) : null,
        'recall@3': asked ? +(at3 / asked).toFixed(4) : null,
        adjacentPairs: pairs,
        tiedPairs: tied,
        tiedShare: pairs ? +(tied / pairs).toFixed(4) : null,
      });
    }
    const [same, spread] = variants;
    const diff = (same['recall@3'] === null || spread['recall@3'] === null)
      ? null : +(spread['recall@3'] - same['recall@3']).toFixed(4);
    atlas.record({
      id: 'load.c.same-day-vs-spread',
      title: 'recall@3 with every entry on one UTC day against ninety days of spread',
      verdict: diff === null ? VERDICT.NOT_MEASURED
        : Math.abs(diff) > RECALL_DROP_DEGRADED ? VERDICT.DEGRADED : VERDICT.PASS,
      expected: `the day-granular recency bonus should not change which entry `
        + `answers a question; DEGRADED if recall@3 differs by more than `
        + `${RECALL_DROP_DEGRADED} between the two stampings`,
      actual: diff === null ? 'one variant produced no usable answers'
        : `same-day recall@3 ${same['recall@3']}, spread recall@3 ${spread['recall@3']}, `
          + `difference ${diff}; tied places ${same.tiedShare} vs ${spread.tiedShare}`,
      severity: SEVERITY.MINOR,
      measured: { variants, differenceInRecall3: diff, corpusSize: N },
      evidence: 'Identical corpus, identical seed; only the ts fields differ. '
        + 'same-day: every entry on one UTC day, so every recency factor is equal '
        + 'and the bonus can break no tie. spread-90d: ninety distinct days in the '
        + 'past, so every factor differs.',
    });
  } catch (e) {
    atlas.record({
      id: 'load.c.same-day-vs-spread',
      title: 'recall with same-day against spread timestamps',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'a difference in recall@3',
      actual: `threw: ${String(e.message).slice(0, 200)}`,
    });
    atlas.blind('same-day against spread-90d recall', String(e.message).slice(0, 200));
  }

  // =====================================================================
  // D — cold start against warm
  // =====================================================================
  //
  // Runs last, because it deletes the index cache of every corpus. The
  // difference is what a fresh process pays when the cache is not there —
  // which is what happens after every append past
  // CACHE_WRITE_AFTER_BYTES, and on the first call in a new checkout.

  const coldRows = [];
  for (const st of corpora) {
    const row = { label: st.label, entries: st.corpus.count };
    row.corpusBytes = dirBytes(path.join(st.root, 'global'));
    for (const [name, args] of [
      ['find', ['find', WORK_QUERY, '--top', '10']],
      ['retrieve', ['retrieve', WORK_QUERY, '--json']],
    ]) {
      try {
        removeCacheDir(st.root);
        const cold = mem(args, { root: st.root, timeoutMs: 900000 });
        // `null`, not 0, when there is no cache to size — "not
        // measurable is not zero" applies here too: a cache that was
        // never written and a cache that is genuinely empty are
        // different facts, and only `cacheExists` can tell them apart.
        const cacheBytesNow = cacheExists(st.root) ? cacheBytes(st.root) : null;
        const warm = timeCli(args, st.root, tuning);
        row[`${name}ColdMs`] = round(cold.ms, 1);
        row[`${name}WarmP50Ms`] = round(warm.p50, 1);
        row[`${name}WarmN`] = warm.n;
        row[`${name}PenaltyMs`] = round(cold.ms - warm.p50, 1);
        row[`${name}ColdStatus`] = cold.status;
        if (name === 'find') row.cacheBytes = cacheBytesNow;
      } catch (e) {
        row[`${name}Error`] = String(e.message).slice(0, 160);
      }
    }
    coldRows.push(row);
  }

  // Kept as part of the measured block, not as a verdict input.
  const penalties = coldRows.map((r) => r.findPenaltyMs).filter((v) => v != null);
  atlas.record({
    id: 'load.d.cold-start',
    title: 'what a fresh process pays when the index cache is not there',
    // A measurement, not a grade: the right size for this penalty depends
    // on how often the cache is missing, and this phase does not measure
    // that. No expectation, therefore `not-measured` — the number stands,
    // the judgement is not claimed.
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: coldRows.map((r) => `${r.label}: find +${r.findPenaltyMs} ms, `
      + `retrieve +${r.retrievePenaltyMs} ms, cache ${r.cacheBytes} B`).join('; '),
    measured: { rows: coldRows, findPenaltiesMs: penalties },
    evidence: 'Cold = the search-index cache directory (`CACHE_DIR`, `src/search.mjs`) '
      + 'removed immediately before the run, so the process pays the full build AND '
      + 'the cache write. Warm = the same command with the cache in place.',
  });

  // The cache file itself, per stage — the thing that has to be read and
  // parsed before any answer can be given.
  const cacheGrowth = coldRows.filter((r) => r.cacheBytes);
  if (cacheGrowth.length >= 2) {
    const a = cacheGrowth[0]; const b = cacheGrowth[cacheGrowth.length - 1];
    const e = exponent(a.cacheBytes, a.entries, b.cacheBytes, b.entries);
    atlas.record({
      id: 'load.d.cache-size',
      title: 'index cache file size against corpus size',
      verdict: e === null ? VERDICT.NOT_MEASURED
        : e > EXP_DEGRADED ? VERDICT.DEGRADED : VERDICT.PASS,
      expected: `cache bytes should grow no faster than n^1; DEGRADED above ${EXP_DEGRADED}`,
      actual: `n^${round(e)} (${cacheGrowth.map((r) => `${r.label}: `
        + `${(r.cacheBytes / 1048576).toFixed(2)} MB`).join(', ')})`,
      severity: SEVERITY.MINOR,
      measured: {
        rows: cacheGrowth.map((r) => ({
          label: r.label,
          entries: r.entries,
          corpusBytes: r.corpusBytes,
          cacheBytes: r.cacheBytes,
          cachePerEntryBytes: Math.round(r.cacheBytes / r.entries),
          cacheToCorpusRatio: +(r.cacheBytes / r.corpusBytes).toFixed(2),
        })),
        exponent: round(e, 3),
      },
    });
  } else {
    atlas.record({
      id: 'load.d.cache-size',
      title: 'index cache file size against corpus size',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'a cache size at two or more stages',
      actual: `${cacheGrowth.length} stage(s) produced a cache file`,
    });
    atlas.blind('index cache growth', 'fewer than two stages produced a readable cache file');
  }

  // --- was the machine ours while this ran? -----------------------------
  //
  // Every number above is wall-clock time from a child process. On a busy
  // four-core runner that is a measurement of the queue as much as of the
  // code — and a latency table taken under contention, presented without
  // saying so, is how a "regression" gets chased for a day. So the load is
  // recorded at both ends and the reader is told which kind of number this
  // is, rather than being left to assume the good kind.

  const loadAtEnd = os.loadavg()[0];
  const cores = os.cpus().length;
  const contended = Math.max(loadAtStart, loadAtEnd) > cores * 0.75;
  atlas.record({
    id: 'load.env.contention',
    title: 'the machine was not shared while these latencies were taken',
    verdict: contended ? VERDICT.DEGRADED : VERDICT.PASS,
    expected: `1-minute load average below ${(cores * 0.75).toFixed(2)} `
      + `(three quarters of ${cores} cores) at both ends of the phase`,
    actual: `load ${loadAtStart.toFixed(2)} at start, ${loadAtEnd.toFixed(2)} at end`
      + (contended ? ' — every latency above is inflated by an unknown amount' : ''),
    severity: SEVERITY.INFO,
    ms: Date.now() - phaseT0,
    measured: {
      cores,
      loadAtStart: +loadAtStart.toFixed(2),
      loadAtEnd: +loadAtEnd.toFixed(2),
      phaseWallMs: Date.now() - phaseT0,
      budgetMs: quick ? 180000 : 720000,
      insideBudget: (Date.now() - phaseT0) <= (quick ? 180000 : 720000),
    },
  });
  if (contended) {
    atlas.blind('clean latency numbers',
      `the 1-minute load average reached ${Math.max(loadAtStart, loadAtEnd).toFixed(2)} on `
      + `${cores} cores while this phase ran. The verdicts on RECALL and on the tie `
      + 'share are unaffected — they are counts, not times — but every p50 and every '
      + 'exponent above should be re-taken on an idle machine before it is compared '
      + 'with another run.');
  }

  // --- what this phase did NOT look at ----------------------------------
  //
  // Named, because the corpus ladder here stops at 20k while the claims in
  // docs and in bench/scale.mjs reach 1M. An exponent taken over 1k -> 20k
  // is a statement about 1k -> 20k.
  atlas.blind('scale beyond ' + last.label + ' entries',
    `the ladder here stops at ${last.corpus.count} entries so the full run stays `
    + 'inside its time budget. bench/scale.mjs reaches 1M in-process; the '
    + 'process-level curve above is NOT extrapolated there.');
  atlas.blind('`mem experiences` and `mem core` double-scan',
    'src/memory.mjs:756 calls standing() and then iterates entriesById() again, '
    + 'so the corpus is walked twice. The A ladder times both commands and the '
    + 'exponent is recorded — but the two scans cannot be told apart from '
    + 'outside the process, so the DOUBLE is inferred from the source, not measured.');
  atlas.blind('concurrent readers',
    'every measurement here is a single process against an idle corpus; the '
    + 'retrieval hook in practice runs alongside the session that triggered it.');
}

/**
 * Rewrite only the `ts` field of every entry under `dir`.
 *
 * Everything else — ids, text, term statistics, file sizes down to a few
 * bytes — stays as `buildCorpus` wrote it, so the two variants differ in
 * exactly one thing. Append-only is not at stake: this is a throwaway
 * corpus under `tempRoot()`, not a memory.
 */
function restamp(dir, mode) {
  const today = Math.floor(Date.now() / 86400000);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f);
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const out = lines.map((line, i) => {
      let e;
      try { e = JSON.parse(line); } catch { return line; }
      const day = mode === 'same-day' ? today - 1 : today - (i % 90);
      e.ts = new Date(day * 86400000 + 43200000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      return JSON.stringify(e);
    });
    fs.writeFileSync(p, `${out.join('\n')}\n`);
  }
}
