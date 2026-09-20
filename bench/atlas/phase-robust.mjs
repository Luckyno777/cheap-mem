// bench/atlas/phase-robust.mjs — broken state, concurrent writers, resources.
//
// **The question this phase asks.** Not "does the memory work", which the
// other phases measure. This one asks: when the memory is BROKEN, does the
// system notice — and if it does not, does it at least stay quiet about
// being healthy? A doctor that says `ok` over a drawer it never opened is
// worse than no doctor, because it converts an unknown into an assurance.
//
// **Three things are recorded per broken state, never one:**
//
//   established   was the state actually produced? A probe that could not
//                 break anything measured nothing, and says so
//                 (`not-measured` + a named blind spot), rather than
//                 passing because nothing went wrong.
//   noticed       did anything report it, and with WHICH of the four
//                 states — `ok`, `WARN`, `FAIL` or `?`. The distinction
//                 matters: `?` is an honest refusal, `ok` over the same
//                 defect is a false assurance.
//   accounting    does the memory say how many entries it could not read?
//                 This is the one that catches the quiet failures. A
//                 system can read 470 of 512 entries, report `ok drawers`
//                 and never once state the gap.
//
// **Every probe carries a counter-probe.** A check that fires on the
// broken state AND on the healthy one is not a check, it is a light that
// is always on. Where a probe has one, it is recorded next to it, named
// `.control` (the state that must NOT trigger it) or `.positive` (the
// state that must).
//
// **Concurrency is measured as a rate, never as a yes/no.** A single run
// of an interleaving probe catches an interleaving some of the time —
// measured elsewhere in this repo at 2 in 12 for one shape. A phase that
// runs it once and prints "no interleaving" has measured the dice, not the
// filesystem. Every concurrency state here runs at least ten times and the
// record carries the fraction.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  VERDICT, SEVERITY, REPO, mem, tempRoot, buildCorpus, dirBytes, heapAround,
} from './core.mjs';

// ---------------------------------------------------------------------
// Reading the truth off the disk, without asking the system under test
// ---------------------------------------------------------------------

/** Every `.jsonl` under the memory's data directories — known name or not. */
function jsonlFiles(root) {
  const out = [];
  const roots = [path.join(root, 'global'), path.join(root, 'projects'), path.join(root, 'shared')];
  const stack = roots.filter((p) => fs.existsSync(p));
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      for (const k of fs.readdirSync(cur)) stack.push(path.join(cur, k));
    } else if (cur.endsWith('.jsonl')) out.push(cur);
  }
  return out.sort();
}

/**
 * What is actually on disk: files, lines, parseable entries.
 *
 * Deliberately NOT routed through `memory.logFiles`, which walks
 * `TYPES` — using the system's own idea of which files exist to check
 * whether it sees every file is circular, and the circle is exactly the
 * gap this phase is built to catch.
 */
function diskTruth(root) {
  const files = jsonlFiles(root);
  let lines = 0; let parseable = 0; let torn = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try { JSON.parse(line); parseable += 1; } catch { torn += 1; }
    }
  }
  return { files: files.length, fileNames: files.map((f) => path.relative(root, f)), lines, parseable, torn };
}

/** `ok|WARN|FAIL|?  name  detail` -> Map(name -> {level, detail}). */
function parseDoctor(stdout) {
  const map = new Map();
  for (const line of String(stdout).split('\n')) {
    const m = /^(ok|WARN|FAIL|\?)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const level = { ok: 'ok', WARN: 'warn', FAIL: 'fail', '?': 'unknown' }[m[1]];
    map.set(m[2], { level, detail: m[3].trim() });
  }
  return map;
}

/** The corpus size `mem find` prints — what the SEARCH thinks is there. */
function indexN(stdout) {
  const m = /\((\d+) entries,/.exec(String(stdout));
  return m ? Number(m[1]) : null;
}

/** Run the three commands the brief names, on one root, and parse them. */
function observe(root, anchor) {
  const doctor = mem(['doctor'], { root });
  const find = mem(['find', anchor], { root });
  const context = mem(['context', '--n', '5'], { root });
  return {
    doctor: {
      status: doctor.status,
      findings: parseDoctor(doctor.stdout),
      stdout: doctor.stdout,
      stderr: doctor.stderr,
    },
    find: {
      status: find.status,
      n: indexN(find.stdout),
      hits: /^(\d+) hits/.test(find.stdout) ? Number(/^(\d+) hits/.exec(find.stdout)[1]) : 0,
      stdout: find.stdout,
      stderr: find.stderr,
    },
    context: { status: context.status, bytes: context.bytes, stdout: context.stdout, stderr: context.stderr },
    disk: diskTruth(root),
  };
}

/** Which named findings changed level against the healthy baseline. */
function changedVsBase(obs, base) {
  const out = [];
  for (const [name, f] of obs.doctor.findings) {
    const b = base.doctor.findings.get(name);
    if (!b) { out.push(`${name}: absent -> ${f.level}`); continue; }
    if (b.level !== f.level) out.push(`${name}: ${b.level} -> ${f.level}`);
  }
  for (const name of base.doctor.findings.keys()) {
    if (!obs.doctor.findings.has(name)) out.push(`${name}: gone`);
  }
  return out;
}

/** Does any output state a number of entries it could NOT read? */
const GAP_WORDS = /(unparseable|unreadable|could not read|skipped|not read|ignored|unknown file|unrecognis|unrecogniz)/i;
function statesTheGap(obs) {
  const where = [];
  for (const [name, f] of obs.doctor.findings) {
    if (GAP_WORDS.test(f.detail)) where.push(`doctor/${name}: ${f.detail.slice(0, 160)}`);
  }
  if (GAP_WORDS.test(obs.find.stdout)) where.push('find stdout');
  if (GAP_WORDS.test(obs.context.stdout)) where.push('context stdout');
  return where;
}

// ---------------------------------------------------------------------
// Corpora for this phase
// ---------------------------------------------------------------------

/**
 * Pull every timestamp back into the recent past.
 *
 * `buildCorpus` spreads timestamps across a whole calendar year, so on any
 * date before 31 December a fresh corpus already trips `env/clock` and
 * carries a pile of "questionable timestamp(s)". That is fine for a
 * latency corpus and useless here: a baseline that is already red cannot
 * show that a defect made anything redder. So the baseline is made clean
 * first, on purpose, and the timestamp probe below then has something to
 * move.
 */
function pastify(root, { days = 30 } = {}) {
  const base = Date.now() - days * 86400000;
  let k = 0;
  for (const f of jsonlFiles(root)) {
    const out = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { out.push(line); continue; }
      if (e && typeof e === 'object' && e.ts) {
        k = (k + 997) % ((days - 1) * 86400);
        e.ts = new Date(base + k * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
      out.push(JSON.stringify(e));
    }
    fs.writeFileSync(f, `${out.join('\n')}\n`);
  }
}

/** A throwaway memory with a clean clock and a findable anchor. */
function scenarioRoot(prefix, count) {
  const root = tempRoot(`atlas-robust-${prefix}-`);
  const corpus = buildCorpus(root, count, { anchors: 3, seed: 42 });
  pastify(root);
  return { root, corpus, anchor: corpus.anchors[0].phrase };
}

/** One JSONL line shaped like a real entry, ready to append. */
function entryLine(id, extra = {}) {
  return `${JSON.stringify({
    id,
    ts: new Date(Date.now() - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    title: `probe ${id}`,
    text: `probe entry ${id} written by the robustness phase`,
    tags: ['probe'],
    ...extra,
  })}\n`;
}

// ---------------------------------------------------------------------
// Part 1 — broken state
// ---------------------------------------------------------------------

async function partBroken(atlas, quick) {
  const N = quick ? 80 : 240;

  // The healthy reference. Every "did anything notice" below is a
  // difference against THIS, not against an idea of what doctor prints.
  const clean = scenarioRoot('baseline', N);
  const base = observe(clean.root, clean.anchor);
  atlas.record({
    id: 'robust.baseline.healthy',
    title: 'baseline: a healthy memory of this shape reports no FAIL',
    verdict: [...base.doctor.findings.values()].some((f) => f.level === 'fail')
      ? VERDICT.FAIL : VERDICT.PASS,
    expected: 'no FAIL finding on an untouched corpus',
    actual: [...base.doctor.findings.entries()]
      .filter(([, f]) => f.level === 'fail').map(([n]) => n).join(', ') || 'none',
    measured: {
      diskLines: base.disk.lines,
      diskFiles: base.disk.files,
      searchN: base.find.n,
      levels: Object.fromEntries([...base.doctor.findings].map(([n, f]) => [n, f.level])),
    },
    severity: SEVERITY.INFO,
  });

  // --- 1. a foreign .jsonl in global/ --------------------------------
  //
  // The confirmed find, rebuilt as a fixed record. Measured on
  // 2026-09-19 while writing the atlas corpus generator: a wrongly
  // pluralised filename (`dutys.jsonl`) put 42 valid entries in
  // `global/` that nothing ever read. 512 on disk, 470 read, `doctor`
  // said `ok drawers 10 files` with eleven lying there, `find` never
  // returned the entry.
  {
    const { root, anchor } = scenarioRoot('unknown-type', N);
    const strangerAnchor = 'strangerphrasewqx';
    const strangerFile = path.join(root, 'global', 'dutys.jsonl');
    const strangerCount = 42;
    let body = '';
    for (let i = 0; i < strangerCount; i += 1) {
      body += entryLine(`stranger${i}`, {
        title: `stranger ${i} ${i === 0 ? strangerAnchor : ''}`.trim(),
        text: `a perfectly valid entry in a file nobody reads ${i === 0 ? strangerAnchor : ''}`,
      });
    }
    fs.writeFileSync(strangerFile, body);

    const obs = observe(root, anchor);
    const stranger = mem(['find', strangerAnchor], { root });
    const strangerLiteral = mem(['find', strangerAnchor, '--literal'], { root });

    const established = fs.existsSync(strangerFile) && diskTruth(root).lines > base.disk.lines;
    atlas.record({
      id: 'robust.unknown-type.established',
      title: 'foreign .jsonl with valid entries placed in global/',
      verdict: established ? VERDICT.PASS : VERDICT.NOT_MEASURED,
      expected: `${strangerCount} valid entries in global/dutys.jsonl`,
      actual: established ? `${strangerCount} entries written` : 'could not write the file',
      measured: { file: 'global/dutys.jsonl', entries: strangerCount },
    });
    if (!established) atlas.blind('foreign .jsonl in global/', 'the file could not be created');

    const drawers = obs.doctor.findings.get('drawers');
    const integ = obs.doctor.findings.get('integrity');
    const gapStated = statesTheGap(obs);
    const unread = obs.disk.parseable - (obs.find.n ?? 0);

    // THE record. Expected behaviour is stated in the words the brief
    // uses, so the gap between it and the actual is readable without
    // having to re-derive what should have happened.
    atlas.record({
      id: 'robust.unknown-type.accounting',
      title: 'entries in an unrecognised file: the memory says how many it could not read',
      verdict: gapStated.length ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'the memory says how many entries it could not read',
      actual: gapStated.length
        ? `stated: ${gapStated[0]}`
        : `silent: ${unread} of ${obs.disk.parseable} parseable entries never reached the search, `
          + `doctor drawers = "${drawers?.level} ${drawers?.detail}", `
          + `integrity = "${integ?.level} ${integ?.detail}"`,
      measured: {
        onDisk: obs.disk.parseable,
        filesOnDisk: obs.disk.files,
        readBySearch: obs.find.n,
        unread,
        doctorDrawers: drawers ?? null,
        doctorIntegrity: integ ?? null,
        doctorStatus: obs.doctor.status,
        changedVsBaseline: changedVsBase(obs, base),
      },
      evidence: `disk: ${obs.disk.files} .jsonl files, ${obs.disk.parseable} parseable entries\n`
        + `search: ${obs.find.n} entries\n`
        + `doctor drawers: ${drawers?.level} — ${drawers?.detail}\n`
        + `doctor integrity: ${integ?.level} — ${integ?.detail}\n`
        + `files: ${obs.disk.fileNames.join(', ')}`,
      severity: SEVERITY.MAJOR,
    });

    // The probe: can the entry be found at all, by any lane?
    //
    // Counted by HIT COUNT, not by whether the query string appears in
    // the output — `mem find` echoes the query back in its "Nothing
    // for '<query>'" line, so a substring test passes on a miss. That
    // mistake makes a probe report the opposite of what happened, and
    // it was in the first version of this record.
    const hitsOf = (r) => (/^(\d+) hits/.test(r.stdout) ? Number(/^(\d+) hits/.exec(r.stdout)[1]) : 0);
    const foundStranger = hitsOf(stranger) > 0 || hitsOf(strangerLiteral) > 0;
    atlas.record({
      id: 'robust.unknown-type.findable',
      title: 'an entry in an unrecognised file can be found',
      verdict: foundStranger ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'find returns the entry (ranked or --literal)',
      actual: `ranked: ${stranger.stdout.split('\n')[0]}; literal: ${strangerLiteral.stdout.split('\n')[0]}`,
      measured: {
        rankedHits: hitsOf(stranger),
        literalHits: hitsOf(strangerLiteral),
        note: 'memory.find and integrity.logFiles both walk memory.TYPES, so a file whose '
          + 'name is not in that map is never opened by any lane.',
      },
      evidence: `${stranger.stdout.slice(0, 200)}\n---\n${strangerLiteral.stdout.slice(0, 200)}`,
      severity: SEVERITY.MAJOR,
    });

    // Positive control: the SAME entries under a name TYPES knows must
    // be found. Without this, "not found" could be the query's fault.
    const ctl = scenarioRoot('unknown-type-control', N);
    fs.appendFileSync(path.join(ctl.root, 'global', 'duties.jsonl'), body);
    const ctlHit = mem(['find', strangerAnchor], { root: ctl.root });
    atlas.record({
      id: 'robust.unknown-type.positive',
      title: 'positive control: the identical entries under a KNOWN filename are found',
      verdict: hitsOf(ctlHit) > 0 ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'the same bytes in global/duties.jsonl are found',
      actual: ctlHit.stdout.split('\n')[0],
      measured: { hits: hitsOf(ctlHit), searchN: indexN(ctlHit.stdout), diskParseable: diskTruth(ctl.root).parseable },
      severity: SEVERITY.CRITICAL,
    });
  }

  // --- 2. a torn line in the middle of a log -------------------------
  {
    const { root, anchor } = scenarioRoot('torn-line', N);
    const target = path.join(root, 'global', 'learnings.jsonl');
    const lines = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
    const at = Math.floor(lines.length / 2);
    lines.splice(at, 0, '{"id":"halfwritten","ts":"2026-09-01T00:00:00Z","title":"cut off mid-w');
    fs.writeFileSync(target, `${lines.join('\n')}\n`);

    const obs = observe(root, anchor);
    const established = obs.disk.torn === 1;
    atlas.record({
      id: 'robust.torn-line.established',
      title: 'a half-written JSON line sits mid-file',
      verdict: established ? VERDICT.PASS : VERDICT.NOT_MEASURED,
      expected: '1 unparseable line on disk',
      actual: `${obs.disk.torn} unparseable`,
    });
    if (!established) atlas.blind('torn line mid-file', 'the torn line could not be placed');

    const integ = obs.doctor.findings.get('integrity');
    const named = /learnings\.jsonl:\d+/.test(integ?.detail ?? '');
    atlas.record({
      id: 'robust.torn-line.noticed',
      title: 'a torn line is reported, located and not treated as healthy',
      verdict: integ?.level === 'fail' || integ?.level === 'error' ? VERDICT.PASS
        : (integ?.level === 'warn' ? VERDICT.DEGRADED : VERDICT.FAIL),
      expected: 'doctor integrity: FAIL, naming file:line',
      actual: `${integ?.level ?? 'absent'} — ${integ?.detail ?? ''}`,
      measured: {
        level: integ?.level, locationNamed: named, doctorStatus: obs.doctor.status,
        changedVsBaseline: changedVsBase(obs, base),
      },
      evidence: integ?.detail ?? null,
      severity: SEVERITY.MAJOR,
    });
    atlas.record({
      id: 'robust.torn-line.accounting',
      title: 'the torn line is subtracted from the count the memory reports',
      verdict: (integ?.detail ?? '').includes(`${obs.disk.parseable} entries in ${obs.disk.lines} lines`)
        ? VERDICT.PASS : VERDICT.DEGRADED,
      expected: `"${obs.disk.parseable} entries in ${obs.disk.lines} lines"`,
      actual: integ?.detail ?? 'no integrity finding',
      measured: {
        diskLines: obs.disk.lines, diskParseable: obs.disk.parseable, searchN: obs.find.n,
      },
      severity: SEVERITY.MINOR,
    });
    atlas.record({
      id: 'robust.torn-line.survives',
      title: 'find and context still answer over a file with a torn line',
      verdict: obs.find.status === 0 && obs.context.status === 0 && obs.find.hits > 0
        ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'both exit 0, the anchor is still found',
      actual: `find exit ${obs.find.status} (${obs.find.hits} hits), context exit ${obs.context.status}`,
      severity: SEVERITY.MAJOR,
    });
  }

  // --- 3. a 0-byte file where a log should be ------------------------
  {
    const { root, anchor } = scenarioRoot('zero-byte', N);
    const target = path.join(root, 'global', 'errors.jsonl');
    const lost = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).length;
    fs.writeFileSync(target, '');

    const obs = observe(root, anchor);
    atlas.record({
      id: 'robust.zero-byte.established',
      title: 'a log file truncated to 0 bytes',
      verdict: fs.statSync(target).size === 0 ? VERDICT.PASS : VERDICT.NOT_MEASURED,
      expected: 'global/errors.jsonl is 0 bytes',
      actual: `${fs.statSync(target).size} bytes, ${lost} entries gone`,
      measured: { entriesLost: lost },
    });

    const drawers = obs.doctor.findings.get('drawers');
    const integ = obs.doctor.findings.get('integrity');
    // Honest expectation: a 0-byte drawer is indistinguishable from a
    // drawer that was never filled, so the system CANNOT be asked to call
    // it corruption. What it can be asked is to count the file and not to
    // count entries that are gone — i.e. to be consistent with the disk.
    const consistent = integ?.detail?.startsWith(`${obs.disk.parseable} entries`);
    atlas.record({
      id: 'robust.zero-byte.noticed',
      title: 'a present-but-empty drawer is counted as a file with no lines',
      verdict: consistent ? VERDICT.PASS : VERDICT.DEGRADED,
      expected: 'the counts match the disk; the empty drawer is not reported as full',
      actual: `drawers: ${drawers?.detail}; integrity: ${integ?.detail}`,
      measured: {
        diskFiles: obs.disk.files, diskParseable: obs.disk.parseable, searchN: obs.find.n,
        drawers: drawers ?? null, integrity: integ ?? null,
        changedVsBaseline: changedVsBase(obs, base),
      },
      severity: SEVERITY.MINOR,
    });
    atlas.record({
      id: 'robust.zero-byte.accounting',
      title: 'an emptied drawer is distinguishable from one that was never filled',
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: 'nothing on disk records that the file once held entries',
      measured: {
        entriesGone: lost,
        anyFindingMentionsLoss: statesTheGap(obs),
        note: 'Without git history or an epoch watermark there is no local evidence of '
          + 'the earlier content. This is a property of the state, not a failure of the check.',
      },
    });
    atlas.blind('0-byte log file: "was it emptied or never written?"',
      'a truncated file leaves no local trace of its former content; only git history '
      + 'or `mem epoch` could answer it, and neither exists in a throwaway root');
  }

  // --- 4. a broken search index --------------------------------------
  {
    for (const [key, body, what] of [
      ['invalid-json', '{ this is not json at all', 'invalid JSON'],
      ['wrong-schema', JSON.stringify({ version: 999, hello: 'world' }), 'valid JSON, wrong schema'],
    ]) {
      const { root, anchor } = scenarioRoot(`index-${key}`, N);
      mem(['find', anchor], { root });               // make a real cache first
      const cachePath = path.join(root, '.mem', 'search-index.json');
      const had = fs.existsSync(cachePath);
      fs.writeFileSync(cachePath, body);

      const obs = observe(root, anchor);
      atlas.record({
        id: `robust.index-${key}.established`,
        title: `search index replaced with ${what}`,
        verdict: had ? VERDICT.PASS : VERDICT.NOT_MEASURED,
        expected: 'a cache existed and was overwritten',
        actual: had ? `overwritten with ${what}` : 'no cache was ever written',
      });
      if (!had) atlas.blind(`broken index (${what})`, 'no cache file was produced to break');

      atlas.record({
        id: `robust.index-${key}.recovers`,
        title: `a ${what} index is discarded and the answer is still right`,
        verdict: obs.find.status === 0 && obs.find.hits > 0 && obs.find.n === obs.disk.parseable
          ? VERDICT.PASS : VERDICT.FAIL,
        expected: 'find exits 0, the anchor is found, all entries are in the index',
        actual: `exit ${obs.find.status}, ${obs.find.hits} hits, ${obs.find.n}/${obs.disk.parseable} entries`,
        measured: {
          doctorIndex: obs.doctor.findings.get('index') ?? null,
          changedVsBaseline: changedVsBase(obs, base),
          cacheRewritten: fs.existsSync(cachePath) && fs.statSync(cachePath).size > body.length,
        },
        severity: SEVERITY.CRITICAL,
      });
      atlas.record({
        id: `robust.index-${key}.announced`,
        title: `discarding a ${what} index is visible to the user`,
        verdict: /rebuil|fresh build|stale|discard/i.test(obs.doctor.findings.get('index')?.detail ?? '')
          ? VERDICT.PASS : VERDICT.DEGRADED,
        expected: 'some output says the cache was thrown away and rebuilt',
        actual: obs.doctor.findings.get('index')?.detail ?? 'no index finding',
        measured: { findFirstLine: obs.find.stdout.split('\n')[0] },
        severity: SEVERITY.MINOR,
      });
    }
  }

  // --- 5. an index that LIES -----------------------------------------
  //
  // The 2026-09-05 find `0l3f79g`: status lived in the cache, so editing
  // the cache changed what the memory considered active — a cache had
  // become the truth about MEANING. `src/state.mjs` was written to make
  // that structurally impossible. This is the positive control for that
  // repair, not a hunt for a new find.
  {
    const { root, corpus } = scenarioRoot('lying-index', N);
    const marker = 'lyingindexmarkerqz';
    const corpusAnchor = corpus.anchors[1].phrase;      // the doc that gets deleted
    mem(['log', 'learning', '--title', `${marker} claim`, '--text',
      `a claim about ${marker} that will be retired`, '--id', 'liar1'], { root });
    const done = mem(['done', 'liar1', '--why', 'retired on purpose'], { root });
    // `--fresh` forces a full rebuild AND a cache write. Without it the
    // retirement is re-derived from the appended tombstone on every load
    // and never reaches the file — there would be nothing to tamper with,
    // and the probe would quietly measure nothing.
    mem(['find', marker, '--fresh'], { root });
    const beforeJson = mem(['retrieve', `${marker} claim`, '--json'], { root });
    const beforeAnchor = mem(['find', corpusAnchor], { root });

    const cachePath = path.join(root, '.mem', 'search-index.json');
    let strippedRetired = false; let removedDoc = false; let hadRetired = false;
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const docs = c.index?.documents ?? [];
      // A document is `{ entry, type, project, source, line, weights,
      // length, retired? }` — the id sits on `entry`, not on the doc.
      for (const d of docs) {
        if (d.entry?.id !== 'liar1') continue;
        hadRetired = Boolean(d.retired);
        if (d.retired) { delete d.retired; strippedRetired = true; }
      }
      // A second lie, in the other direction: remove a document the log
      // holds, and shrink N to match, so the cache is internally
      // consistent and only DISAGREES WITH THE LOG.
      const before = docs.length;
      c.index.documents = docs.filter((d) => d.entry?.id !== 'anchor1');
      removedDoc = c.index.documents.length < before;
      if (removedDoc && typeof c.index.N === 'number') c.index.N -= (before - c.index.documents.length);
      fs.writeFileSync(cachePath, JSON.stringify(c));
    } catch { /* recorded as not-established below */ }

    const afterJson = mem(['retrieve', `${marker} claim`, '--json'], { root });
    const afterFind = mem(['find', marker], { root });
    const afterAnchor = mem(['find', corpusAnchor], { root });
    // The three commands the brief names, run against the tampered state,
    // so the "does anything notice" question is answered for this lage
    // the same way it is for the others.
    const tampered = observe(root, corpusAnchor);
    const hits = (r) => (/^(\d+) hits/.test(r.stdout) ? Number(/^(\d+) hits/.exec(r.stdout)[1]) : 0);

    atlas.record({
      id: 'robust.lying-index.established',
      title: 'the cache was edited to contradict the log',
      verdict: strippedRetired && removedDoc ? VERDICT.PASS : VERDICT.NOT_MEASURED,
      expected: 'the cache holds a retirement and a document, and both are removed from it',
      actual: `retired field present before tampering: ${hadRetired}; `
        + `stripped: ${strippedRetired}; document removed: ${removedDoc}`,
      measured: { retireCommandExit: done.status, hadRetired, strippedRetired, removedDoc },
    });
    if (!strippedRetired || !removedDoc) {
      atlas.blind('index that lies about meaning',
        `the cache did not have the expected shape (retired present: ${hadRetired}, `
        + `document removed: ${removedDoc}), so the lie could not be planted`);
    }

    const statusOf = (r) => {
      try { return JSON.parse(r.stdout).claims?.find((c) => c.id === 'liar1')?.status ?? 'absent'; } catch { return null; }
    };
    const statusBefore = statusOf(beforeJson);
    const statusAfter = statusOf(afterJson);

    atlas.record({
      id: 'robust.lying-index.state-holds',
      title: 'positive control: retirement still comes from the LOG, not the cache',
      verdict: !strippedRetired ? VERDICT.NOT_MEASURED
        : (statusAfter === 'done' ? VERDICT.PASS : VERDICT.FAIL),
      expected: 'retrieve still reports status "done" after the cache says otherwise',
      actual: `status before tampering: ${statusBefore}, after: ${statusAfter}`,
      measured: {
        statusBefore,
        statusAfter,
        retrieveExit: afterJson.status,
        note: 'This is the 2026-09-05 find `0l3f79g` re-run against its repair: '
          + 'src/state.mjs derives status from the log, so the cache cannot carry meaning.',
      },
      evidence: afterJson.stdout.slice(0, 600),
      severity: SEVERITY.CRITICAL,
    });
    atlas.record({
      id: 'robust.lying-index.findability',
      title: 'a cache that hides a retirement does not resurrect the claim in `find`',
      verdict: !strippedRetired ? VERDICT.NOT_MEASURED
        : (hits(afterFind) > 0 ? VERDICT.FAIL : VERDICT.PASS),
      expected: 'the retired claim stays hidden in the ranked lane too',
      actual: `${hits(afterFind)} hits — ${afterFind.stdout.split('\n')[0]}`,
      measured: {
        hitsAfterTampering: hits(afterFind),
        note: 'search.buildIndex bakes `retired` into the cached document '
          + '(src/search.mjs:412-421), and appendToIndex only re-applies retirement for '
          + 'lines that are NEW since the cache was written. So this lane trusts the '
          + 'cache, while retrieve reads the log via state.mjs. The split in exposure is '
          + 'structural, not accidental.',
      },
      evidence: afterFind.stdout.slice(0, 400),
      severity: SEVERITY.MAJOR,
    });
    atlas.record({
      id: 'robust.lying-index.shrunk-corpus',
      title: 'a document deleted from the cache is still found, because the log holds it',
      verdict: !removedDoc ? VERDICT.NOT_MEASURED
        : (hits(afterAnchor) > 0 ? VERDICT.PASS : VERDICT.FAIL),
      expected: 'the anchor is still findable after its document is cut out of the cache',
      actual: `before ${hits(beforeAnchor)} hits, after ${hits(afterAnchor)} hits; `
        + `search reports ${indexN(afterFind.stdout)} entries, disk holds ${diskTruth(root).parseable}`,
      measured: {
        hitsBefore: hits(beforeAnchor),
        hitsAfter: hits(afterAnchor),
        onDisk: diskTruth(root).parseable,
        searchN: indexN(afterFind.stdout),
        gapStated: statesTheGap(tampered),
        doctorAfterTampering: Object.fromEntries(
          [...tampered.doctor.findings].filter(([, f]) => f.level !== 'ok')),
        contextExit: tampered.context.status,
        changedVsBaseline: changedVsBase(tampered, base),
      },
      evidence: afterAnchor.stdout.slice(0, 400),
      severity: SEVERITY.MAJOR,
    });
  }

  // --- 6. no .mem/config.json ----------------------------------------
  {
    const { root, anchor } = scenarioRoot('no-config', N);
    const cfg = path.join(root, '.mem', 'config.json');
    fs.rmSync(cfg, { force: true });
    const obs = observe(root, anchor);
    atlas.record({
      id: 'robust.no-config.established',
      title: '.mem/config.json removed',
      verdict: !fs.existsSync(cfg) ? VERDICT.PASS : VERDICT.NOT_MEASURED,
      expected: 'the config file is gone',
      actual: fs.existsSync(cfg) ? 'still there' : 'removed',
    });
    const refused = [obs.doctor, obs.find, obs.context]
      .map((r, i) => ({ cmd: ['doctor', 'find', 'context'][i], status: r.status }));
    const hints = `${obs.doctor.stdout}${obs.doctor.stderr}${obs.find.stderr}${obs.context.stderr}`;
    atlas.record({
      id: 'robust.no-config.noticed',
      title: 'a memory without a config says so instead of defaulting silently',
      verdict: /mem init|No memory config/i.test(hints) ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'a named error pointing at `mem init`, not a silent default',
      actual: refused.map((r) => `${r.cmd} exit ${r.status}`).join(', '),
      measured: {
        exits: refused,
        configFinding: obs.doctor.findings.get('config') ?? null,
        changedVsBaseline: changedVsBase(obs, base),
      },
      evidence: `${obs.find.stderr || obs.find.stdout}\n---\n${obs.context.stderr || obs.context.stdout}`.slice(0, 800),
      severity: SEVERITY.MAJOR,
    });
    atlas.record({
      id: 'robust.no-config.no-silent-answer',
      title: 'no command answers as if the memory were configured',
      verdict: refused.every((r) => r.status !== 0) ? VERDICT.PASS : VERDICT.DEGRADED,
      expected: 'every command exits non-zero',
      actual: refused.map((r) => `${r.cmd}=${r.status}`).join(' '),
      severity: SEVERITY.MINOR,
    });
  }

  // --- 7. a read-only root -------------------------------------------
  //
  // The brief names the trap and it is real: these probes run as root,
  // and root walks through a `chmod 555`. So the state is ATTEMPTED,
  // verified, and when it cannot be produced it is `not-measured` plus a
  // named blind spot — never a probe that passes because nothing broke.
  {
    const { root, anchor } = scenarioRoot('readonly', quick ? 40 : 80);
    const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
    fs.chmodSync(root, 0o555);
    fs.chmodSync(path.join(root, 'global'), 0o555);
    let chmodHolds = false; let probeErr = null;
    try {
      fs.writeFileSync(path.join(root, 'global', 'writethrough.tmp'), 'x');
      fs.rmSync(path.join(root, 'global', 'writethrough.tmp'), { force: true });
    } catch (e) { chmodHolds = true; probeErr = e.code; }

    atlas.record({
      id: 'robust.readonly.established',
      title: 'write-protected root (chmod 555) actually refuses a write',
      verdict: chmodHolds ? VERDICT.PASS : VERDICT.NOT_MEASURED,
      expected: 'a write into the root fails with EACCES',
      actual: chmodHolds ? `refused with ${probeErr}` : `euid ${euid} wrote through chmod 555`,
      measured: { euid, chmodHolds },
    });
    if (!chmodHolds) {
      atlas.blind('write-protected root via chmod 555',
        `this run is euid ${euid}; root bypasses DAC permission bits, so the state cannot be `
        + 'produced this way. Not a pass — the behaviour of the memory against an '
        + 'unwritable root is UNMEASURED here. Re-run as an unprivileged user to get it.');
    }
    fs.chmodSync(path.join(root, 'global'), 0o755);
    fs.chmodSync(root, 0o755);

    // A second, genuinely enforceable form of "cannot write" — the
    // immutable bit, which the kernel enforces against root too. It is
    // NOT the same state, and is recorded under its own name rather
    // than quietly standing in for the one above.
    const target = path.join(root, 'global', 'learnings.jsonl');
    const set = spawnSync('chattr', ['+i', target], { encoding: 'utf8' });
    let immutableHolds = false;
    try { fs.appendFileSync(target, '\n'); } catch { immutableHolds = true; }
    let write = null; let ro = null;
    if (immutableHolds) {
      write = mem(['log', 'learning', '--title', 'blocked', '--text', 'should not land'], { root });
      ro = observe(root, anchor);
    }
    spawnSync('chattr', ['-i', target], { encoding: 'utf8' });

    atlas.record({
      id: 'robust.readonly.immutable-file',
      title: 'an unwritable log file: the write fails loudly, not silently',
      verdict: !immutableHolds ? VERDICT.NOT_MEASURED
        : (write.status !== 0 && /EPERM|permission|read-only|denied/i.test(`${write.stderr}${write.stdout}`)
          ? VERDICT.PASS : VERDICT.FAIL),
      expected: 'non-zero exit and an error naming the permission problem',
      actual: !immutableHolds
        ? `chattr +i not enforceable here (exit ${set.status}, ${String(set.stderr).trim().slice(0, 80)})`
        : `exit ${write.status}: ${String(write.stderr || write.stdout).trim().slice(0, 200)}`,
      measured: { chattrExit: set.status, immutableHolds },
      severity: SEVERITY.MAJOR,
    });
    atlas.record({
      id: 'robust.readonly.reads-still-work',
      title: 'reading a memory whose log cannot be written still works',
      verdict: !immutableHolds ? VERDICT.NOT_MEASURED
        : (ro.find.status === 0 && ro.find.hits > 0 && ro.context.status === 0
          ? VERDICT.PASS : VERDICT.FAIL),
      expected: 'doctor, find and context all answer over an unwritable log',
      actual: !immutableHolds ? 'the state could not be produced'
        : `doctor exit ${ro.doctor.status}, find exit ${ro.find.status} (${ro.find.hits} hits), `
          + `context exit ${ro.context.status}`,
      measured: ro ? {
        nonOkFindings: Object.fromEntries([...ro.doctor.findings].filter(([, f]) => f.level !== 'ok')),
        searchN: ro.find.n,
        onDisk: ro.disk.parseable,
      } : null,
      severity: SEVERITY.MAJOR,
    });
    if (!immutableHolds) {
      atlas.blind('unwritable log file (immutable bit)',
        `chattr +i is not available or not enforced on this filesystem (exit ${set.status})`);
    }
  }

  // --- 8. no git repository ------------------------------------------
  {
    const { root, anchor } = scenarioRoot('no-git', N);
    const obs = observe(root, anchor);
    const gitNames = [...obs.doctor.findings.keys()]
      .filter((n) => /git|rollback|gitignore|merge-driver|pre-commit|behind|append-only/.test(n));
    const levels = Object.fromEntries(gitNames.map((n) => [n, obs.doctor.findings.get(n).level]));
    const anyOk = gitNames.filter((n) => levels[n] === 'ok'
      && !/nothing|no append-only logs yet/i.test(obs.doctor.findings.get(n).detail));
    atlas.record({
      id: 'robust.no-git.established',
      title: 'the memory root is not a git repository',
      verdict: !fs.existsSync(path.join(root, '.git')) ? VERDICT.PASS : VERDICT.NOT_MEASURED,
      expected: 'no .git in the root',
      actual: fs.existsSync(path.join(root, '.git')) ? '.git present' : 'no .git',
    });
    atlas.record({
      id: 'robust.no-git.honest-unknown',
      title: 'git-dependent guarantees report `?`, never `ok`, without a repository',
      verdict: anyOk.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'every git-dependent finding is unknown or warn — a guess would be worse than none',
      actual: anyOk.length ? `claimed ok without a repo: ${anyOk.join(', ')}` : `all honest: ${JSON.stringify(levels)}`,
      measured: { levels, details: Object.fromEntries(gitNames.map((n) => [n, obs.doctor.findings.get(n).detail])) },
      severity: SEVERITY.MAJOR,
    });
    atlas.record({
      id: 'robust.no-git.still-answers',
      title: 'find and context work in a memory that was never versioned',
      verdict: obs.find.status === 0 && obs.find.hits > 0 && obs.context.status === 0
        ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'both answer normally',
      actual: `find exit ${obs.find.status} (${obs.find.hits} hits), context exit ${obs.context.status}`,
      severity: SEVERITY.MINOR,
    });
  }

  // --- 9. over the byte cap ------------------------------------------
  //
  // `memory.MAX_ENTRY_BYTES` is 1 MB on the FINISHED line. The CLI cannot
  // even carry a field that size — Linux caps one argv string at 128 KB —
  // so the write path is driven in a child process that calls `logEntry`
  // directly. That is the layer the cap lives in.
  {
    const { root, anchor } = scenarioRoot('byte-cap', quick ? 40 : 80);
    const runWrite = (bytes, cfgCap = null) => {
      if (cfgCap !== null) {
        const p = path.join(root, '.mem', 'config.json');
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        c.maxEntryBytes = cfgCap;
        fs.writeFileSync(p, JSON.stringify(c));
      }
      const script = 'const m=await import(process.argv[1]);'
        + 'const big="bulkfillerword ".repeat(Math.ceil(Number(process.argv[3])/15));'
        + 'try{const r=m.logEntry(process.argv[2],"learning",{title:"oversize probe",text:big});'
        + 'console.log(JSON.stringify({ok:true,bytes:Buffer.byteLength(JSON.stringify(r.entry))}));}'
        + 'catch(e){console.log(JSON.stringify({ok:false,error:String(e.message).slice(0,300)}));}';
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script,
        path.join(REPO, 'src', 'memory.mjs'), root, String(bytes)],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { ok: false, error: `harness: ${r.stderr.slice(0, 200)}` }; }
    };

    const over = runWrite(1_200_000);
    const under = runWrite(400_000);
    const raised = runWrite(1_200_000, 8 * 1024 * 1024);
    // put the config back so nothing downstream inherits the raised cap
    {
      const p = path.join(root, '.mem', 'config.json');
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      delete c.maxEntryBytes;
      fs.writeFileSync(p, JSON.stringify(c));
    }

    atlas.record({
      id: 'robust.byte-cap.refuses',
      title: 'an entry over MAX_ENTRY_BYTES is refused, with both numbers in the error',
      verdict: !over.ok && /\d+ bytes, cap is \d+ bytes/.test(over.error ?? '')
        ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'refused; the error names the actual size and the cap',
      actual: over.ok ? `written anyway, ${over.bytes} bytes` : over.error,
      measured: { over, capBytes: 1024 * 1024 },
      severity: SEVERITY.CRITICAL,
    });
    atlas.record({
      id: 'robust.byte-cap.positive',
      title: 'positive control: a large-but-legal entry is written',
      verdict: under.ok ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'a ~400 kB entry goes through',
      actual: under.ok ? `${under.bytes} bytes written` : under.error,
      severity: SEVERITY.MAJOR,
    });
    atlas.record({
      id: 'robust.byte-cap.counter-probe',
      title: 'counter-probe: with maxEntryBytes raised, the same entry is accepted',
      verdict: raised.ok ? VERDICT.PASS : VERDICT.DEGRADED,
      expected: 'the cap — and nothing else — is what refused it',
      actual: raised.ok ? `${raised.bytes} bytes written under an 8 MB cap` : raised.error,
      measured: { raised },
      severity: SEVERITY.MINOR,
    });

    // The documented exemption: docs/security-model.md:173-180 says the
    // cap does NOT apply to raw/ captures. Measured, not assumed — an
    // admitted hole that is not checked is an admitted hole that may
    // have moved.
    const transcript = path.join(root, 'transcript.jsonl');
    const huge = 'bulkfillerword '.repeat(Math.ceil(1_400_000 / 15));
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(), message: { content: huge },
    })}\n`);
    const capScript = 'const r=await import(process.argv[1]);'
      + 'const out=r.capture(process.argv[2],process.argv[3],{minBytes:1024});'
      + 'console.log(JSON.stringify({status:out.status,reason:out.reason??null,path:out.path??null}));';
    const capRun = spawnSync(process.execPath, ['--input-type=module', '-e', capScript,
      path.join(REPO, 'src', 'raw.mjs'), root, transcript],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    let capOut = null;
    try { capOut = JSON.parse(capRun.stdout.trim().split('\n').pop()); } catch { /* reported below */ }

    let biggestRawLine = null;
    if (capOut && capOut.status === 'captured') {
      const abs = path.isAbsolute(capOut.path) ? capOut.path : path.join(root, capOut.path);
      try {
        const text = zlib.gunzipSync(fs.readFileSync(abs)).toString('utf8');
        biggestRawLine = Math.max(...text.split('\n').map((l) => Buffer.byteLength(l)));
      } catch { /* reported as null */ }
    }
    atlas.record({
      id: 'robust.byte-cap.raw-exempt',
      title: 'the 1 MB cap does not apply to raw/ captures (documented, and still true)',
      verdict: biggestRawLine === null ? VERDICT.NOT_MEASURED
        : (biggestRawLine > 1024 * 1024 ? VERDICT.PASS : VERDICT.DEGRADED),
      expected: 'docs/security-model.md:173-180 — raw/ is exempt; a >1 MB line lands',
      actual: biggestRawLine === null
        ? `capture did not produce a file: ${JSON.stringify(capOut)} ${capRun.stderr.slice(0, 200)}`
        : `largest captured line ${biggestRawLine} bytes (${(biggestRawLine / 1048576).toFixed(2)} MB)`,
      measured: { capture: capOut, biggestRawLine, entryCapBytes: 1024 * 1024 },
      severity: SEVERITY.INFO,
    });
    if (biggestRawLine === null) {
      atlas.blind('raw/ capture above the entry cap',
        `raw.capture returned ${JSON.stringify(capOut)} instead of a file`);
    }

    // The three commands, over a memory that now holds a 400 kB entry and
    // a 1.3 MB capture. An oversize-but-legal entry is a state the memory
    // has to keep answering in, not only refuse at the door.
    const obs = observe(root, anchor);
    atlas.record({
      id: 'robust.byte-cap.still-answers',
      title: 'doctor, find and context still answer with an oversize entry and capture present',
      verdict: obs.find.status === 0 && obs.find.hits > 0 && obs.context.status === 0
        ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'all three complete and the anchor is still found',
      actual: `doctor exit ${obs.doctor.status}, find exit ${obs.find.status} `
        + `(${obs.find.hits} hits, ${obs.find.n} entries), context exit ${obs.context.status}`,
      measured: {
        searchN: obs.find.n,
        onDisk: obs.disk.parseable,
        gapStated: statesTheGap(obs),
        nonOkFindings: Object.fromEntries([...obs.doctor.findings].filter(([, f]) => f.level !== 'ok')),
      },
      severity: SEVERITY.MAJOR,
    });
  }

  // --- 10. garbage timestamps ----------------------------------------
  //
  // One shape per root, on purpose. Put into one root, the unparseable
  // timestamp takes over the `env/clock` line ("the newest entry has an
  // unparseable timestamp") and the future entry — the thing that check
  // exists for — never gets named. One defect masking another is exactly
  // the kind of result a combined probe reports as a pass.
  {
    const baseInteg = base.doctor.findings.get('integrity');
    const baseQ = Number(/(\d+) questionable timestamp/.exec(baseInteg?.detail ?? '')?.[1] ?? 0);
    const future = new Date(Date.now() + 400 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const shapes = [
      {
        key: 'future',
        title: 'a timestamp 400 days in the future',
        line: entryLine('tsfuture', { ts: future, title: 'badtsmarker future' }),
        expectQuestionable: true,
        expectClock: true,
      },
      {
        key: 'unparseable',
        title: 'a timestamp that does not parse',
        line: entryLine('tsjunk', { ts: 'not-a-date-at-all', title: 'badtsmarker junk' }),
        expectQuestionable: true,
        expectClock: false,
      },
      {
        key: 'missing',
        title: 'no `ts` field at all',
        line: `${JSON.stringify({ id: 'tsmissing', title: 'badtsmarker missing', text: 'this entry has no ts at all', tags: ['probe'] })}\n`,
        // Still expected to be reported. An entry without a timestamp
        // cannot be ordered, cannot be reached by `mem when`, and reads
        // as "whenever" to every freshness rule in the system. Writing
        // the expectation as "no check covers this shape" would turn a
        // hole in the coverage into a green record, which is the exact
        // move this harness exists to refuse.
        expectQuestionable: true,
        expectClock: false,
        why: 'src/integrity.mjs scanIntegrity guards every timestamp check with '
          + '`if (e.ts !== undefined)`, so an absent `ts` is examined by none of them.',
      },
    ];

    for (const s of shapes) {
      const { root, anchor } = scenarioRoot(`bad-ts-${s.key}`, N);
      fs.appendFileSync(path.join(root, 'global', 'events.jsonl'), s.line);
      const obs = observe(root, anchor);
      const integ = obs.doctor.findings.get('integrity');
      const clock = obs.doctor.findings.get('env/clock');
      const qCount = Number(/(\d+) questionable timestamp/.exec(integ?.detail ?? '')?.[1] ?? 0);
      const marked = qCount > baseQ
        || (s.expectClock && (clock?.level === 'fail' || clock?.level === 'warn'));
      const find = mem(['find', 'badtsmarker'], { root });
      const hits = /^(\d+) hits/.test(find.stdout) ? Number(/^(\d+) hits/.exec(find.stdout)[1]) : 0;

      atlas.record({
        id: `robust.bad-ts-${s.key}.established`,
        title: `${s.title}: one such entry appended`,
        verdict: diskTruth(root).parseable === base.disk.parseable + 1 ? VERDICT.PASS : VERDICT.NOT_MEASURED,
        expected: `${base.disk.parseable + 1} parseable entries on disk`,
        actual: `${diskTruth(root).parseable}`,
      });
      atlas.record({
        id: `robust.bad-ts-${s.key}.noticed`,
        title: `${s.title} is reported by some finding`,
        verdict: marked ? VERDICT.PASS : VERDICT.DEGRADED,
        expected: `reported — questionable-timestamp count above the baseline ${baseQ}`
          + `${s.expectClock ? ', or env/clock' : ''}`,
        actual: marked
          ? `reported — questionable ${qCount} (baseline ${baseQ}), env/clock ${clock?.level}: ${clock?.detail ?? ''}`
          : `silent — questionable ${qCount} (baseline ${baseQ}), env/clock ${clock?.level}: ${clock?.detail ?? ''}`,
        measured: {
          questionable: qCount,
          baselineQuestionable: baseQ,
          clock: clock ?? null,
          integrity: integ ?? null,
          entryForm: obs.doctor.findings.get('entry-form') ?? null,
          changedVsBaseline: changedVsBase(obs, base),
          ...(s.why ? { why: s.why } : {}),
        },
        severity: s.key === 'missing' ? SEVERITY.MINOR : SEVERITY.MAJOR,
      });
      atlas.record({
        id: `robust.bad-ts-${s.key}.still-readable`,
        title: `${s.title}: the entry is still findable, not silently dropped`,
        verdict: find.status === 0 && hits > 0 ? VERDICT.PASS : VERDICT.DEGRADED,
        expected: 'the entry comes back from find',
        actual: find.stdout.split('\n')[0],
        measured: { hits, searchN: indexN(find.stdout), onDisk: diskTruth(root).parseable },
        severity: SEVERITY.MINOR,
      });
    }
  }
}

// ---------------------------------------------------------------------
// Part 2 — concurrency
// ---------------------------------------------------------------------

const WORKER = `
import * as memory from '%REPO%/src/memory.mjs';
const [root, w, m, pad, startAt] = process.argv.slice(2);
const padding = 'concurrentpad '.repeat(Math.ceil(Number(pad) / 15));
// A start barrier: without it the first worker is already finished before
// the last one has loaded its modules, and the probe measures process
// startup jitter instead of contention.
while (Date.now() < Number(startAt)) { /* spin to the barrier */ }
for (let i = 0; i < Number(m); i += 1) {
  memory.logEntry(root, 'learning', {
    title: 'cw ' + w + ' ' + i,
    text: 'concurrentmarker w' + w + 'e' + i + ' ' + padding,
    tags: ['cw'],
  });
}
`;

/** A bare memory: a config and nothing else, so only the writers' lines are in it. */
function bareRoot(prefix) {
  const root = tempRoot(`atlas-robust-${prefix}-`);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ participants: { user: 'the human', session: 'a session' }, language: 'en' }));
  return root;
}

/** What the log looks like after a round of writers. */
function inspectLog(root, expected) {
  const p = path.join(root, 'global', 'learnings.jsonl');
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const rows = text.split('\n').filter((l) => l.trim());
  const markers = new Set();
  const ids = new Map();
  let torn = 0;
  for (const row of rows) {
    let e;
    try { e = JSON.parse(row); } catch { torn += 1; continue; }
    const m = /concurrentmarker (w\d+e\d+)/.exec(e.text ?? '');
    if (m) markers.add(m[1]);
    if (e.id) ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
  }
  const duplicates = [...ids.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  return {
    lines: rows.length,
    torn,
    found: markers.size,
    missing: expected - markers.size,
    duplicates: duplicates.length,
    duplicateIds: duplicates.slice(0, 5),
    trailingNewline: text.endsWith('\n'),
  };
}

/** One round: W workers x M entries, all released at the same moment. */
function concurrentRound(workerPath, { writers, perWorker, pad }) {
  const root = bareRoot(`cw${writers}-${pad}`);
  const startAt = Date.now() + 350;
  const kids = [];
  for (let w = 0; w < writers; w += 1) {
    kids.push(spawn(process.execPath,
      [workerPath, root, String(w), String(perWorker), String(pad), String(startAt)],
      { stdio: ['ignore', 'ignore', 'pipe'] }));
  }
  return new Promise((resolve) => {
    let left = kids.length;
    const errs = [];
    for (const k of kids) {
      k.stderr.on('data', (d) => errs.push(String(d).slice(0, 200)));
      k.on('exit', (code) => {
        if (code !== 0) errs.push(`worker exit ${code}`);
        left -= 1;
        if (left === 0) {
          const r = inspectLog(root, writers * perWorker);
          resolve({ ...r, root, workerErrors: errs.slice(0, 3), expected: writers * perWorker });
        }
      });
    }
  });
}

async function partConcurrency(atlas, quick) {
  const workerPath = path.join(bareRoot('worker-home'), 'worker.mjs');
  fs.writeFileSync(workerPath, WORKER.replace('%REPO%', REPO.split(path.sep).join('/')));

  // What the system itself claims about the guarantee under test. A pass
  // below is a statement about THIS filesystem and nothing else, so the
  // filesystem is recorded next to the result.
  const fsClaimRoot = bareRoot('fsclaim');
  const fsClaim = parseDoctor(mem(['doctor'], { root: fsClaimRoot }).stdout).get('env/append-atomicity');
  // Asked of the OS as well, not only of the code under test — a probe
  // that takes the system's word for the property it is checking is a
  // probe of nothing.
  const stat = spawnSync('stat', ['-f', '-c', '%T', fsClaimRoot], { encoding: 'utf8' });
  const df = spawnSync('df', ['-T', fsClaimRoot], { encoding: 'utf8' });
  const dfType = String(df.stdout).split('\n')[1]?.split(/\s+/)[1] ?? null;
  atlas.record({
    id: 'robust.concurrency.filesystem',
    title: 'which filesystem the concurrency numbers below were taken on',
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: `${fsClaim ? `doctor: ${fsClaim.level} — ${fsClaim.detail}` : 'doctor gave no env/append-atomicity finding'}`
      + ` | df: ${dfType ?? '?'} | statfs: ${String(stat.stdout).trim() || '?'}`,
    measured: {
      doctorFinding: fsClaim ?? null,
      dfType,
      statfsType: String(stat.stdout).trim() || null,
      tmpdir: path.dirname(fsClaimRoot),
      note: 'Every concurrency verdict below is a statement about THIS filesystem. '
        + 'docs/security-model.md:238-241 declares O_APPEND atomicity UNKNOWN where the '
        + 'filesystem cannot be determined, and names NFS as the case that breaks it — '
        + 'which no run on a local disk can speak to.',
    },
  });
  atlas.blind('O_APPEND atomicity on a filesystem that does not guarantee it (NFS, SMB, overlay)',
    `this run only touched ${dfType ?? 'the local tmpdir filesystem'}; the case the `
    + 'documentation warns about is out of reach from here');

  // The detector self-test. A probe that cannot see a torn line would
  // report "no interleaving" over a shredded file, and that is the most
  // expensive way to be wrong in this whole phase.
  {
    const root = bareRoot('detector');
    fs.writeFileSync(path.join(root, 'global', 'learnings.jsonl'),
      `${JSON.stringify({ id: 'a', text: 'concurrentmarker w0e0 x' })}\n`
      + '{"id":"b","text":"concurrentmar\n'
      + `${JSON.stringify({ id: 'a', text: 'concurrentmarker w0e1 x' })}\n`);
    const d = inspectLog(root, 3);
    atlas.record({
      id: 'robust.concurrency.detector',
      title: 'sabotage counter-probe: the detector sees a torn line, a gap and a duplicate id',
      verdict: d.torn === 1 && d.missing === 1 && d.duplicates === 1 ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'torn=1, missing=1, duplicates=1 on a deliberately shredded file',
      actual: `torn=${d.torn}, missing=${d.missing}, duplicates=${d.duplicates}`,
      measured: d,
      severity: SEVERITY.CRITICAL,
    });
  }

  const reps = quick ? 10 : 15;
  const cases = quick
    ? [
      { key: '8w-small', writers: 8, perWorker: 25, pad: 0, label: '8 writers, lines under PIPE_BUF' },
      { key: '8w-large', writers: 8, perWorker: 12, pad: 6000, label: '8 writers, lines over PIPE_BUF' },
      { key: '16w-large', writers: 16, perWorker: 8, pad: 6000, label: '16 writers, lines over PIPE_BUF' },
    ]
    : [
      { key: '8w-small', writers: 8, perWorker: 40, pad: 0, label: '8 writers, lines under PIPE_BUF' },
      { key: '16w-small', writers: 16, perWorker: 25, pad: 0, label: '16 writers, lines under PIPE_BUF' },
      { key: '8w-large', writers: 8, perWorker: 20, pad: 6000, label: '8 writers, lines over PIPE_BUF' },
      { key: '16w-large', writers: 16, perWorker: 12, pad: 6000, label: '16 writers, lines over PIPE_BUF' },
    ];

  for (const c of cases) {
    const rounds = [];
    const t0 = Date.now();
    for (let i = 0; i < reps; i += 1) {
      rounds.push(await concurrentRound(workerPath, c));
    }
    const ms = Date.now() - t0;
    const tornRounds = rounds.filter((r) => r.torn > 0).length;
    const missRounds = rounds.filter((r) => r.missing > 0).length;
    const dupRounds = rounds.filter((r) => r.duplicates > 0).length;
    const errRounds = rounds.filter((r) => r.workerErrors.length > 0).length;
    const lineBytes = c.pad === 0 ? '~200' : '~6100';

    const worst = rounds.find((r) => r.torn > 0 || r.missing > 0 || r.duplicates > 0);
    atlas.record({
      id: `robust.concurrency.${c.key}`,
      title: `${c.label} (${lineBytes} B/line), ${reps} rounds`,
      verdict: (tornRounds || missRounds || dupRounds) ? VERDICT.FAIL : VERDICT.PASS,
      expected: 'torn 0/N, missing 0/N, duplicate ids 0/N',
      actual: `torn ${tornRounds}/${reps}, missing ${missRounds}/${reps}, duplicate ids ${dupRounds}/${reps}`,
      measured: {
        rounds: reps,
        writers: c.writers,
        perWorker: c.perWorker,
        entriesPerRound: c.writers * c.perWorker,
        approxLineBytes: c.pad === 0 ? 200 : 6100,
        overPipeBuf: c.pad > 0,
        tornRate: `${tornRounds}/${reps}`,
        missingRate: `${missRounds}/${reps}`,
        duplicateIdRate: `${dupRounds}/${reps}`,
        workerErrorRounds: errRounds,
        totalTornLines: rounds.reduce((a, r) => a + r.torn, 0),
        totalMissing: rounds.reduce((a, r) => a + r.missing, 0),
        roundsMs: ms,
        note: 'A pass is a statement about this filesystem only — see '
          + 'robust.concurrency.filesystem. docs/security-model.md:238-241 '
          + 'declares O_APPEND atomicity UNKNOWN where the filesystem cannot be determined.',
      },
      evidence: worst
        ? `first bad round: torn=${worst.torn} missing=${worst.missing} `
          + `duplicates=${worst.duplicates} (${worst.duplicateIds.join(',')}) `
          + `lines=${worst.lines}/${worst.expected}`
        : null,
      ms,
      severity: missRounds ? SEVERITY.CRITICAL : SEVERITY.MAJOR,
    });
  }

  // Positive control: the same total volume written by ONE process must
  // be clean. If it is not, the probe is measuring its own harness.
  {
    const single = await concurrentRound(workerPath,
      { writers: 1, perWorker: quick ? 200 : 320, pad: 6000 });
    atlas.record({
      id: 'robust.concurrency.single-writer',
      title: 'positive control: one writer, same volume, same line size',
      verdict: single.torn === 0 && single.missing === 0 && single.duplicates === 0
        ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'torn 0, missing 0, duplicate ids 0',
      actual: `torn ${single.torn}, missing ${single.missing}, duplicates ${single.duplicates}`,
      measured: single,
      severity: SEVERITY.CRITICAL,
    });
  }

  // --- reading while writing -----------------------------------------
  {
    const root = bareRoot('read-while-write');
    buildCorpus(root, quick ? 300 : 900, { anchors: 2, seed: 7 });
    pastify(root);
    const anchorQuery = 'anchorphrase0zzq';
    mem(['find', anchorQuery], { root });     // a warm cache, like a real session

    const writers = 8;
    const startAt = Date.now() + 400;
    const kids = [];
    for (let w = 0; w < writers; w += 1) {
      kids.push(spawn(process.execPath,
        [workerPath, root, String(w), String(quick ? 30 : 60), '6000', String(startAt)],
        { stdio: 'ignore' }));
    }
    const reads = [];
    const deadline = Date.now() + (quick ? 2500 : 4000);
    while (Date.now() < deadline && kids.some((k) => k.exitCode === null)) {
      const r = mem(['find', anchorQuery], { root, timeoutMs: 30000 });
      reads.push({
        status: r.status,
        hits: /^(\d+) hits/.test(r.stdout) ? Number(/^(\d+) hits/.exec(r.stdout)[1]) : 0,
        n: indexN(r.stdout),
        stderr: r.stderr.slice(0, 200),
      });
    }
    await new Promise((res) => {
      let left = kids.filter((k) => k.exitCode === null).length;
      if (left === 0) { res(); return; }
      for (const k of kids) {
        if (k.exitCode !== null) continue;
        k.on('exit', () => { left -= 1; if (left === 0) res(); });
      }
    });

    const bad = reads.filter((r) => r.status !== 0);
    const empty = reads.filter((r) => r.status === 0 && r.hits === 0);
    atlas.record({
      id: 'robust.concurrency.read-while-write',
      title: 'a `mem find` while 8 writers append: clean answer or clean error, never garbage',
      verdict: reads.length === 0 ? VERDICT.NOT_MEASURED
        : (bad.length === 0 && empty.length === 0 ? VERDICT.PASS
          : (empty.length ? VERDICT.FAIL : VERDICT.DEGRADED)),
      expected: 'every read exits 0 and still returns the anchor',
      actual: reads.length === 0 ? 'no read completed during the write window'
        : `${reads.length} reads: ${bad.length} non-zero exit, ${empty.length} lost the anchor`,
      measured: {
        reads: reads.length,
        nonZeroExit: bad.length,
        lostAnchor: empty.length,
        corpusSeenRange: reads.length ? [Math.min(...reads.map((r) => r.n ?? 0)), Math.max(...reads.map((r) => r.n ?? 0))] : null,
        firstBad: bad[0] ?? null,
        finalDisk: diskTruth(root),
      },
      evidence: bad.length ? JSON.stringify(bad.slice(0, 3), null, 2) : null,
      severity: SEVERITY.MAJOR,
    });
    if (reads.length === 0) {
      atlas.blind('read during concurrent writes',
        'the writers finished before a single read completed — the window could not be hit');
    }
  }
}

// ---------------------------------------------------------------------
// Part 3 — resources
// ---------------------------------------------------------------------

function logBytes(root) {
  let n = 0;
  for (const f of jsonlFiles(root)) n += fs.statSync(f).size;
  return n;
}

function cacheBytes(root) {
  try { return fs.statSync(path.join(root, '.mem', 'search-index.json')).size; } catch { return 0; }
}

async function partResources(atlas, quick) {
  const sizes = quick ? [500, 1000, 2000] : [1000, 3000, 10000];

  // --- disk growth ---------------------------------------------------
  const growth = [];
  const roots = new Map();
  for (const n of sizes) {
    const root = tempRoot(`atlas-robust-grow${n}-`);
    const corpus = buildCorpus(root, n, { anchors: 2, seed: 11 });
    const find = mem(['find', corpus.anchors[0].phrase], { root });
    growth.push({
      entries: n,
      logBytes: logBytes(root),
      cacheBytes: cacheBytes(root),
      totalBytes: dirBytes(root),
      perThousandLogKB: +((logBytes(root) / n) * 1000 / 1024).toFixed(1),
      perThousandCacheKB: +((cacheBytes(root) / n) * 1000 / 1024).toFixed(1),
      perThousandTotalKB: +((dirBytes(root) / n) * 1000 / 1024).toFixed(1),
      findMs: find.ms,
      searchN: indexN(find.stdout),
    });
    roots.set(n, { root, anchor: corpus.anchors[0].phrase });
  }
  const linear = growth.every((g, i) => i === 0
    || Math.abs(g.perThousandTotalKB - growth[0].perThousandTotalKB) / growth[0].perThousandTotalKB < 0.35);
  atlas.record({
    id: 'robust.resources.disk-growth',
    title: `disk per 1000 entries at ${sizes.join(' / ')} entries`,
    verdict: linear ? VERDICT.PASS : VERDICT.DEGRADED,
    expected: 'bytes per 1000 entries stays within 35 % across the range (no superlinear term)',
    actual: growth.map((g) => `${g.entries}: ${g.perThousandTotalKB} kB/1k `
      + `(log ${g.perThousandLogKB}, cache ${g.perThousandCacheKB})`).join('; '),
    measured: { curve: growth },
    severity: SEVERITY.MINOR,
  });

  // --- heap at find --------------------------------------------------
  const small = roots.get(sizes[0]);
  const large = roots.get(sizes[sizes.length - 1]);
  // `pathToFileURL`, not a bare path: an ESM specifier is a URL, and on
  // Windows Node reads the drive letter of "D:\src\…" as a scheme and
  // refuses with ERR_UNSUPPORTED_ESM_URL_SCHEME. The repo has a guard for
  // exactly this (test/windows-paths.test.mjs) and it caught this line —
  // a benchmark that cannot run on one of the three supported platforms
  // measures two of them and calls the answer general.
  const search = await import(pathToFileURL(path.join(REPO, 'src', 'search.mjs')).href);

  const heapRows = [];
  for (const [label, r, n] of [['small', small, sizes[0]], ['large', large, sizes[sizes.length - 1]]]) {
    const rssBefore = process.resourceUsage().maxRSS;
    const h = heapAround(() => {
      const index = search.loadIndex(r.root, { fresh: true });
      return search.search(index, r.anchor, { top: 10 });
    });
    const rssAfter = process.resourceUsage().maxRSS;

    // The same work in a fresh process. maxRSS there is a real peak from
    // the kernel, not a pair of endpoint samples — the in-process number
    // and this one measure different things and are printed side by side
    // rather than being averaged into one misleading figure.
    const script = 'const s=await import(process.argv[1]);'
      + 'const i=s.loadIndex(process.argv[2],{fresh:true});'
      + 'const hits=s.search(i,process.argv[3],{top:10});'
      + 'console.log(JSON.stringify({maxRssMB:+(process.resourceUsage().maxRSS/1024).toFixed(1),'
      + 'heapMB:+(process.memoryUsage().heapUsed/1048576).toFixed(1),hits:hits.length,N:i.N}));';
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      path.join(REPO, 'src', 'search.mjs'), r.root, r.anchor],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
    let proc = null;
    try { proc = JSON.parse(child.stdout.trim().split('\n').pop()); } catch { /* recorded as null */ }

    heapRows.push({
      label,
      entries: n,
      inProcessPeakMB: h.peakMB,
      inProcessDeltaMB: h.deltaMB,
      peakIsEndpointOnly: h.peakIsEndpointOnly,
      samples: h.sampled,
      processMaxRssDeltaMB: +((rssAfter - rssBefore) / 1024).toFixed(1),
      freshProcess: proc,
      hits: h.value?.length ?? null,
    });
  }
  const bigger = heapRows[1];
  const smaller = heapRows[0];
  const perEntryKB = bigger.freshProcess && smaller.freshProcess
    ? +(((bigger.freshProcess.maxRssMB - smaller.freshProcess.maxRssMB) * 1024)
       / (bigger.entries - smaller.entries)).toFixed(2)
    : null;
  atlas.record({
    id: 'robust.resources.heap-find',
    title: `heap and peak RSS for one \`find\` at ${smaller.entries} vs ${bigger.entries} entries`,
    verdict: perEntryKB === null ? VERDICT.NOT_MEASURED
      : (perEntryKB > 0 && perEntryKB < 40 ? VERDICT.PASS : VERDICT.DEGRADED),
    expected: 'under 40 kB of resident memory per stored entry, and no worse than linear',
    actual: perEntryKB === null ? 'the fresh-process measurement did not return'
      : `${perEntryKB} kB RSS per entry; `
        + `${smaller.entries}: ${smaller.freshProcess?.maxRssMB} MB, `
        + `${bigger.entries}: ${bigger.freshProcess?.maxRssMB} MB`,
    measured: {
      rows: heapRows,
      perEntryKB,
      note: 'in-process heapAround is endpoint-only for synchronous work (core.mjs says so '
        + 'via peakIsEndpointOnly); the fresh-process maxRSS is a kernel-reported peak. '
        + 'Both are printed because they answer different questions.',
    },
    severity: SEVERITY.MINOR,
  });
  if (perEntryKB === null) {
    atlas.blind('heap peak of `mem find` in a fresh process',
      'the child process measuring loadIndex+search did not return parseable output');
  }

  // --- the cache write threshold -------------------------------------
  //
  // `search.CACHE_WRITE_AFTER_BYTES` (src/search.mjs:1041) is 4 MB of NEW
  // LOG BYTES, not 4 MB of cache. Reaching it with ordinary entries would
  // need a corpus far past the 20 % rebuild fraction, at which point a
  // different branch runs and the threshold is never consulted. So the
  // new bytes are delivered in a handful of large-but-legal entries: few
  // enough to stay inside the append window, heavy enough to cross the
  // line. Probe, counter-probe and positive control, in that order.
  {
    const mkBulk = (n) => {
      const root = tempRoot(`atlas-robust-cache${n}-`);
      const corpus = buildCorpus(root, 1000, { anchors: 1, seed: 13 });
      mem(['find', corpus.anchors[0].phrase], { root });     // cache exists now
      const before = { bytes: cacheBytes(root), mtime: fs.statSync(path.join(root, '.mem', 'search-index.json')).mtimeMs };
      const target = path.join(root, 'global', 'learnings.jsonl');
      const logBefore = logBytes(root);
      const filler = 'bulkfillerword '.repeat(Math.ceil(800_000 / 15));
      for (let i = 0; i < n; i += 1) {
        fs.appendFileSync(target, entryLine(`bulk${i}`, { text: `bulk entry ${i} ${filler}` }));
      }
      const newBytes = logBytes(root) - logBefore;
      const find = mem(['find', corpus.anchors[0].phrase], { root, timeoutMs: 180000 });
      const after = { bytes: cacheBytes(root), mtime: fs.statSync(path.join(root, '.mem', 'search-index.json')).mtimeMs };
      return {
        n,
        approxNewLogBytes: newBytes,
        thresholdBytes: 4 * 1024 * 1024,
        rewritten: after.mtime !== before.mtime || after.bytes !== before.bytes,
        before,
        after,
        findExit: find.status,
        findMs: find.ms,
        searchN: indexN(find.stdout),
        onDisk: diskTruth(root).parseable,
        newBytes,
      };
    };

    const over = mkBulk(6);    // ~4.8 MB new log bytes — above the threshold
    const under = mkBulk(2);   // ~1.6 MB new log bytes — below it

    atlas.record({
      id: 'robust.resources.cache-threshold',
      title: 'above CACHE_WRITE_AFTER_BYTES (4 MB of new log) the cache is written again',
      verdict: over.rewritten ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'src/search.mjs:1041 — the cache file is rewritten once ~4 MB of new log accumulated',
      actual: `${(over.approxNewLogBytes / 1048576).toFixed(2)} MB of new log -> `
        + (over.rewritten
          ? `cache rewritten, ${(over.before.bytes / 1048576).toFixed(2)} -> ${(over.after.bytes / 1048576).toFixed(2)} MB`
          : 'cache NOT rewritten'),
      measured: over,
      severity: SEVERITY.MINOR,
    });
    atlas.record({
      id: 'robust.resources.cache-threshold-counter',
      title: 'counter-probe: below the threshold the cache is left alone',
      verdict: !under.rewritten ? VERDICT.PASS : VERDICT.DEGRADED,
      expected: 'new log under the threshold does NOT trigger a rewrite — otherwise the probe above measures nothing',
      actual: `${(under.approxNewLogBytes / 1048576).toFixed(2)} MB of new log -> `
        + (under.rewritten ? 'rewritten anyway' : 'cache left alone, as documented'),
      measured: under,
      severity: SEVERITY.MINOR,
    });
    atlas.record({
      id: 'robust.resources.cache-correctness',
      title: 'whether the cache was rewritten or not, the answer covers the whole log',
      verdict: over.searchN === over.onDisk && under.searchN === under.onDisk
        ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'search N equals the entries on disk in both cases',
      actual: `above: ${over.searchN}/${over.onDisk}, below: ${under.searchN}/${under.onDisk}`,
      measured: { over: { searchN: over.searchN, onDisk: over.onDisk }, under: { searchN: under.searchN, onDisk: under.onDisk } },
      severity: SEVERITY.CRITICAL,
    });

    // Positive control: a root with no cache at all must produce one.
    const fresh = tempRoot('atlas-robust-cache-fresh-');
    const fc = buildCorpus(fresh, 300, { anchors: 1, seed: 17 });
    const had = cacheBytes(fresh);
    mem(['find', fc.anchors[0].phrase], { root: fresh });
    atlas.record({
      id: 'robust.resources.cache-positive',
      title: 'positive control: a first search writes a cache where there was none',
      verdict: had === 0 && cacheBytes(fresh) > 0 ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'no cache before, a cache after',
      actual: `${had} -> ${cacheBytes(fresh)} bytes`,
      severity: SEVERITY.MAJOR,
    });
  }

  // --- cache size against corpus size --------------------------------
  atlas.record({
    id: 'robust.resources.cache-size',
    title: 'index cache size against corpus size',
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: growth.map((g) => `${g.entries} entries -> `
      + `${(g.cacheBytes / 1048576).toFixed(2)} MB cache over `
      + `${(g.logBytes / 1048576).toFixed(2)} MB of log `
      + `(x${(g.cacheBytes / Math.max(1, g.logBytes)).toFixed(2)})`).join('; '),
    measured: {
      curve: growth.map((g) => ({
        entries: g.entries, cacheBytes: g.cacheBytes, logBytes: g.logBytes,
        cacheOverLog: +(g.cacheBytes / Math.max(1, g.logBytes)).toFixed(2),
      })),
      cacheWriteAfterBytes: 4 * 1024 * 1024,
      note: 'No expectation is stated because none is documented. The ratio is what a '
        + 'later run compares against.',
    },
  });
}

// ---------------------------------------------------------------------

export async function run(atlas, { quick = false } = {}) {
  atlas.phase('robust', 'Broken state and concurrent writers',
    'Three parts: ten broken states put to the memory one at a time, each in its own '
    + 'throwaway root; concurrent writers measured as a rate over repeated rounds rather '
    + 'than as a single yes/no; and the three resource curves. Every state that could not '
    + 'be produced is `not-measured` and named in the blind-spot list — never dropped.');
  await partBroken(atlas, quick);
  await partConcurrency(atlas, quick);
  await partResources(atlas, quick);
}
