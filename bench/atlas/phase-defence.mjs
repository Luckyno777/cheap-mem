// bench/atlas/phase-defence.mjs — three defences, turned into three numbers.
//
// **What this phase is and is not.** Every probe below is a test stand
// against THIS system, in a throwaway directory from `tempRoot()`, aimed
// at a limit the house has already written down in
// `docs/security-model.md`. Nothing here attacks anything that is not
// ours, nothing here leaves the temp directory, and the git commands
// only ever run inside a throwaway `git init` clone — never against the
// repository this file lives in.
//
// The three numbers:
//
//   1. bidi coverage   — of the output surfaces that actually SHOW an
//                        entry, how many neutralise a Trojan-Source
//                        override character (CVE-2021-42574)?
//   2. the flood curve  — at what flood size N does the one true entry
//                        fall out of the first three claims, per flood
//                        variant?
//   3. tamper detection — of five manipulations, how many make at least
//                        one on-board tool go red?
//
// **Every probe carries a positive control and a counter-probe.** A
// coverage number is worthless without evidence that the payload reached
// the surface at all (otherwise "no override character in the output"
// just means the entry was never displayed), a rank is worthless without
// the unflooded rank to compare it to, and a red light is worthless
// without a baseline run that is NOT red — the throwaway clones here all
// carry one standing red (`env/pre-commit`, no hooksPath in a bare
// `git init`), so an unbaselined check would have counted all five
// scenarios as caught.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { VERDICT, SEVERITY, REPO, mem, tempRoot } from './core.mjs';

// --- the payload -------------------------------------------------------

/** RIGHT-TO-LEFT OVERRIDE: one of the nine `src/bidi.mjs` knows. */
const RLO = '‮';
/** ZERO WIDTH SPACE: deliberately NOT one of the nine. See below. */
const ZWSP = '​';
/** The marker that proves a surface printed our entry at all. */
const MARKER = 'zzqtrojanmarker';
/** What a neutralised RLO looks like coming out of `bidi.visible()`. */
const NEUTRALISED = '[U+202E';

const PAYLOAD = `safe${RLO}reversed${ZWSP}tail ${MARKER}`;

// ======================================================================
// 1. Bidi neutralisation across output surfaces
// ======================================================================

/**
 * Drive `bin/mem-mcp` over real stdio JSON-RPC.
 *
 * The MCP server is the door a FOREIGN agent reads through, so measuring
 * it by importing its handlers would measure the wrong thing: the
 * question is what comes back over the wire. One process, one
 * `initialize`, then every `tools/call` at once.
 *
 * Returns `{ ok, results, why }`. `ok: false` is a blind spot to report,
 * never a surface to drop — the optional `@modelcontextprotocol/sdk`
 * peer dependency may simply not be installed, and a run that quietly
 * skipped the MCP surface would report a clean bill of health for the
 * one path that matters most.
 */
function mcpCall(root, calls, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [path.join(REPO, 'bin', 'mem-mcp')], {
        env: { ...process.env, CHEAP_MEM_ROOT: root },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, results: new Map(), why: `spawn failed: ${e.message}` });
      return;
    }
    const results = new Map();
    let buf = '';
    let err = '';
    let settled = false;
    const done = (ok, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ok, results, why });
    };
    const timer = setTimeout(() => done(false,
      `no answer within ${timeoutMs} ms (${results.size}/${calls.length} replied); stderr: ${err.slice(0, 200)}`),
    timeoutMs);

    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => done(false, `child error: ${e.message}`));
    child.on('exit', (code) => {
      if (results.size < calls.length) {
        done(false, `server exited (code ${code}) after ${results.size}/${calls.length}; stderr: ${err.slice(0, 200)}`);
      }
    });
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          calls.forEach((c, i) => {
            child.stdin.write(`${JSON.stringify({
              jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: c,
            })}\n`);
          });
        } else if (typeof msg.id === 'number' && msg.id >= 100) {
          results.set(msg.id - 100, msg);
          if (results.size === calls.length) done(true, null);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cheap-mem-atlas', version: '1' },
      },
    })}\n`);
  });
}

/**
 * Collect what every reachable output surface does with one entry that
 * carries U+202E and U+200B.
 *
 * The payload is written into four entry TYPES, because the surfaces do
 * not all show the same types: `memory.context()` renders errors,
 * decisions and events, so a learning-only corpus would have made the
 * SessionStart surface look clean by never printing the entry.
 */
async function bidiSurfaces(root) {
  mem(['--root', root, 'init']);
  for (const [type, extra] of [
    ['learning', []],
    ['error', ['--class', 'measurement']],
    ['decision', ['--topic', `${MARKER} topic`, '--choice', PAYLOAD, '--why', PAYLOAD]],
    ['event', []],
  ]) {
    mem(['--root', root, 'log', type,
      '--title', `trojan ${MARKER}`, '--text', PAYLOAD,
      '--author', 'attacker', '--authority', 'agent', ...extra]);
  }

  const ids = [];
  const globalDir = path.join(root, 'global');
  let onDisk = '';
  for (const f of fs.readdirSync(globalDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const body = fs.readFileSync(path.join(globalDir, f), 'utf8');
    onDisk += body;
    for (const l of body.split('\n')) {
      if (!l.trim()) continue;
      try { const e = JSON.parse(l); if (e.id) ids.push(e.id); } catch { /* not ours */ }
    }
  }
  const id = ids[0];

  /** reader: who this surface feeds. 'foreign' is the severe one. */
  const surfaces = [];
  const add = (name, reader, text, note = null) => surfaces.push({
    name,
    reader,
    shown: String(text).includes(MARKER),
    raw: String(text).includes(RLO),
    neutralised: String(text).includes(NEUTRALISED),
    zwspRaw: String(text).includes(ZWSP),
    sample: String(text).slice(0, 240),
    note,
  });

  add('mem find', 'human', mem(['--root', root, 'find', MARKER]).stdout);
  add('mem show <id>', 'human', mem(['--root', root, 'show', id]).stdout);
  add('mem show <id> --json', 'machine', mem(['--root', root, 'show', id, '--json']).stdout);
  add('mem context', 'agent', mem(['--root', root, 'context']).stdout);
  add('mem retrieve', 'foreign', mem(['--root', root, 'retrieve', MARKER]).stdout);
  add('mem board --html', 'human', mem(['--root', root, 'board', '--html']).stdout);
  add('mem board --json', 'machine', mem(['--root', root, 'board', '--json']).stdout);

  const viewerOut = path.join(root, 'atlas-viewer.html');
  const v = mem(['--root', root, 'viewer', '--out', viewerOut]);
  add('mem viewer --out (HTML)', 'human',
    v.status === 0 && fs.existsSync(viewerOut) ? fs.readFileSync(viewerOut, 'utf8') : '',
    v.status === 0 ? null : `viewer exited ${v.status}: ${v.stderr.slice(0, 120)}`);

  // The per-turn hook. It is a bash script; where bash is absent this
  // becomes a blind spot rather than a silent omission.
  const hook = spawnSync('bash', [path.join(REPO, 'bin', 'mem-retrieve')], {
    input: JSON.stringify({ prompt: `what do we know about ${MARKER}`, session_id: 'atlas-defence' }),
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      CHEAP_MEM_ROOT: root,
      MEM_RETRIEVE_MIN: '0',          // the threshold is not what is under test
      MEM_RETRIEVE_NO_PULL: '1',      // never touch a network from a benchmark
      MEM_RETRIEVE_TOP: '5',
      MEM_RETRIEVE_OFF: '',
      MEM_HOOK_OFF: '',
    },
  });
  const hookOk = !hook.error && typeof hook.status === 'number';
  add('bin/mem-retrieve (stdin hook)', 'foreign', hookOk ? (hook.stdout ?? '') : '',
    hookOk ? null : `hook not runnable: ${hook.error ? hook.error.message : 'no exit status'}`);

  // The MCP bridge, over a real JSON-RPC tools/call.
  const calls = [
    { name: 'mem_show', arguments: { id } },
    { name: 'mem_find', arguments: { query: MARKER, top: 5 } },
    { name: 'mem_retrieve', arguments: { query: MARKER, top: 5 } },
    { name: 'mem_context', arguments: { n: 10 } },
  ];
  const mcp = await mcpCall(root, calls);
  for (let i = 0; i < calls.length; i += 1) {
    const msg = mcp.results.get(i);
    const text = msg ? JSON.stringify(msg.result ?? msg.error ?? {}) : '';
    add(`bin/mem-mcp tools/call ${calls[i].name}`, 'foreign', text,
      msg ? null : (mcp.why ?? 'no reply'));
  }

  return { surfaces, onDisk, id, mcpOk: mcp.ok, mcpWhy: mcp.why };
}

async function metricBidi(atlas) {
  const root = tempRoot('atlas-bidi-');
  const { surfaces, onDisk, mcpOk, mcpWhy } = await bidiSurfaces(root);

  // --- positive control: the character really is on disk, unmarked ---
  //
  // docs/security-model.md:266 says exactly this, and the whole coverage
  // number rests on it: if the write path had stripped the character,
  // every surface below would read "clean" for the wrong reason.
  atlas.record({
    id: 'defence.bidi.on-disk',
    title: 'positive control: U+202E survives the write path, unmarked on disk',
    verdict: onDisk.includes(RLO) && !onDisk.includes(NEUTRALISED) ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'raw U+202E present in the JSONL, no [U+202E] marker (security-model.md:266)',
    actual: `raw on disk: ${onDisk.includes(RLO)}, marker on disk: ${onDisk.includes(NEUTRALISED)}`,
    measured: { bytes: onDisk.length },
    severity: SEVERITY.INFO,
  });

  const shown = surfaces.filter((s) => s.shown);
  const silent = surfaces.filter((s) => !s.shown);
  for (const s of silent) {
    atlas.blind(`bidi surface: ${s.name}`,
      s.note ?? 'the surface never printed the entry, so it could not be judged — '
        + 'not counted as neutralising and not counted as leaking');
  }

  const neutralising = shown.filter((s) => s.neutralised && !s.raw);
  const leaking = shown.filter((s) => s.raw);
  const foreignLeaking = leaking.filter((s) => s.reader === 'foreign');

  const table = surfaces.map((s) => ({
    surface: s.name,
    reader: s.reader,
    displayedTheEntry: s.shown,
    neutralised: s.shown ? (s.neutralised && !s.raw) : null,
    rawOverrideCharacter: s.shown ? s.raw : null,
    note: s.note,
  }));

  atlas.record({
    id: 'defence.bidi.coverage',
    title: `bidi neutralisation across output surfaces: ${neutralising.length} of ${shown.length}`,
    verdict: foreignLeaking.length ? VERDICT.FAIL
      : leaking.length ? VERDICT.DEGRADED : VERDICT.PASS,
    expected: 'every surface that displays an entry marks U+202E — the four named in '
      + 'security-model.md (display.compactLine, memory.context(), browse.fit(), bin/mem-retrieve) do',
    actual: `${neutralising.length} of ${shown.length} neutralise; raw: `
      + (leaking.map((s) => s.name).join(', ') || 'none'),
    measured: {
      surfacesTotal: surfaces.length,
      surfacesThatDisplayedTheEntry: shown.length,
      neutralising: neutralising.map((s) => s.name),
      passingItRaw: leaking.map((s) => s.name),
      passingItRawToAForeignAgent: foreignLeaking.map((s) => s.name),
      neverDisplayedTheEntry: silent.map((s) => s.name),
      table,
    },
    evidence: leaking.map((s) => `${s.name}: ${JSON.stringify(s.sample.slice(0, 120))}`).join('\n'),
    severity: foreignLeaking.length ? SEVERITY.CRITICAL : SEVERITY.MAJOR,
  });

  if (!mcpOk) {
    atlas.blind('bin/mem-mcp (JSON-RPC tools/call)',
      mcpWhy ?? 'the MCP server could not be driven to a reply');
  }

  // --- U+200B: out of scope BY DESIGN, and measured anyway -----------
  //
  // `src/bidi.mjs` documents a CLOSED list of nine codepoints and argues
  // for it. ZWSP is not on it, so no surface marking ZWSP is the
  // designed behaviour, not a gap — recording it keeps the next reader
  // from "discovering" it as a finding.
  const zwspAltered = shown.filter((s) => !s.zwspRaw);
  atlas.record({
    id: 'defence.bidi.zwsp-out-of-scope',
    title: 'U+200B is outside the closed nine-codepoint list, by design',
    verdict: zwspAltered.length === 0 ? VERDICT.PASS : VERDICT.DEGRADED,
    expected: '0 of the displaying surfaces touch U+200B — src/bidi.mjs is a closed '
      + 'list of U+202A-U+202E and U+2066-U+2069, and says why',
    actual: `${shown.length - zwspAltered.length} of ${shown.length} displaying surfaces `
      + `pass U+200B through raw; ${zwspAltered.length} alter it`,
    measured: { surfacesThatAlteredZwsp: zwspAltered.map((s) => s.name) },
    severity: SEVERITY.INFO,
  });

  // --- counter-probe: no false positive on innocent text -------------
  const clean = tempRoot('atlas-bidi-clean-');
  mem(['--root', clean, 'init']);
  mem(['--root', clean, 'log', 'learning',
    '--title', `innocent ${MARKER}`,
    // Hebrew and Arabic prose: real right-to-left text, none of the nine
    // controls. src/bidi.mjs is explicitly proven not to flag this.
    '--text', `shalom שלום עולם مرحبا بالعالم ${MARKER}`,
    '--author', 'ops', '--authority', 'agent']);
  const cleanFind = mem(['--root', clean, 'find', MARKER]).stdout;
  const cleanCtx = mem(['--root', clean, 'context']).stdout;
  const falsePositive = cleanFind.includes('[U+') || cleanCtx.includes('[U+');
  atlas.record({
    id: 'defence.bidi.no-false-positive',
    title: 'counter-probe: real Hebrew/Arabic text is not marked',
    verdict: !falsePositive && cleanFind.includes(MARKER) ? VERDICT.PASS
      : cleanFind.includes(MARKER) ? VERDICT.FAIL : VERDICT.NOT_MEASURED,
    expected: 'no [U+....] marker on text that contains no override character',
    actual: falsePositive ? 'a marker appeared on innocent right-to-left prose'
      : cleanFind.includes(MARKER) ? 'no marker, entry displayed' : 'the entry was not displayed at all',
    evidence: cleanFind.slice(0, 240),
    severity: SEVERITY.MAJOR,
  });

  return { neutralising: neutralising.length, shown: shown.length };
}

// ======================================================================
// 2. The flooding curve
// ======================================================================

const FLOOD_QUESTION = 'where does the production database run';
const TRUTH_ID = 'truth0001';
const FLOOD_SIZES = [1, 2, 3, 5, 8, 13, 21, 34, 50];
const FLOOD_VARIANTS = ['identical', 'one-word-varied', 'synonyms-swapped'];
const SYNONYM_VERBS = ['runs in', 'is hosted in', 'operates in', 'lives in',
  'is located in', 'sits in'];

/**
 * A corpus with exactly one true answer and `n` false ones.
 *
 * Written as JSONL directly rather than through `mem log`: fifty CLI
 * spawns per curve point would cost more than the whole rest of this
 * phase, and the write path is not what is under test here — the
 * SELECTION is.
 */
function floodCorpus(n, variant, { truthTier = 'agent', withTopic = false } = {}) {
  const root = tempRoot('atlas-flood-');
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user', 'agent'], language: 'en' }));

  const lines = [JSON.stringify({
    id: TRUTH_ID,
    ts: '2026-02-01T09:00:00Z',
    title: 'production database location',
    text: 'the production database runs in Frankfurt on the eu-central cluster',
    author: 'ops',
    authority: truthTier,
    tags: ['database'],
    // `potentialConflicts` groups by `topic`, so a corpus without one can
    // never be reported as contested. A learning or an error carries no
    // topic unless somebody sets it — and the attacker picks the type.
    ...(withTopic ? { topic: 'production database location' } : {}),
  })];

  for (let i = 0; i < n; i += 1) {
    let text;
    if (variant === 'identical') {
      // Byte-identical bodies. security-model.md says these collapse to
      // one during selection — this is the repair being confirmed.
      text = 'the production database runs in Singapore on the ap-southeast cluster';
    } else if (variant === 'one-word-varied') {
      text = `the production database runs in Singapore on the ap-southeast-${i} cluster`;
    } else {
      text = `the production database ${SYNONYM_VERBS[i % SYNONYM_VERBS.length]} `
        + 'Singapore on the ap-southeast cluster';
    }
    lines.push(JSON.stringify({
      id: `flood${String(i).padStart(4, '0')}`,
      ts: '2026-03-01T09:00:00Z',
      title: 'production database location',
      text,
      // A fresh author name per entry: rotating a name costs an attacker
      // nothing, which is exactly why the author share alone is weak.
      author: `flooder${i}`,
      authority: 'agent',
      tags: ['database'],
      ...(withTopic ? { topic: 'production database location' } : {}),
    }));
  }
  fs.writeFileSync(path.join(root, 'global', 'learnings.jsonl'), `${lines.join('\n')}\n`);
  return root;
}

/** One point on the curve. Returns nulls, never zeros, when it failed. */
function floodPoint(n, variant, opts = {}) {
  const root = floodCorpus(n, variant, opts);
  const r = mem(['--root', root, 'retrieve', FLOOD_QUESTION, '--top', '10', '--json']);
  if (r.status !== 0) {
    return { n, variant, ok: false, why: `exit ${r.status}: ${r.stderr.slice(0, 160)}` };
  }
  let j;
  try { j = JSON.parse(r.stdout); } catch (e) {
    return { n, variant, ok: false, why: `unparsable answer: ${e.message}` };
  }
  const claims = j.claims ?? [];
  const idx = claims.findIndex((c) => c.id === TRUTH_ID);
  const flood = claims.filter((c) => String(c.id ?? '').startsWith('flood')).length;
  return {
    n,
    variant,
    ok: true,
    claims: claims.length,
    floodClaims: flood,
    floodShare: claims.length ? +(flood / claims.length).toFixed(3) : null,
    truthRank: idx === -1 ? null : idx + 1,
    truthInTopThree: idx !== -1 && idx < 3,
    coverage: j.coverage?.state ?? null,
    // `contested` is what the docs name as the thing that actually
    // catches a flood (potentialConflicts). Read by its real field name:
    // a wrong name would report null forever and read as "never flagged".
    contestedGroups: Array.isArray(j.contested) ? j.contested.length : null,
    ms: r.ms,
  };
}

function metricFlood(atlas) {
  // --- positive control: without a flood, the truth is rank 1 --------
  const control = floodPoint(0, 'identical');
  atlas.record({
    id: 'defence.flood.control',
    title: 'positive control: with no flood, the true entry is rank 1',
    verdict: control.ok && control.truthRank === 1 ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'truthRank 1, floodShare 0',
    actual: control.ok ? `rank ${control.truthRank}, ${control.claims} claim(s)` : control.why,
    measured: control,
    severity: SEVERITY.CRITICAL,
  });

  const curve = {};
  const breakN = {};
  for (const variant of FLOOD_VARIANTS) {
    curve[variant] = [];
    breakN[variant] = null;
    for (const n of FLOOD_SIZES) {
      const p = floodPoint(n, variant);
      curve[variant].push(p);
      if (breakN[variant] === null && p.ok && !p.truthInTopThree) breakN[variant] = n;
    }
  }

  const failed = FLOOD_VARIANTS.flatMap((v) => curve[v]).filter((p) => !p.ok);
  const peakShare = Object.fromEntries(FLOOD_VARIANTS.map((v) => [v,
    Math.max(...curve[v].filter((p) => p.ok).map((p) => p.floodShare ?? 0))]));

  atlas.record({
    id: 'defence.flood.curve',
    title: 'smallest flood N at which the truth leaves the first three claims',
    verdict: failed.length ? VERDICT.NOT_MEASURED
      : Object.values(breakN).some((v) => v !== null) ? VERDICT.DEGRADED : VERDICT.PASS,
    expected: 'security-model.md:187-202 states bounded domination is NOT offered; a '
      + 'promised 50% author share delivered a measured 83%. So a finite N is expected '
      + 'for every variant that survives the identical-body collapse.',
    actual: FLOOD_VARIANTS.map((v) => `${v}: ${breakN[v] ?? 'never within N<=50'}`).join('; '),
    measured: {
      question: FLOOD_QUESTION,
      floodSizes: FLOOD_SIZES,
      smallestNThatPushesTruthOutOfTopThree: breakN,
      peakFloodShareOfTheAnswer: peakShare,
      curve,
      pointsThatFailed: failed,
    },
    severity: SEVERITY.MAJOR,
  });

  // --- what the docs say actually catches a flood --------------------
  //
  // security-model.md: "What actually catches a flood: `potentialConflicts`
  // reports it as contested". That is a claim about the ANSWER, so it is
  // measurable at the largest N of every variant.
  //
  // Measured twice on purpose. `potentialConflicts` groups by `topic`;
  // the curve corpus above is a plain learning entry, which carries no
  // topic unless someone sets one — and the attacker chooses the entry
  // type. So "0 flagged" on the curve corpus would be a statement about
  // the corpus, and the second run is what makes it a statement about
  // the detector.
  const withoutTopic = Object.fromEntries(FLOOD_VARIANTS.map((v) => {
    const last = curve[v][curve[v].length - 1];
    return [v, last.ok ? last.contestedGroups : null];
  }));
  const withTopic = Object.fromEntries(FLOOD_VARIANTS.map((v) => {
    const p = floodPoint(50, v, { withTopic: true });
    return [v, p.ok ? p.contestedGroups : null];
  }));
  const flaggedWith = Object.values(withTopic).filter((n) => n !== null && n > 0).length;
  const flaggedWithout = Object.values(withoutTopic).filter((n) => n !== null && n > 0).length;
  atlas.record({
    id: 'defence.flood.contested-flag',
    title: 'is a 50-strong flood reported as contested, as the docs claim?',
    verdict: flaggedWith === FLOOD_VARIANTS.length && flaggedWithout === 0
      ? VERDICT.DEGRADED
      : flaggedWith === FLOOD_VARIANTS.length ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'security-model.md names potentialConflicts as what actually catches a '
      + 'flood — so every variant at N=50 should come back with a contested group',
    actual: `with a topic field: ${flaggedWith}/3 flagged; without one: `
      + `${flaggedWithout}/3 — the detector groups by topic, and an entry type that `
      + 'carries none is never grouped',
    measured: { withTopicField: withTopic, withoutTopicField: withoutTopic },
    severity: SEVERITY.MAJOR,
  });

  // --- the documented repair: byte-identical bodies collapse ---------
  //
  // This one is a POSITIVE CONTROL, not a finding. The docs say identical
  // bodies dedupe during selection, measured 20 -> 1. If this probe fails
  // it is a regression of a repair; if it passes, the repair holds.
  const biggestIdentical = curve.identical[curve.identical.length - 1];
  atlas.record({
    id: 'defence.flood.identical-collapse',
    title: 'the documented repair: 50 byte-identical flood bodies collapse to one',
    verdict: biggestIdentical.ok && biggestIdentical.floodClaims <= 1
      ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'at N=50 with identical bodies: at most 1 flood claim in the answer '
      + '(security-model.md: "identical bodies collapse to the highest-ranked one")',
    actual: biggestIdentical.ok
      ? `${biggestIdentical.floodClaims} flood claim(s) of ${biggestIdentical.claims}, truth at rank ${biggestIdentical.truthRank}`
      : biggestIdentical.why,
    measured: biggestIdentical,
    severity: SEVERITY.MAJOR,
  });

  // --- the documented defence: a user-tier claim stays in the answer --
  const userTier = {};
  for (const variant of FLOOD_VARIANTS) {
    userTier[variant] = floodPoint(50, variant, { truthTier: 'user' });
  }
  const userKept = FLOOD_VARIANTS.filter((v) => userTier[v].ok && userTier[v].truthRank !== null);
  const userTopThree = FLOOD_VARIANTS.filter((v) => userTier[v].ok && userTier[v].truthInTopThree);
  atlas.record({
    id: 'defence.flood.user-tier-exemption',
    title: 'what the house actually claims: a user-tier truth survives a 50-strong flood',
    verdict: userKept.length === FLOOD_VARIANTS.length
      ? (userTopThree.length === FLOOD_VARIANTS.length ? VERDICT.PASS : VERDICT.DEGRADED)
      : VERDICT.FAIL,
    expected: 'the user-tier claim is exempt from the author cap and "stays in the answer" '
      + '— the docs promise presence, not rank',
    actual: `present in ${userKept.length}/3 variants, in the top three in ${userTopThree.length}/3`,
    measured: userTier,
    severity: SEVERITY.MAJOR,
  });

  return breakN;
}

// ======================================================================
// 3. Tamper detection across five scenarios
// ======================================================================

/** git, inside a throwaway clone only — never against this repository. */
function git(root, args) {
  return spawnSync('git', ['-C', root,
    '-c', 'user.email=atlas@example.invalid',
    '-c', 'user.name=cheap-mem atlas',
    '-c', 'commit.gpgsign=false',
    ...args], { encoding: 'utf8', timeout: 120000 });
}

const TAMPERED_LINE = JSON.stringify({
  id: 'hist003', ts: '2026-01-04T10:00:00Z', title: 'entry 3',
  text: 'the deploy of service 3 WAS ROLLED BACK', author: 'ops', authority: 'agent',
});

/** A throwaway memory in its own git clone, with an epoch watermark set. */
function tamperClone({ bigLog = false } = {}) {
  const root = tempRoot('atlas-tamper-');
  mem(['--root', root, 'init']);
  const dir = path.join(root, 'global');
  const lines = [];
  for (let i = 0; i < 20; i += 1) {
    lines.push(JSON.stringify({
      id: `hist${String(i).padStart(3, '0')}`,
      ts: `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
      title: `entry ${i}`,
      text: `the deploy of service ${i} succeeded`,
      author: 'ops', authority: 'agent',
    }));
  }
  fs.writeFileSync(path.join(dir, 'learnings.jsonl'), `${lines.join('\n')}\n`);

  if (bigLog) {
    // Past APPEND_ONLY_GIT_CAP_BYTES (8 MB), where checkAppendOnlyGit
    // skips the file outright.
    const filler = 'x'.repeat(900);
    const parts = [];
    let bytes = 0;
    let i = 0;
    while (bytes < 8.5 * 1024 * 1024) {
      const l = `${JSON.stringify({
        id: `big${i.toString(36)}`, ts: '2026-01-05T10:00:00Z',
        title: `big ${i}`, text: `filler ${filler}`,
        author: 'ops', authority: 'agent',
      })}\n`;
      parts.push(l);
      bytes += l.length;
      i += 1;
    }
    fs.writeFileSync(path.join(dir, 'thoughts.jsonl'), parts.join(''));
  }

  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  // The watermark has to exist before anything is manipulated, or the
  // rollback check cannot tell "first run" from "someone deleted it" —
  // which is itself one of the five scenarios below.
  mem(['--root', root, 'epoch', 'record']);
  return root;
}

function editLine(file, index, replacement) {
  const ls = fs.readFileSync(file, 'utf8').split('\n');
  ls[index] = replacement;
  fs.writeFileSync(file, ls.join('\n'));
}

/** Run every on-board tool and collect what each says. */
function runTools(root) {
  const errorsOf = (text) => text.split('\n')
    .filter((l) => l.startsWith('FAIL'))
    .map((l) => l.replace(/\s+/g, ' ').trim());

  const doctor = mem(['--root', root, 'doctor'], { timeoutMs: 300000 });
  const strict = mem(['--root', root, 'doctor', '--strict'], { timeoutMs: 300000 });
  const integrity = mem(['--root', root, 'integrity'], { timeoutMs: 120000 });
  const epoch = mem(['--root', root, 'epoch', 'show'], { timeoutMs: 120000 });
  return {
    doctor: { exit: doctor.status, red: errorsOf(doctor.stdout), ms: doctor.ms },
    'doctor --strict': { exit: strict.status, red: errorsOf(strict.stdout), ms: strict.ms },
    integrity: {
      exit: integrity.status,
      exists: !/Unknown command/.test(integrity.stderr),
      stderr: integrity.stderr.replace(/\s+/g, ' ').slice(0, 160),
    },
    'epoch show': {
      exit: epoch.status,
      status: (/status:\s*(\S+)/.exec(epoch.stdout) ?? [])[1] ?? null,
      out: epoch.stdout.replace(/\s+/g, ' ').slice(0, 200),
    },
  };
}

function metricTamper(atlas) {
  // --- the baseline, and why it is not optional ----------------------
  //
  // A bare `git init` clone has no core.hooksPath, so `mem doctor`
  // reports one standing FAIL in EVERY clone here, tampered or not, and
  // exits 2 either way. Counting exit codes without this baseline would
  // have scored all five scenarios as "caught".
  const base = tamperClone();
  const baseline = runTools(base);
  const baselineRed = new Set([...baseline.doctor.red, ...baseline['doctor --strict'].red]);

  atlas.record({
    id: 'defence.tamper.baseline',
    title: 'counter-probe: an untampered clone produces no tamper-specific red',
    verdict: [...baselineRed].some((l) => /append-only|rollback|integrity/.test(l))
      ? VERDICT.FAIL : VERDICT.PASS,
    expected: 'no append-only / rollback / integrity error in a clean clone — every '
      + 'other standing red is subtracted from the scenarios below',
    actual: `${baselineRed.size} standing red line(s): ${[...baselineRed].join(' | ') || 'none'}`,
    measured: { baseline, standingRed: [...baselineRed], epochStatus: baseline['epoch show'].status },
    severity: SEVERITY.CRITICAL,
  });

  // `mem integrity` is named in the brief. It does not exist as a
  // command; the integrity SCAN exists, but only as a `mem doctor`
  // check. That is the finding, and it is not a silent omission.
  atlas.record({
    id: 'defence.tamper.integrity-command',
    title: '`mem integrity` as a standalone command',
    verdict: baseline.integrity.exists ? VERDICT.PASS : VERDICT.NOT_MEASURED,
    expected: 'a standalone integrity command, if there is one',
    actual: baseline.integrity.exists
      ? 'present'
      : 'no such command — the scan exists as src/integrity.mjs and is reachable '
        + 'only through the `integrity` check inside `mem doctor`',
    measured: baseline.integrity,
    severity: SEVERITY.INFO,
  });
  if (!baseline.integrity.exists) {
    atlas.blind('`mem integrity` (standalone)',
      'the command does not exist; the integrity scan runs only as a mem doctor check, '
      + 'which this phase does run');
  }

  const scenarios = [];

  // (a) a line changed in the working tree, not committed
  {
    const root = tamperClone();
    editLine(path.join(root, 'global', 'learnings.jsonl'), 3, TAMPERED_LINE);
    scenarios.push({ key: 'a', what: 'one line edited in the working tree', tools: runTools(root) });
  }
  // (b) changed AND committed
  {
    const root = tamperClone();
    editLine(path.join(root, 'global', 'learnings.jsonl'), 3, TAMPERED_LINE);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'correction']);
    scenarios.push({ key: 'b', what: 'edited AND committed', tools: runTools(root) });
  }
  // (c) history rewritten, the clone sitting on the rewrite
  {
    const root = tamperClone();
    editLine(path.join(root, 'global', 'learnings.jsonl'), 3, TAMPERED_LINE);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '--amend', '-m', 'init']);
    scenarios.push({ key: 'c', what: 'history rewritten (commit --amend)', tools: runTools(root) });
  }
  // (d) a log past the 8 MB cap, one line changed in the working tree
  {
    const root = tamperClone({ bigLog: true });
    editLine(path.join(root, 'global', 'thoughts.jsonl'), 3, JSON.stringify({
      id: 'big3', ts: '2026-01-05T10:00:00Z', title: 'big 3',
      text: 'TAMPERED past the 8 MB cap', author: 'ops', authority: 'agent',
    }));
    scenarios.push({ key: 'd', what: 'a >8 MB log, one line changed', tools: runTools(root) });
  }
  // (e) the epoch watermark deleted
  {
    const root = tamperClone();
    fs.rmSync(path.join(root, '.mem', 'epoch.json'), { force: true });
    scenarios.push({ key: 'e', what: '.mem/epoch.json deleted', tools: runTools(root) });
  }

  for (const s of scenarios) {
    const red = [];
    for (const [tool, r] of Object.entries(s.tools)) {
      if (!Array.isArray(r.red)) continue;
      const fresh = r.red.filter((l) => !baselineRed.has(l));
      if (fresh.length) red.push({ tool, lines: fresh });
    }
    // The epoch tool speaks in a status word, not in FAIL lines.
    const epochStatus = s.tools['epoch show'].status;
    if (epochStatus && epochStatus !== baseline['epoch show'].status
      && epochStatus === 'rollback') {
      red.push({ tool: 'epoch show', lines: [`status: ${epochStatus}`] });
    }
    s.caught = red.length > 0;
    s.caughtBy = red;
    s.epochStatus = epochStatus;
  }

  const caught = scenarios.filter((s) => s.caught);
  atlas.record({
    id: 'defence.tamper.detection-rate',
    title: `tamper scenarios caught by at least one on-board tool: ${caught.length} of 5`,
    verdict: caught.length === 1 ? VERDICT.DEGRADED
      : caught.length > 1 ? VERDICT.PASS : VERDICT.FAIL,
    // Straight from the record: security-model.md:265 concedes that
    // whoever edits AND commits, or force-pushes a rewritten history this
    // clone then pulls, is invisible; the 8 MB cap skips a file outright;
    // and .mem/epoch.json is gitignored and deletable by anyone who can
    // write. That leaves exactly (a).
    expected: '1 of 5 — only the uncommitted working-tree edit (a) is detectable '
      + 'by the design the docs describe',
    actual: `${caught.length} of 5 caught: ${caught.map((s) => s.key).join(', ') || 'none'}`,
    measured: {
      scenarios: scenarios.map((s) => ({
        scenario: s.key, what: s.what, caught: s.caught,
        caughtBy: s.caughtBy, epochStatus: s.epochStatus,
        exits: Object.fromEntries(Object.entries(s.tools).map(([k, v]) => [k, v.exit])),
      })),
      standingRedSubtracted: [...baselineRed],
      toolsRun: ['mem doctor', 'mem doctor --strict', 'mem integrity (absent)', 'mem epoch show'],
    },
    evidence: scenarios.map((s) => `(${s.key}) ${s.what}: `
      + (s.caught ? s.caughtBy.map((r) => `${r.tool}: ${r.lines.join(' / ')}`).join(' ; ') : 'no tool went red'))
      .join('\n'),
    severity: SEVERITY.MAJOR,
  });

  return caught.length;
}

// ======================================================================

export async function run(atlas) {
  atlas.phase('defence',
    'Defence: bidi neutralisation, flood domination, tamper detection',
    'Three numbers, each aimed at a limit `docs/security-model.md` states about '
    + 'itself. Every probe runs in a throwaway `tempRoot()`; the git scenarios '
    + 'use their own `git init` clone and never touch this repository. Each '
    + 'number carries a positive control (did the probe reach anything at all?) '
    + 'and a counter-probe (does the detector stay quiet when it should?).');

  const bidi = await metricBidi(atlas);
  const flood = metricFlood(atlas);
  const tamper = metricTamper(atlas);

  return { bidi, flood, tamper };
}

export default { run };
