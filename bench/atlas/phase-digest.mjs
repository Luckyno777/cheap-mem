// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-digest.mjs — what one tick of the digest costs, counted
// without a model.
//
// **The phase id.** `digest`, the same id the sister house (lucky-mem) uses;
// the state of the sister phase is recorded in test/atlas-phase-parity.json.
//
// **The question.** `bin/mem-digest` is the one place in the memory loop that
// calls a model, and it runs on a timer, often. Two promises hold it
// together, and neither has ever been measured by the atlas:
//
//   1. A tick that finds nothing ripe is back out cheaply and calls NO model
//      (the comment above "Check dueness BEFORE taking the lock" in the
//      script: "no lock, no git, no model").
//   2. A ripe pile costs EXACTLY ONE model call per tick, and that call is
//      handed no more raw material than the budget (`MEM_DIGEST_MAX_BYTES`);
//      the rest stays pending, and a backlog drains in a bounded number of
//      ticks instead of starving its oldest end (src/digestselect.mjs).
//
// **How it is measured without a model.** The model command is configurable
// (`MEM_DIGEST_CMD`). The phase points it at a stand-in (written into a
// scratch folder, a node script) that does what a model session does for the
// ledger and nothing else: it writes one line per call, and in the draining
// variant it marks the captures it was given as digested. So the number of
// model calls is a count of lines, not a measurement of anything a model did.
// The same store is used with and without the dueness threshold
// (`MEM_DIGEST_VOLUME_NOW_KB=0`), which makes the "due" row the positive
// control of the "idle" row: the stand-in DOES see a call when one is made.
//
// **Counters, never time.** Model calls, captures handed over, raw bytes
// handed over, ticks to drain, and node processes started
// (bench/atlas/start-counter.mjs, through NODE_OPTIONS so the node children of
// the bash script count too). The start counts are RATCHETS: today's measured
// number is the limit (see `START_LIMIT`), it may fall and not grow. A tick
// that grows a fourth `node -e` before the dueness answer is the cost this
// phase exists to see.
//
// **Platform branch.** The script is bash. Where no `bash` starts, or the
// scratch path holds a space (the model command is word-split by the script),
// every row says `not-measured` with that reason; the PowerShell twin is not
// driven here (named as a blind spot).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  VERDICT, SEVERITY, REPO, MEM, mem, tempRoot,
} from './core.mjs';
import { readStarts } from './start-counter.mjs';
import * as archive from '../../src/archive.mjs';
import * as raw from '../../src/raw.mjs';

const COUNTER = pathToFileURL(path.join(REPO, 'bench', 'atlas', 'start-counter.mjs'));
const DIGEST = path.join(REPO, 'bin', 'mem-digest');

/** The budget of one tick in the phase, in raw bytes (`MEM_DIGEST_MAX_BYTES`). */
export const MAX_BYTES = 1000;
/** The store: one old capture of 600 raw bytes and twenty new ones of 130 (the shape of test/recall-gaps-digest.test.mjs, with sizes that do not divide the budget, so a selection that overshoots it is seen). */
export const OLD_BYTES = 600;
export const NEW_COUNT = 20;
export const NEW_BYTES = 130;

/**
 * Ratchets for node starts per tick, measured 2026-10-17 on Linux (Node 22.22), the stand-in model counted separately.
 * They may fall; raising one needs a reason in this comment.
 *   idle  a tick that finds nothing ripe: the miss-gold stamp, the weekly rule draft, the dueness answer
 *   due   a tick that calls the model once
 */
export const START_LIMIT = Object.freeze({ idle: 3, due: 14 });

const ID = (k) => `digest.${k}`;
const IDS = ['idle', 'due-once', 'cap', 'drain', 'starts'];
const slash = (p) => String(p).replace(/\\/g, '/');
const short = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

const FAKE_MODEL = `// stand-in for the model session: one line per call, optionally marks what it was given as digested
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [calls, memBin, mode, prompt] = process.argv.slice(2);
const listed = [...String(prompt).matchAll(/^ {2}(raw\\/\\S+)$/gm)].map((m) => m[1]);
fs.appendFileSync(calls, JSON.stringify({ promptBytes: Buffer.byteLength(String(prompt)), listed }) + '\\n');
if (mode === 'drain' && listed.length) spawnSync(process.execPath, [memBin, 'raw', 'digested', ...listed], { encoding: 'utf8' });
process.stdout.write('{"result":"ok","is_error":false}');
`;

const rawName = (iso, s) => `raw/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.replace(/:/g, '-')}--${s}.jsonl.gz`;
export const OLD = rawName('2026-08-01T10:00:00Z', 'old');
export const fresh = (i) => rawName(`2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`, `new${i}`);

/** A scratch memory with the 21 captures pending. */
export function buildStore() {
  const root = tempRoot('atlas-digest-');
  const init = mem(['init'], { root });
  if (init.status !== 0) throw new Error(`mem init failed: ${short(init.stderr)}`);
  const put = (rel, sourceBytes) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), zlib.gzipSync(`${JSON.stringify({ __stamp: 1, session_id: 's' })}\n{"t":"x"}\n`));
    archive.writeRecord(root, {
      path: rel, captured_at: '2026-09-01T00:00:00Z', location: `file:///x/${rel}`,
      bytes: fs.statSync(path.join(root, rel)).size, source_bytes: sourceBytes, sha256: 'x'.repeat(64),
    });
  };
  put(OLD, OLD_BYTES);
  for (let i = 0; i < NEW_COUNT; i += 1) put(fresh(i), NEW_BYTES);
  return root;
}

/** Can the script run here, and can the model command be passed through its word splitting? */
export function platformProblem() {
  const b = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' });
  if (b.error || b.status !== 0) return 'no bash starts here; bin/mem-digest is a bash script (its PowerShell twin is not driven)';
  const dir = tempRoot('atlas-digest-probe-');
  if (/\s/.test(dir)) return 'the scratch path holds a space, and bin/mem-digest word-splits the model command';
  return null;
}

/**
 * One tick of bin/mem-digest on `root`. `drain`: the stand-in marks what it was given as digested.
 * @returns {{ status: number|null, calls: object[], starts: object[]|null, output: string }}
 */
export function tick(root, bin, { env = {}, drain = false } = {}) {
  const callsFile = path.join(bin, 'calls.jsonl');
  const startsFile = path.join(bin, 'starts.jsonl');
  fs.rmSync(callsFile, { force: true });
  fs.rmSync(startsFile, { force: true });
  fs.writeFileSync(startsFile, '');
  const fake = path.join(bin, 'fake-model.mjs');
  const r = spawnSync('bash', [DIGEST], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: root,
    env: {
      ...process.env,
      CHEAP_MEM_ROOT: root,
      // forward slashes: the script word-splits this command, and a backslash path is read as such by Git Bash and by node alike
      MEM_DIGEST_CMD: `node ${slash(fake)} ${slash(callsFile)} ${slash(MEM)} ${drain ? 'drain' : 'keep'}`,
      MEM_DIGEST_TIMEOUT: '60',
      MEM_DIGEST_MAX_BYTES: String(MAX_BYTES),
      NODE_OPTIONS: `--import=${COUNTER.href}?out=${encodeURIComponent(startsFile)}`,
      ...env,
    },
  });
  let calls = [];
  try {
    calls = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* no call was made: an empty list is the honest answer */ }
  return { status: r.status, calls, starts: readStarts(startsFile), output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The starts of a tick without the stand-in model (its own start is the model call, counted as a call). */
export const ownStarts = (starts) => (starts ?? []).filter((s) => s.script !== 'fake-model.mjs');

function rec(atlas, {
  id, title, ok, expected, actual, evidence, measured = null, severity = SEVERITY.MAJOR, verdict = null,
}) {
  return atlas.record({
    id, title, verdict: verdict ?? (ok ? VERDICT.PASS : VERDICT.FAIL), expected, actual: String(actual), evidence: String(evidence), measured, severity,
  });
}

function notMeasured(atlas, why) {
  const titles = {
    idle: 'A tick that finds nothing ripe calls no model',
    'due-once': 'A ripe pile costs exactly one model call per tick',
    cap: 'The one call is handed no more raw material than the budget, the oldest capture included',
    drain: 'A backlog drains in a bounded number of ticks, one call each, and the tick after is idle',
    starts: 'Node processes started per tick stay within the ratchet',
  };
  for (const k of IDS) {
    atlas.record({
      id: ID(k), title: titles[k], verdict: VERDICT.NOT_MEASURED, expected: 'a count', actual: 'not asked', evidence: why,
    });
  }
  atlas.blind('digest: the whole phase', why);
}

/** Raw bytes the listing of one call adds up to, from the store's own records. */
export function listedBytes(listed, root) {
  const sizes = raw.pending(root).rawSizes;
  return listed.reduce((n, f) => n + (typeof sizes[f] === 'number' ? sizes[f] : Infinity), 0);
}

export async function run(atlas) {
  atlas.phase('digest', 'What one digest tick costs: model calls, raw bytes handed over, ticks to drain, node starts (a stand-in for the model, no model call)',
    'bin/mem-digest through bash on a scratch memory with 21 pending captures; the model command is a stand-in that writes one line per call. Counters only: no time is measured.');
  const problem = platformProblem();
  if (problem) { notMeasured(atlas, problem); return; }

  const bin = tempRoot('atlas-digest-bin-');
  fs.writeFileSync(path.join(bin, 'fake-model.mjs'), FAKE_MODEL);
  const root = buildStore();
  const total = raw.pending(root).open.length;
  const lockLeft = () => fs.existsSync(path.join(root, '.mem', 'digest.lock.d'));

  // --- idle: the same store, no threshold set -------------------------------------------------
  const idle = tick(root, bin);
  const idleStarts = ownStarts(idle.starts);
  rec(atlas, {
    id: ID('idle'), title: 'A tick that finds nothing ripe calls no model',
    ok: idle.status === 0 && idle.calls.length === 0 && idle.starts !== null && !lockLeft() && total === NEW_COUNT + 1,
    expected: 'exit 0, 0 model calls, no lock left behind, the 21 captures still pending (the pile exists, it is only not ripe)',
    actual: `exit ${idle.status}, ${idle.calls.length} model call(s), lock left: ${lockLeft()}, pending ${total}`,
    evidence: `bin/mem-digest with default thresholds on a pile of ${total} tiny captures; the stand-in model would have written a line (control: digest.due-once). ${short(idle.output, 160)}`,
    measured: { status: idle.status, modelCalls: idle.calls.length, pending: total, starts: idleStarts.length },
  });

  // --- due: the threshold is set to zero, so the same pile is ripe ----------------------------------
  const due = tick(root, bin, { env: { MEM_DIGEST_VOLUME_NOW_KB: '0' } });
  const dueStarts = ownStarts(due.starts);
  rec(atlas, {
    id: ID('due-once'), title: 'A ripe pile costs exactly one model call per tick',
    ok: due.status === 1 && due.calls.length === 1 && /digested nothing/.test(due.output),
    expected: 'exactly 1 model call (the control of digest.idle: the stand-in does see a call when one is made); the stand-in digests nothing, so the script must say FAILED and exit 1 (an exit 0 would be a silent failure)',
    actual: `exit ${due.status}, ${due.calls.length} model call(s), "digested nothing" said: ${/digested nothing/.test(due.output)}`,
    evidence: `the same store with MEM_DIGEST_VOLUME_NOW_KB=0. ${short(due.output, 160)}`,
    measured: { status: due.status, modelCalls: due.calls.length, saidNothingDigested: /digested nothing/.test(due.output) },
  });

  // --- the cap ------------------------------------------------------------------------------------------
  const listed = due.calls[0]?.listed ?? [];
  const bytes = listedBytes(listed, root);
  rec(atlas, {
    id: ID('cap'), title: 'The one call is handed no more raw material than the budget, the oldest capture included',
    ok: due.calls.length === 1 && listed.length > 0 && bytes <= MAX_BYTES && listed.length < total && listed.includes(OLD),
    expected: `1 to ${total - 1} captures, at most ${MAX_BYTES} raw bytes, the old capture among them (the age reserve), the rest left pending`,
    actual: `${listed.length} of ${total} captures, ${Number.isFinite(bytes) ? bytes : 'unknown'} raw bytes, old capture ${listed.includes(OLD) ? 'listed' : 'NOT listed'}`,
    evidence: 'the capture paths in the prompt the stand-in received, sized by the store\'s own records (raw pending: rawSizes); src/digestselect.mjs chooses',
    measured: { listed: listed.length, total, rawBytes: Number.isFinite(bytes) ? bytes : null, max: MAX_BYTES, oldListed: listed.includes(OLD) },
  });

  // --- drain: the stand-in marks what it was given -------------------------------------------------------
  const drainRoot = buildStore();
  const bound = Math.ceil((OLD_BYTES + NEW_COUNT * NEW_BYTES) / MAX_BYTES) + 1;
  let ticks = 0;
  let calls = 0;
  let sawEmptyCall = false;
  let sawFailure = false;
  for (; ticks < 3 * bound; ticks += 1) {
    const t = tick(drainRoot, bin, { env: { MEM_DIGEST_VOLUME_NOW_KB: '0' }, drain: true });
    calls += t.calls.length;
    if (t.calls.length === 0) break;
    if (t.calls.length !== 1 || (t.calls[0].listed ?? []).length === 0) sawEmptyCall = true;
    if (t.status !== 0) sawFailure = true;
  }
  const after = tick(drainRoot, bin, { env: { MEM_DIGEST_VOLUME_NOW_KB: '0' }, drain: true });
  const left = raw.pending(drainRoot).open.length;
  rec(atlas, {
    id: ID('drain'), title: 'A backlog drains in a bounded number of ticks, one call each, and the tick after is idle',
    ok: left === 0 && ticks >= 2 && ticks <= bound && calls === ticks && !sawEmptyCall && !sawFailure && after.calls.length === 0,
    expected: `0 captures left after at most ${bound} working ticks (ceil(raw bytes / budget) + 1), one call per working tick, each with at least one capture and each ending with exit 0; then a tick with 0 calls`,
    actual: `${left} left after ${ticks} working tick(s), ${calls} call(s)${sawEmptyCall ? ', a call with an empty listing' : ''}${sawFailure ? ', a working tick that did not exit 0' : ''}; the tick after: ${after.calls.length} call(s)`,
    evidence: 'MEM_DIGEST_VOLUME_NOW_KB=0 on every tick, the stand-in marks the captures it is given as digested (mem raw digested)',
    measured: { ticks, calls, left, bound, afterCalls: after.calls.length, failedTick: sawFailure },
  });

  // --- starts: ratchets ------------------------------------------------------------------------------------
  const noTimeout = !['timeout', 'gtimeout', 'perl'].some((c) => spawnSync('bash', ['-c', `command -v ${c}`], { encoding: 'utf8' }).status === 0);
  const slack = noTimeout ? 1 : 0;
  const kinds = (arr) => {
    const m = {};
    for (const s of arr) m[s.script || '(node -e)'] = (m[s.script || '(node -e)'] ?? 0) + 1;
    return m;
  };
  rec(atlas, {
    id: ID('starts'), title: 'Node processes started per tick stay within the ratchet',
    ok: idle.starts !== null && due.starts !== null && idleStarts.length >= 1 && dueStarts.length >= idleStarts.length
      && idleStarts.length <= START_LIMIT.idle + slack && dueStarts.length <= START_LIMIT.due + slack,
    expected: `an idle tick starts at most ${START_LIMIT.idle} node processes, a tick with one model call at most ${START_LIMIT.due} (the stand-in model not counted); at least 1 and not fewer when due (the counter sees something)${noTimeout ? '; +1 here: no timeout/gtimeout/perl, the cap is a node watchdog' : ''}`,
    actual: `idle ${idleStarts.length}, due ${dueStarts.length}`,
    evidence: 'bench/atlas/start-counter.mjs through NODE_OPTIONS (every node child of the script counts)',
    measured: { idle: idleStarts.length, due: dueStarts.length, idleBy: kinds(idleStarts), dueBy: kinds(dueStarts), limit: START_LIMIT, slack },
  });

  atlas.blind('digest: the model', 'the model call itself is a stand-in that writes one line: what a real session does with the prompt (sorting quality, the entries it writes, its cost) is not measured here; the model cost journal (src/modelcost.mjs) is not read.');
  atlas.blind('digest: the PowerShell twin', 'bin/mem-digest.ps1 is not driven; only the bash script is. The twin asks the same selection module (src/digestselect.mjs), which the drain row exercises through the bash script.');
  atlas.blind('digest: concurrency and timeout', 'two ticks at once (the lock), a stale lock, the model timeout and the exit-126 detour are not driven; the bash script is run one tick at a time.');
  atlas.blind('digest: size', `${total} captures of at most ${OLD_BYTES} raw bytes against a ${MAX_BYTES}-byte budget; the real default budget (16 MB) and a real backlog (hundreds of captures, megabytes) are not built. The counters do not depend on size, a bound that only breaks at scale would not be seen.`);
  atlas.blind('digest: dueness thresholds', 'only two settings are asked (the defaults, and "due at once"); the quiet-minutes, ceiling and age-without-bell rules of `mem digest due` are covered by test/au4-digest-age-without-bell.test.mjs, not counted here.');
}
