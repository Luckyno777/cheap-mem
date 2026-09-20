// bench/atlas/phase-surface.mjs — every command, actually executed.
//
// **Why this phase exists.** cheap-mem has sixty top-level commands and,
// before this file, not one benchmark started the CLI as a PROCESS.
// `bench/scale.mjs:58` and `bench/retrieval.mjs:77` import `buildIndex`
// and `search` directly, which makes everything between process start and
// answer invisible: Node's own startup, `loadIndex` from the cache,
// writing that cache back, `requireConfig`, `findRoot`. That latency is
// exactly what the retrieval hook pays on every single prompt, so it is
// exactly what has to be measured through the front door.
//
// The same hole swallowed the exit codes. Every documented special exit
// code in this CLI carries a shell integration — a timer, a poller, a
// start banner — and not one of them had ever been checked against the
// real process. A contract nobody executes is a comment.
//
// **What this phase deliberately does not do.** It does not grade, it
// does not repair, and it does not skip. A command that cannot be driven
// from here (a terminal UI, a network round trip, a state that would
// require a git repository) is recorded as `not-measured` AND named as a
// blind spot. Leaving it out would turn "we never looked" into "fine".
//
// **Three probes per claim, not one.** Every claim below is carried by a
// probe, a sabotage counter-probe (produce the opposite state and show
// the signal goes away) and a positive control (show the measuring
// instrument can tell the two apart at all). A check that only ever sees
// the interesting state cannot distinguish a real signal from a constant.

import fs from 'node:fs';
import path from 'node:path';
import { mem, buildCorpus, tempRoot, VERDICT, SEVERITY, pct, REPO } from './core.mjs';

import { COMMANDS as WRITE } from '../../src/cli/commands/write.mjs';
import { COMMANDS as SEARCH } from '../../src/cli/commands/search.mjs';
import { COMMANDS as CAPTURE } from '../../src/cli/commands/capture.mjs';
import { COMMANDS as AGENTS } from '../../src/cli/commands/agents.mjs';
import { COMMANDS as SETUP } from '../../src/cli/commands/setup.mjs';
import { COMMANDS as ADMIN } from '../../src/cli/commands/admin.mjs';

/**
 * The command list comes FROM THE CODE, not from `--help`.
 *
 * `mem --help` is hand-written prose. If a command were missing from it,
 * a benchmark driven by that text would never run the command and would
 * never notice — it would measure the documentation's idea of the
 * surface instead of the surface. The six tables in
 * `src/cli/commands/*.mjs` are what `bin/mem` actually dispatches on, so
 * they are what gets driven here. The group name travels with the name
 * so a report can say where a command lives.
 */
const GROUPS = [
  ['write', WRITE], ['search', SEARCH], ['capture', CAPTURE],
  ['agents', AGENTS], ['setup', SETUP], ['admin', ADMIN],
];

function commandList() {
  const list = [];
  for (const [group, table] of GROUPS) {
    for (const name of Object.keys(table)) list.push({ name, group });
  }
  return list;
}

const CACHE_FILE = path.join('.mem', 'search-index.json');

/** Seconds of wall clock a single CLI call may take before it is killed. */
const CALL_TIMEOUT_MS = 60000;

// --- small helpers ------------------------------------------------------

/** First non-empty line of whatever the process said, for evidence. */
function firstLine(r) {
  const text = `${r.stdout}${r.stderr}`;
  for (const l of text.split('\n')) if (l.trim()) return l.trim().slice(0, 200);
  return '(no output)';
}

/** `{ok, value|error}` — never a bare `[]` on failure (three states). */
function parseJson(text) {
  const t = text.trim();
  if (!t) return { ok: false, error: 'empty stdout' };
  try { return { ok: true, value: JSON.parse(t) }; }
  catch (e) { return { ok: false, error: String(e.message).slice(0, 200) }; }
}

/** `mem log` prints `  id: <id>` — pull it out, or null (never guess one). */
function idFrom(r) {
  const m = /^\s*id:\s*(\S+)/m.exec(r.stdout);
  return m ? m[1] : null;
}

/** A throwaway root with a config and, optionally, a corpus in it. */
function freshRoot(prefix, entries) {
  const root = tempRoot(prefix);
  // `mem init` BEFORE buildCorpus on purpose: buildCorpus writes a
  // minimal config only when none exists, and its `participants` is an
  // array, which makes `mem whoami <name>` refuse every real name.
  // Initialising first leaves the real default config in place.
  mem(['init'], { root, timeoutMs: CALL_TIMEOUT_MS });
  const corpus = entries ? buildCorpus(root, entries) : null;
  return { root, corpus };
}

/** A transcript big enough that `raw-capture` does not skip it (>4 KiB). */
function writeTranscript(root, lines) {
  const p = path.join(root, 'atlas-transcript.jsonl');
  let text = '';
  for (let i = 0; i < lines; i += 1) {
    text += `${JSON.stringify({ role: i % 2 ? 'assistant' : 'user',
      content: `deploy cache memory probe line ${i}` })}\n`;
  }
  fs.writeFileSync(p, text);
  return p;
}

/**
 * One exit-code contract: state produced, command run, code compared.
 *
 * The caller produces the situation first and only then calls this. A
 * contract whose situation cannot be built here never reaches this
 * function: it is recorded as `not-measured` and named as a blind spot
 * instead, because a code that came back from the wrong situation says
 * nothing about the contract.
 */
function contract(atlas, { id, title, argv, root, expect, note = null, env = {} }) {
  const r = mem(argv, { root, env, timeoutMs: CALL_TIMEOUT_MS });
  const ok = r.status === expect;
  atlas.record({
    id: `surface.exit.${id}`,
    title,
    verdict: ok ? VERDICT.PASS : VERDICT.FAIL,
    expected: `exit ${expect}`,
    actual: `exit ${r.status}`,
    ms: r.ms,
    severity: SEVERITY.MAJOR,
    measured: { argv: argv.join(' '), status: r.status, ms: r.ms, note },
    evidence: ok ? null : `mem ${argv.join(' ')}\n-> exit ${r.status}\n${firstLine(r)}`,
  });
  return r;
}

// --- the invocation table ----------------------------------------------
//
// Every command gets an argument list that makes it DO ITS WORK, not one
// that makes it print its usage. `mem raw` with no arguments exits 0 and
// prints help; recording that as "raw works" would be the emptiest green
// in this repository.
//
// `expect` is a list because several commands carry a documented
// multi-code contract (`doctor` 0/1/2, `digest due` 0/1/3). Those are
// pinned exactly in the contract section below; here the sweep only
// asserts the command stayed inside its own documented set.

function invocations(ctx) {
  const t = (name, argv, expect = [0], extra = {}) => ({ name, argv, expect, ...extra });
  return [
    // --- write -----------------------------------------------------
    t('log', ['log', 'learning', '--title', 'atlas surface probe',
      '--text', 'deploy cache probe body for the surface phase']),
    t('teach', ['teach'], [0], { json: ['teach', '--json'] }),
    t('correction', ['correction', 'learning', ctx.logId ?? 'missing',
      '--title', 'atlas surface probe, corrected']),
    t('discard', ['discard', ctx.discardId ?? 'missing', '--why', 'atlas surface probe']),
    t('done', ['done', ctx.doneId ?? 'missing', '--why', 'atlas surface probe']),
    t('links', ['links', ctx.logId ?? 'missing']),
    t('facts', ['facts']),
    t('experiences', ['experiences', '--all']),
    t('topic-merge', ['topic-merge', 'atlas/old', '--to', 'atlas/new']),
    t('duties', ['duties']),

    // --- search ----------------------------------------------------
    t('find', ['find', ctx.anchorQuery], [0], { json: ['find', ctx.anchorQuery, '--json'] }),
    t('find-embed', ['find-embed', 'deploy cache'], [0], { model: true }),
    t('find-hybrid', ['find-hybrid', 'deploy cache'], [0]),
    t('retrieve', ['retrieve', ctx.question], [0],
      { json: ['retrieve', ctx.question, '--json'] }),
    t('explain', ['explain', ctx.question, ctx.claimId ?? 'missing'], [0],
      { json: ['explain', ctx.question, ctx.claimId ?? 'missing', '--json'] }),
    t('when', ['when', 'last 30 days']),
    t('show', ['show', ctx.anchorId], [0], { json: ['show', ctx.anchorId, '--json'] }),
    t('browse', ['browse'], [1],
      { note: 'no TTY here: the documented refusal is the measurable half' }),
    t('topics', ['topics']),
    t('topic', ['topic', 'atlas/new']),
    t('context', ['context', '--n', '5']),
    t('digest', ['digest', 'due'], [0, 1],
      { json: ['digest', 'due', '--json'], note: 'documented 0/1/3' }),
    t('core', ['core', '--max', '10']),

    // --- capture ---------------------------------------------------
    t('raw', ['raw', 'pending'], [0], { json: ['raw', 'pending', '--json'] }),
    t('raw-capture', ['raw-capture', '--transcript', ctx.transcript]),
    t('shrink', ['shrink', '--no-write'], [0, 2],
      { json: ['shrink', '--no-write', '--json'], note: 'documented 0/2' }),

    // --- agents ----------------------------------------------------
    t('inbox', ['inbox', 'new', '--as', 'session']),
    t('broadcast', ['broadcast', ctx.errorId ?? 'missing', '--dry-run']),
    t('questions', ['questions', '--all']),
    t('answer', ['answer', ctx.questionId ?? 'missing',
      '--with', ctx.answerWithId ?? 'missing']),
    t('procedures', ['procedures']),
    t('heartbeat', ['heartbeat', '--what', 'atlas surface probe']),
    t('board', ['board'], [0], { json: ['board', '--json'] }),
    t('onboarding', ['onboarding', 'atlasprobe'], [0, 1], { note: 'documented 0/1' }),
    t('agents', ['agents']),
    t('agent', ['agent', 'new', 'atlasprobe2', '--role', 'atlas surface probe']),
    t('whoami', ['whoami']),
    t('classes', ['classes'], [0], { json: ['classes', '--json'] }),

    // --- setup -----------------------------------------------------
    t('init', ['init']),
    t('setup', ['setup', 'claude', '--dry-run']),
    t('hooks', ['hooks', 'check'], [0, 1], { note: 'documented 0/1' }),
    t('paths', ['paths'], [0], { json: ['paths', '--json'] }),
    t('guard', ['guard', 'run'], [0, 1], { note: 'documented 0/1' }),
    t('version', ['version']),
    t('bridge', ['bridge', 'report', 'a1b2c3d']),
    t('serve', ['serve', '--port', String(ctx.port), '--readonly'], [0], { server: true }),
    t('viewer', ['viewer', '--out', path.join(ctx.root, 'atlas-viewer.html')]),
    t('net', ['net'], [0], { json: ['net', '--json'] }),
    t('project', ['project', 'init', 'atlasprobe']),
    t('store', ['store', 'put', ctx.storeFile, '--purpose', 'atlas surface probe']),
    t('sources', ['sources', 'add', 'https://example.invalid/atlas', '--title', 'atlas probe']),
    t('component', ['component', 'src/search.mjs'], [0],
      { json: ['component', 'src/search.mjs', '--json'] }),

    // --- admin -----------------------------------------------------
    t('doctor', ['doctor'], [0, 1, 2], { note: 'documented 0/1/2' }),
    t('gauges', ['gauges'], [0], { json: ['gauges', '--json'] }),
    t('observations', ['observations'], [0], { json: ['observations', '--json'] }),
    t('maintenance', ['maintenance', 'dedupe', '--dry-run']),
    t('epoch', ['epoch', 'show'], [0, 2], { note: 'documented 0/2' }),
    t('thesaurus', ['thesaurus']),
    t('embed', ['embed', 'status']),
    t('status', ['status'], [0, 1], { note: '1 when a step is broken' }),
  ];
}

// --- 1. the full sweep --------------------------------------------------

function sweep(atlas, quick) {
  const entries = quick ? 300 : 2000;
  const { root, corpus } = freshRoot('atlas-surface-', entries);

  // Everything the invocation table needs an id for. Produced first, so
  // that a command needing an id is driven for real rather than being
  // handed a made-up one and measured against its refusal.
  mem(['whoami', 'session'], { root, timeoutMs: CALL_TIMEOUT_MS });
  mem(['agent', 'new', 'atlasprobe', '--role', 'atlas surface probe'],
    { root, timeoutMs: CALL_TIMEOUT_MS });
  const logged = mem(['log', 'learning', '--title', 'atlas anchor entry',
    '--text', 'an entry the surface sweep can correct, link and show'],
  { root, timeoutMs: CALL_TIMEOUT_MS });
  const toDiscard = mem(['log', 'thought', '--title', 'atlas discardable',
    '--text', 'exists so discard has something of its own to retire'],
  { root, timeoutMs: CALL_TIMEOUT_MS });
  const toDone = mem(['log', 'duty', '--title', 'atlas closable',
    '--text', 'exists so done has something of its own to retire',
    '--owed_to', 'atlas'], { root, timeoutMs: CALL_TIMEOUT_MS });
  const erred = mem(['log', 'error', '--class', 'looks-right-does-nothing',
    '--title', 'atlas probe error', '--text', 'exists so broadcast has an id'],
  { root, timeoutMs: CALL_TIMEOUT_MS });
  const asked = mem(['log', 'question', '--question', 'what does the surface sweep not reach?',
    '--title', 'atlas probe question'], { root, timeoutMs: CALL_TIMEOUT_MS });
  // `answer --with` needs an entry that is still resolvable by id when it
  // runs. The anchor entry above is superseded by `mem correction` earlier
  // in the same sweep, and a superseded id is no longer a valid link
  // target — so `answer` gets an entry of its own rather than a target the
  // sweep itself retired two commands ago.
  const answersIt = mem(['log', 'learning', '--title', 'atlas answering entry',
    '--text', 'what the probe question is closed with'],
  { root, timeoutMs: CALL_TIMEOUT_MS });
  mem(['log', 'decision', '--topic', 'atlas/old', '--choice', 'measure through the front door',
    '--why', 'so topic and topic-merge have a real subject'],
  { root, timeoutMs: CALL_TIMEOUT_MS });

  const question = 'what happened with the deploy cache';
  const retrieved = mem(['retrieve', question, '--json'], { root, timeoutMs: CALL_TIMEOUT_MS });
  const parsedRetrieve = parseJson(retrieved.stdout);
  const claimId = parsedRetrieve.ok ? (parsedRetrieve.value.claims?.[0]?.id ?? null) : null;

  const storeFile = path.join(root, 'atlas-store-input.txt');
  fs.writeFileSync(storeFile, 'bytes the memory keeps by hash, for the surface sweep\n');

  const ctx = {
    root,
    anchorQuery: corpus.anchors[0].query,
    anchorId: corpus.anchors[0].id,
    question,
    claimId,
    logId: idFrom(logged),
    discardId: idFrom(toDiscard),
    doneId: idFrom(toDone),
    errorId: idFrom(erred),
    questionId: idFrom(asked),
    answerWithId: idFrom(answersIt),
    transcript: writeTranscript(root, 400),
    storeFile,
    // A port nobody else on this machine is likely to hold. Not 8847
    // (the default) on purpose: a developer's own `mem serve` must not
    // make this measurement look like a success.
    port: 8900 + (process.pid % 90),
  };

  const table = invocations(ctx);
  const byName = new Map(table.map((e) => [e.name, e]));
  const all = commandList();
  let ran = 0;
  let notMeasured = 0;

  // The table is built by hand; the command list is not. If the two ever
  // disagree, that is a command this phase silently stopped driving —
  // recorded as a check of its own rather than discovered by a reader.
  const missing = all.filter((c) => !byName.has(c.name)).map((c) => c.name);
  const extra = table.filter((e) => !all.some((c) => c.name === e.name)).map((e) => e.name);
  atlas.record({
    id: 'surface.table-covers-every-command',
    title: 'the invocation table names every command the CLI dispatches',
    verdict: missing.length === 0 && extra.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    expected: `${all.length} commands, all covered`,
    actual: missing.length || extra.length
      ? `${missing.length} uncovered, ${extra.length} unknown`
      : `${all.length} covered`,
    severity: SEVERITY.MAJOR,
    measured: { total: all.length, missing, extra },
    evidence: missing.length ? `not driven: ${missing.join(', ')}` : null,
  });

  for (const cmd of all) {
    const plan = byName.get(cmd.name);
    if (!plan) continue;

    // The model/network commands and the interactive one are RUN anyway,
    // because what they do when the thing they need is absent is itself
    // a contract — but their real path stays not-measured and blind.
    if (plan.model) {
      const r = mem(plan.argv, { root, timeoutMs: CALL_TIMEOUT_MS });
      notMeasured += 1;
      atlas.record({
        id: `surface.cmd.${cmd.name}`,
        title: `mem ${plan.argv.join(' ')}`,
        verdict: VERDICT.NOT_MEASURED,
        expected: 'a semantic answer from the vector store',
        actual: `exit ${r.status} — ${firstLine(r)}`,
        ms: r.ms,
        measured: { group: cmd.group, status: r.status, ms: r.ms, bytes: r.bytes },
      });
      atlas.blind(`mem ${cmd.name}`,
        'needs an embedding provider (API key + better-sqlite3/sqlite-vec); '
        + 'this phase makes no network calls and installs no optional dependency');
      continue;
    }

    if (plan.server) {
      serveProbe(atlas, plan, root, cmd.group);
      ran += 1;
      continue;
    }

    const r = mem(plan.argv, { root, timeoutMs: CALL_TIMEOUT_MS });
    ran += 1;
    const okExit = plan.expect.includes(r.status);
    let jsonState = null;
    if (plan.json) {
      const jr = mem(plan.json, { root, timeoutMs: CALL_TIMEOUT_MS });
      const parsed = parseJson(jr.stdout);
      jsonState = { argv: plan.json.join(' '), status: jr.status, parses: parsed.ok,
        error: parsed.ok ? null : parsed.error };
    }
    const jsonOk = !jsonState || jsonState.parses;

    atlas.record({
      id: `surface.cmd.${cmd.name}`,
      title: `mem ${plan.argv.join(' ')}`,
      verdict: okExit && jsonOk ? VERDICT.PASS : VERDICT.FAIL,
      expected: `exit ${plan.expect.join(' or ')}${plan.json ? ', --json parses' : ''}`
        + `${plan.note ? ` (${plan.note})` : ''}`,
      actual: `exit ${r.status}${jsonState ? `, --json ${jsonState.parses ? 'parses' : 'does NOT parse'}` : ''}`,
      ms: r.ms,
      severity: okExit ? SEVERITY.MAJOR : SEVERITY.MAJOR,
      measured: {
        group: cmd.group,
        status: r.status,
        ms: r.ms,
        stdoutBytes: r.bytes,
        stderrBytes: Buffer.byteLength(r.stderr),
        stderrSpoke: r.stderr.trim().length > 0,
        timedOut: Boolean(r.timedOut),
        json: jsonState,
      },
      evidence: okExit && jsonOk
        ? null
        : `mem ${plan.argv.join(' ')}\n-> exit ${r.status}\n${firstLine(r)}`
          + (jsonState && !jsonState.parses
            ? `\nmem ${jsonState.argv} -> not JSON: ${jsonState.error}` : ''),
    });
  }

  // `browse` ran, but only into its own refusal. The interactive loop —
  // the thing the command is FOR — was never entered.
  atlas.blind('mem browse (the interactive loop)',
    'needs a TTY; this harness runs the CLI through spawnSync with pipes, '
    + 'so only the documented non-TTY refusal could be driven');

  // An irreversible command, driven once, in a root that exists only for
  // this measurement and is deleted by `tempRoot`'s exit hook. Nothing
  // outside the temporary directory can be reached: the path handed to
  // `raw delete` is one this phase captured itself, seconds earlier, into
  // that same root. Without this the documented two-step (`--yes` or
  // nothing happens) would stay a claim in the help text.
  rawDeleteProbe(atlas, root);

  return { root, ran, notMeasured, total: all.length, corpus };
}

/**
 * `mem serve` binds a port and then stays up, which `spawnSync` cannot
 * outlive. So the probe is: start it, let the timeout kill it, and read
 * what it managed to say. A server that announces its link has bound the
 * port; one that dies before that has not started at all.
 */
function serveProbe(atlas, plan, root, group) {
  const r = mem(plan.argv, { root, timeoutMs: 5000 });
  const announced = /Console: http:\/\/[^\s]+/.test(r.stdout);
  const started = Boolean(r.timedOut) && announced;
  atlas.record({
    id: 'surface.cmd.serve',
    title: `mem ${plan.argv.join(' ')}`,
    verdict: started ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'binds the port and prints its console link, then keeps running',
    actual: started
      ? 'bound and announced, killed by the harness'
      : `exit ${r.status} after ${Math.round(r.ms)} ms — ${firstLine(r)}`,
    ms: r.ms,
    severity: SEVERITY.MAJOR,
    measured: { group, status: r.status, timedOut: Boolean(r.timedOut), announced, ms: r.ms },
    evidence: started ? null
      : `mem ${plan.argv.join(' ')}\n-> exit ${r.status}\n${r.stdout.slice(0, 400)}${r.stderr.slice(0, 600)}`,
  });
  atlas.blind('mem serve (answering an HTTP request)',
    'core mem() drives the CLI with spawnSync, which blocks this process for as '
    + 'long as the server runs — no request can be issued from here. Start and '
    + 'bind are measured; what the server answers is not');
}

/**
 * `mem raw delete` without `--yes` must only SHOW, with `--yes` it must
 * take the bytes out. Both halves, against a capture this phase made.
 */
function rawDeleteProbe(atlas, root) {
  const transcript = writeTranscript(root, 300);
  const captured = mem(['raw-capture', '--transcript', transcript],
    { root, timeoutMs: CALL_TIMEOUT_MS });
  const m = /captured\s+(\S+)/.exec(captured.stdout);
  if (!m) {
    atlas.record({
      id: 'surface.sub.raw-delete',
      title: 'mem raw delete: shows without --yes, deletes with it',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'a capture to delete',
      actual: `raw-capture produced none: ${firstLine(captured)}`,
    });
    atlas.blind('mem raw delete', 'no capture could be produced to delete');
    return;
  }
  const rel = m[1];
  const abs = path.join(root, rel);
  const dry = mem(['raw', 'delete', rel, '--reason', 'atlas surface probe'],
    { root, timeoutMs: CALL_TIMEOUT_MS });
  const survivedDryRun = fs.existsSync(abs);
  const real = mem(['raw', 'delete', rel, '--reason', 'atlas surface probe', '--yes'],
    { root, timeoutMs: CALL_TIMEOUT_MS });
  const goneAfterYes = !fs.existsSync(abs);
  const ok = dry.status === 0 && survivedDryRun && real.status === 0 && goneAfterYes;
  atlas.record({
    id: 'surface.sub.raw-delete',
    title: 'mem raw delete: shows without --yes, removes the bytes with it',
    verdict: ok ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'without --yes the file is still there; with --yes it is gone',
    actual: `without --yes present=${survivedDryRun}, with --yes present=${!goneAfterYes}`,
    severity: SEVERITY.CRITICAL,
    measured: { capture: rel, dryStatus: dry.status, yesStatus: real.status,
      survivedDryRun, goneAfterYes },
    evidence: ok ? null : `${firstLine(dry)}\n${firstLine(real)}`,
  });
}

// --- 2. the exit-code contracts -----------------------------------------

function exitContracts(atlas) {
  // `digest due` — 0 not due, 1 due, 3 cannot tell (search.mjs:772-778).
  {
    const { root } = freshRoot('atlas-digest-', null);
    contract(atlas, { id: 'digest-due-0', root,
      title: 'digest due: nothing captured -> 0 (not due)',
      argv: ['digest', 'due'], expect: 0 });

    const transcript = writeTranscript(root, 400);
    mem(['raw-capture', '--transcript', transcript], { root, timeoutMs: CALL_TIMEOUT_MS });
    // Threshold lowered rather than a 500 KB pile synthesised: the
    // contract under test is the exit code, not `raw.due`'s arithmetic.
    contract(atlas, { id: 'digest-due-1', root,
      title: 'digest due: pile over the volume threshold -> 1 (due)',
      argv: ['digest', 'due', '--volume-now', '1'], expect: 1 });
    // Sabotage counter-probe: same root, same capture, default
    // thresholds — the 1 must go away again, or it was never the
    // threshold that produced it.
    contract(atlas, { id: 'digest-due-1-counter', root,
      title: 'digest due: same pile under the default threshold -> 0 again',
      argv: ['digest', 'due'], expect: 0 });

    // `pending()` spreads `wm.digested`; a watermark holding a number
    // instead of a list makes it throw, and the handler must answer
    // "cannot tell" rather than "nothing to do". Worth pinning: the
    // difference between 3 and 0 is a digest that stops for good.
    fs.writeFileSync(path.join(root, '.mem', 'raw-watermark.json'), '{"digested": 5}');
    contract(atlas, { id: 'digest-due-3', root,
      title: 'digest due: unreadable watermark -> 3 (cannot tell)',
      argv: ['digest', 'due'], expect: 3 });
  }

  // `digest bell` is listed alongside `due` as a 0/1/3 command. It is
  // not one: the handler prints and returns, in both of its states.
  // Measured rather than argued.
  {
    const { root } = freshRoot('atlas-bell-', null);
    const before = mem(['digest', 'bell'], { root, timeoutMs: CALL_TIMEOUT_MS });
    mem(['raw-capture', '--transcript', writeTranscript(root, 400)],
      { root, timeoutMs: CALL_TIMEOUT_MS });
    const after = mem(['digest', 'bell'], { root, timeoutMs: CALL_TIMEOUT_MS });
    const flat = before.status === 0 && after.status === 0;
    atlas.record({
      id: 'surface.exit.digest-bell',
      title: 'digest bell: has no exit-code contract, unlike digest due',
      verdict: flat ? VERDICT.PASS : VERDICT.FAIL,
      expected: 'exit 0 with and without a rung bell (only `due` carries 0/1/3)',
      actual: `no bell -> ${before.status}, after a capture -> ${after.status}`,
      severity: SEVERITY.MINOR,
      measured: { withoutBell: before.status, withBell: after.status },
      evidence: flat ? null : `${firstLine(before)}\n${firstLine(after)}`,
    });
  }

  // `inbox watch` — 0 nothing, 1 new mail, 3 broken (agents.mjs:127-138).
  {
    const { root } = freshRoot('atlas-watch-', null);
    contract(atlas, { id: 'inbox-watch-3', root,
      title: 'inbox watch: no reachable remote -> 3 (broken)',
      argv: ['inbox', 'watch', '--as', 'user'], expect: 3 });
    mem(['inbox', 'write', '--as', 'session', '--to', 'user',
      '--subject', 'atlas probe', '--text', 'a message for the watch contract'],
    { root, timeoutMs: CALL_TIMEOUT_MS });
    // Positive control for the 3: with mail actually waiting locally it
    // is STILL 3, which proves the 3 reports the broken remote and not
    // an empty inbox — and that the 0/1 halves below are genuinely out
    // of reach here, not merely untried.
    const withMail = mem(['inbox', 'watch', '--as', 'user', '--skip-fetch'],
      { root, timeoutMs: CALL_TIMEOUT_MS });
    for (const [id, title] of [
      ['inbox-watch-0', 'inbox watch: nothing new -> 0'],
      ['inbox-watch-1', 'inbox watch: new mail on the remote -> 1'],
    ]) {
      atlas.record({
        id: `surface.exit.${id}`,
        title,
        verdict: VERDICT.NOT_MEASURED,
        expected: id.endsWith('0') ? 'exit 0' : 'exit 1',
        actual: `exit ${withMail.status} — ${firstLine(withMail)}`,
        measured: { blockedBy: 'git ls-tree against origin/<branch>' },
      });
    }
    atlas.blind('inbox watch exit 0 and exit 1',
      'both need a git repository with a reachable remote (watch runs '
      + '`git ls-tree origin/<branch>` even with --skip-fetch). This phase '
      + 'performs no git write operations, so the state cannot be built here');
  }

  // `doctor` — 0 fine, 1 warnings, 2 errors (admin.mjs:65).
  {
    const warnRoot = freshRoot('atlas-doctor-warn-', null).root;
    mem(['log', 'learning', '--title', 'atlas doctor probe',
      '--text', 'one entry, timestamped now, so nothing is in the future'],
    { root: warnRoot, timeoutMs: CALL_TIMEOUT_MS });
    contract(atlas, { id: 'doctor-1', root: warnRoot,
      title: 'doctor: warnings but no errors -> 1',
      argv: ['doctor'], expect: 1 });
    contract(atlas, { id: 'doctor-alarm-0', root: warnRoot,
      title: 'doctor --alarm: nothing is DOWN -> 0, and prints nothing',
      argv: ['doctor', '--alarm'], expect: 0 });

    // `--strict` must lift an UNVERIFIABLE guarantee to 2 on the very
    // root where plain doctor said 1. If this root happens to have no
    // unknown guarantee, the check has not run — that is not a pass.
    const strict = mem(['doctor', '--strict'], { root: warnRoot, timeoutMs: CALL_TIMEOUT_MS });
    const unknowns = /--strict:\s*(\d+)\s*guarantee/.exec(strict.stderr);
    const n = unknowns ? Number(unknowns[1]) : 0;
    atlas.record({
      id: 'surface.exit.doctor-strict-2',
      title: 'doctor --strict: an unverifiable guarantee becomes exit 2',
      verdict: n > 0 ? (strict.status === 2 ? VERDICT.PASS : VERDICT.FAIL) : VERDICT.NOT_MEASURED,
      expected: n > 0 ? 'exit 2 (plain doctor said 1 on this root)' : 'a root with an unknown guarantee',
      actual: `exit ${strict.status}, ${n} unknown guarantee(s)`,
      ms: strict.ms,
      severity: SEVERITY.MAJOR,
      measured: { status: strict.status, unknownGuarantees: n },
      evidence: n > 0 && strict.status !== 2 ? firstLine(strict) : null,
    });
    if (n === 0) {
      atlas.blind('doctor --strict exit 2',
        'this root produced no UNVERIFIABLE guarantee, so the lift could not be shown');
    }

    // An error-level root: a corpus whose timestamps run into the
    // future trips the clock finding, which is level ERROR.
    const errRoot = freshRoot('atlas-doctor-err-', 300).root;
    contract(atlas, { id: 'doctor-2', root: errRoot,
      title: 'doctor: an error-level finding -> 2',
      argv: ['doctor'], expect: 2 });
    contract(atlas, { id: 'doctor-alarm-1', root: errRoot,
      title: 'doctor --alarm: something is DOWN -> 1',
      argv: ['doctor', '--alarm'], expect: 1 });

    atlas.record({
      id: 'surface.exit.doctor-0',
      title: 'doctor: nothing wrong at all -> 0',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'exit 0',
      actual: 'no root reachable from here reports zero findings',
      measured: { blockedBy: 'git-hook finding is WARN until core.hooksPath is set' },
    });
    atlas.blind('doctor exit 0',
      'the git-hook guarantee stays a WARN until `mem hooks install` sets '
      + 'core.hooksPath, which needs a git repository; no git write operations here');
  }

  // `epoch` — show 0/2, record 0/2 (admin.mjs:232, 239).
  {
    const { root } = freshRoot('atlas-epoch-', 300);
    contract(atlas, { id: 'epoch-record-0', root,
      title: 'epoch record: watermark moves forward -> 0',
      argv: ['epoch', 'record'], expect: 0 });
    contract(atlas, { id: 'epoch-show-0', root,
      title: 'epoch show: memory is where the watermark left it -> 0',
      argv: ['epoch', 'show'], expect: 0 });

    // The rollback: the books lose their content while the watermark
    // still remembers them. Exactly the restored-stale-checkout case the
    // command exists for.
    const globalDir = path.join(root, 'global');
    for (const name of fs.readdirSync(globalDir)) {
      if (name.endsWith('.jsonl')) fs.writeFileSync(path.join(globalDir, name), '');
    }
    contract(atlas, { id: 'epoch-show-2', root,
      title: 'epoch show: the memory went BACKWARDS -> 2',
      argv: ['epoch', 'show'], expect: 2 });
    contract(atlas, { id: 'epoch-record-2', root,
      title: 'epoch record: refuses to lower the watermark -> 2',
      argv: ['epoch', 'record'], expect: 2 });
    // Positive control: --force is the documented way through, and it
    // must be 0 — otherwise the 2 above is not a refusal, just breakage.
    contract(atlas, { id: 'epoch-record-force-0', root,
      title: 'epoch record --force: the declared rollback -> 0',
      argv: ['epoch', 'record', '--force'], expect: 0 });
  }

  // `shrink` — 0 calm, 2 alarm (capture.mjs:489).
  {
    const { root } = freshRoot('atlas-shrink-', 300);
    contract(atlas, { id: 'shrink-0', root,
      title: 'shrink: first run, baseline written -> 0',
      argv: ['shrink'], expect: 0 });
    contract(atlas, { id: 'shrink-0-counter', root,
      title: 'shrink: nothing shrank since the baseline -> 0',
      argv: ['shrink'], expect: 0 });
    const book = path.join(root, 'global', 'learnings.jsonl');
    fs.writeFileSync(book, fs.readFileSync(book, 'utf8').slice(0, 20));
    contract(atlas, { id: 'shrink-2', root,
      title: 'shrink: an append-only book got smaller -> 2 (ALARM)',
      argv: ['shrink'], expect: 2 });
  }

  // `embed backfill` — 0 / 2 without a key (admin.mjs:378).
  {
    const { root } = freshRoot('atlas-embed-', null);
    const r = mem(['embed', 'backfill'], { root, timeoutMs: CALL_TIMEOUT_MS });
    atlas.record({
      id: 'surface.exit.embed-backfill-2',
      title: 'embed backfill: no API key -> 2',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'exit 2 (the no-key branch)',
      actual: `exit ${r.status} — ${firstLine(r)}`,
      ms: r.ms,
      measured: { status: r.status,
        blockedBy: 'the vector store is opened before the key is ever read' },
      evidence: `${firstLine(r)}`,
    });
    atlas.blind('embed backfill exit 2',
      'better-sqlite3 and sqlite-vec are optional dependencies and are not '
      + 'installed here, so the store import fails (exit 1) before the no-key '
      + 'branch (exit 2) is ever reached. Installing them is a network operation');
  }

  // `onboarding` — 0 / 1 (agents.mjs:450).
  {
    const { root } = freshRoot('atlas-onboarding-', null);
    contract(atlas, { id: 'onboarding-1', root,
      title: 'onboarding: steps still open -> 1',
      argv: ['onboarding', 'atlasprobe'], expect: 1 });
    mem(['agent', 'new', 'atlasprobe', '--role', 'atlas surface probe'],
      { root, timeoutMs: CALL_TIMEOUT_MS });
    mem(['heartbeat', '--what', 'atlas surface probe'],
      { root, env: { CHEAP_MEM_AGENT: 'atlasprobe' }, timeoutMs: CALL_TIMEOUT_MS });
    mem(['log', 'learning', '--title', 'atlas loop proof',
      '--text', 'written by the agent and findable again', '--tags', 'onboarding'],
    { root, env: { CHEAP_MEM_AGENT: 'atlasprobe' }, timeoutMs: CALL_TIMEOUT_MS });
    contract(atlas, { id: 'onboarding-0', root,
      title: 'onboarding: every step evidenced -> 0',
      argv: ['onboarding', 'atlasprobe'], expect: 0 });
  }

  // `hooks check` — 0 / 1 (setup.mjs:264).
  {
    const { root } = freshRoot('atlas-hooks-', null);
    contract(atlas, { id: 'hooks-check-1', root,
      title: 'hooks check: the hook does not fire -> 1',
      argv: ['hooks', 'check'], expect: 1 });
    atlas.record({
      id: 'surface.exit.hooks-check-0',
      title: 'hooks check: the planted token is caught -> 0',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'exit 0',
      actual: 'core.hooksPath cannot be set without a git repository',
      measured: { blockedBy: 'git config core.hooksPath' },
    });
    atlas.blind('hooks check exit 0',
      '`mem hooks install` sets core.hooksPath via git; this phase performs '
      + 'no git write operations, so the armed state cannot be produced');
  }

  // `guard run` — 0 / 1 (setup.mjs:368).
  {
    const { root } = freshRoot('atlas-guard-', null);
    contract(atlas, { id: 'guard-run-0-empty', root,
      title: 'guard run: no latch at all -> 0',
      argv: ['guard', 'run'], expect: 0 });

    // Latches are written straight into the book: `mem log` turns
    // `--guard` into a string, and `guard.check` needs an object. The
    // root is a throwaway, and the entry is a normal append.
    const errors = path.join(root, 'global', 'errors.jsonl');
    fs.mkdirSync(path.dirname(errors), { recursive: true });
    fs.writeFileSync(path.join(root, 'atlas-latched.txt'), 'the latch watches this\n');
    fs.appendFileSync(errors, `${JSON.stringify({
      id: 'atlasgreen', ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      class: 'looks-right-does-nothing', title: 'atlas green latch',
      guard: { kind: 'file-there', path: 'atlas-latched.txt' },
    })}\n`);
    contract(atlas, { id: 'guard-run-0-green', root,
      title: 'guard run: every latch green -> 0',
      argv: ['guard', 'run'], expect: 0 });

    fs.appendFileSync(errors, `${JSON.stringify({
      id: 'atlasred', ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      class: 'looks-right-does-nothing', title: 'atlas red latch',
      guard: { kind: 'file-there', path: 'atlas-never-existed.txt' },
    })}\n`);
    contract(atlas, { id: 'guard-run-1', root,
      title: 'guard run: a latch is RED -> 1',
      argv: ['guard', 'run'], expect: 1 });
  }
}

// --- 3. status --json and the skipped die() ------------------------------

function statusJson(atlas) {
  const { root } = freshRoot('atlas-status-', null);

  // Positive control first: while nothing is broken, both forms exit 0.
  // Without this the 0 measured below could be read as "--json always
  // agrees", and the finding would rest on a single observation.
  const healthyPlain = mem(['status'], { root, timeoutMs: CALL_TIMEOUT_MS });
  const healthyJson = mem(['status', '--json'], { root, timeoutMs: CALL_TIMEOUT_MS });

  // The broken state: a config that exists and is not readable JSON.
  // `setup.memoryStep` calls that BROKEN, which is the one state
  // `mem status` is documented to exit non-zero on.
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{ this is not json');
  const plain = mem(['status'], { root, timeoutMs: CALL_TIMEOUT_MS });
  const json = mem(['status', '--json'], { root, timeoutMs: CALL_TIMEOUT_MS });
  const parsed = parseJson(json.stdout);
  const brokenInPayload = parsed.ok
    && (parsed.value.broken > 0 || (parsed.value.steps ?? []).some((s) => s.state === 'broken'));

  atlas.record({
    id: 'surface.status-json-control',
    title: 'status: nothing broken -> both forms exit 0 (positive control)',
    verdict: healthyPlain.status === 0 && healthyJson.status === 0
      ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'plain 0, --json 0',
    actual: `plain ${healthyPlain.status}, --json ${healthyJson.status}`,
    severity: SEVERITY.MINOR,
    measured: { plain: healthyPlain.status, json: healthyJson.status },
  });

  const divergent = plain.status !== json.status;
  atlas.record({
    id: 'surface.status-json-skips-die',
    title: 'status --json reports a broken step with exit 0',
    verdict: divergent ? VERDICT.FAIL : VERDICT.PASS,
    expected: 'the same exit code as `mem status` on the same broken root',
    actual: `mem status -> ${plain.status}, mem status --json -> ${json.status}`,
    severity: SEVERITY.MAJOR,
    measured: {
      plainStatus: plain.status,
      jsonStatus: json.status,
      jsonParses: parsed.ok,
      brokenReportedInPayload: brokenInPayload,
      where: 'src/cli/commands/admin.mjs:399 returns before the die() at the end',
    },
    evidence: divergent
      ? 'root: .mem/config.json replaced with `{ this is not json`\n'
        + `mem status      -> exit ${plain.status}  ${firstLine(plain)}\n`
        + `mem status --json -> exit ${json.status}  ${json.stdout.slice(0, 300)}\n`
        + 'The payload names the broken step; the exit code does not. Every '
        + 'caller that reads `mem status --json` in a script sees success.'
      : null,
  });
}

// --- 4. mem inbox --help (and what stands next to it) --------------------

function helpDispatch(atlas) {
  // `mem inbox --help` is reported as the one command that refuses its
  // own help. Both of its states are driven, because the failure looks
  // different depending on whether this install has an identity: without
  // one it exits 1, with one it exits 0 and prints the INBOX instead of
  // the help.
  const unset = freshRoot('atlas-inboxhelp-a-', null).root;
  const withId = freshRoot('atlas-inboxhelp-b-', null).root;
  mem(['whoami', 'session'], { root: withId, timeoutMs: CALL_TIMEOUT_MS });

  const a = mem(['inbox', '--help'], { root: unset, timeoutMs: CALL_TIMEOUT_MS });
  const b = mem(['inbox', '--help'], { root: withId, timeoutMs: CALL_TIMEOUT_MS });
  const showsHelp = (r) => /(^|\n)\s*mem inbox\b/.test(r.stdout);
  const ok = a.status === 0 && showsHelp(a) && b.status === 0 && showsHelp(b);

  atlas.record({
    id: 'surface.inbox-help',
    title: 'mem inbox --help prints help',
    verdict: ok ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'exit 0 with the `mem inbox ...` usage block',
    actual: `no identity: exit ${a.status}, help=${showsHelp(a)}; `
      + `with identity: exit ${b.status}, help=${showsHelp(b)}`,
    ms: a.ms,
    severity: SEVERITY.MINOR,
    measured: {
      withoutIdentity: { status: a.status, showsHelp: showsHelp(a) },
      withIdentity: { status: b.status, showsHelp: showsHelp(b) },
      where: 'src/cli/commands/agents.mjs:32 takes the subcommand before any isHelp check',
    },
    evidence: ok ? null
      : `mem inbox --help (no whoami) -> exit ${a.status}: ${firstLine(a)}\n`
        + `mem inbox --help (whoami set) -> exit ${b.status}: ${firstLine(b)}`,
  });
}

// --- 5. the cache state, as its own number -------------------------------

/**
 * Three DEFINED states for `mem find`, timed through the real process.
 *
 * Without this, a benchmark of `find` measures whichever of three
 * programs the previous run happened to leave behind: a cold start that
 * rebuilds the whole index, a warm load with an un-cached tail, or a warm
 * load of a cache that was just written. `bench/scale.mjs:40-45` names the
 * cache as the thing that bites first and does not put a number on it.
 *
 * The state is verified before every single run, not assumed. A "cold"
 * run whose cache file is still there is not a cold run, and a harness
 * that does not look cannot tell.
 */
function cacheStates(atlas, quick) {
  const runs = quick ? 10 : 12;
  const entries = quick ? 300 : 2000;
  const { root, corpus } = freshRoot('atlas-cache-', entries);
  const query = corpus.anchors[0].query;
  const cachePath = path.join(root, CACHE_FILE);
  const opts = { root, timeoutMs: CALL_TIMEOUT_MS };

  const stats = (ms) => {
    const s = [...ms].sort((a, b) => a - b);
    return { n: s.length, min: s[0] ?? null, p50: pct(s, 50), p95: pct(s, 95),
      max: s[s.length - 1] ?? null };
  };

  // --- cold: the cache file is removed before every run.
  const cold = [];
  let coldStateHeld = true;
  for (let i = 0; i < runs; i += 1) {
    try { fs.rmSync(cachePath, { force: true }); } catch { /* not there is fine */ }
    if (fs.existsSync(cachePath)) coldStateHeld = false;
    const r = mem(['find', query], opts);
    if (r.status !== 0) coldStateHeld = false;
    cold.push(r.ms);
  }
  const cacheWritten = fs.existsSync(cachePath);

  // --- warm-fresh: one `--fresh` rebuild, then plain runs off that cache.
  mem(['find', query, '--fresh'], opts);
  const freshWarm = [];
  let freshStateHeld = fs.existsSync(cachePath);
  for (let i = 0; i < runs; i += 1) {
    if (!fs.existsSync(cachePath)) freshStateHeld = false;
    const r = mem(['find', query], opts);
    if (r.status !== 0) freshStateHeld = false;
    freshWarm.push(r.ms);
  }

  // --- warm-incremental: one entry appended before each run, so every
  //     run reads the cache AND the un-cached tail behind it.
  const incr = [];
  let incrStateHeld = true;
  for (let i = 0; i < runs; i += 1) {
    const w = mem(['log', 'learning', '--title', `atlas cache tail ${i}`,
      '--text', 'appended so the next search reads an un-cached tail'], opts);
    if (w.status !== 0) incrStateHeld = false;
    if (!fs.existsSync(cachePath)) incrStateHeld = false;
    const r = mem(['find', query], opts);
    if (r.status !== 0) incrStateHeld = false;
    incr.push(r.ms);
  }

  const c = stats(cold);
  const f = stats(freshWarm);
  const w = stats(incr);
  const penalty = f.p50 ? c.p50 / f.p50 : null;

  atlas.record({
    id: 'surface.cache.state-held',
    title: 'the three cache states were actually produced before each run',
    verdict: coldStateHeld && freshStateHeld && incrStateHeld ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'cache absent before every cold run, present before every warm run',
    actual: `cold ${coldStateHeld}, warm-fresh ${freshStateHeld}, warm-incremental ${incrStateHeld}`,
    severity: SEVERITY.MAJOR,
    measured: { coldStateHeld, freshStateHeld, incrStateHeld, cacheWrittenByColdRun: cacheWritten },
  });

  for (const [id, label, s] of [
    ['cold', 'cold: .mem/search-index.json deleted before each run', c],
    ['warm-fresh', 'warm-fresh: straight off a cache just rebuilt with --fresh', f],
    ['warm-incremental', 'warm-incremental: cache plus one freshly appended entry', w],
  ]) {
    atlas.record({
      id: `surface.cache.${id}`,
      title: `mem find, ${label}`,
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: `p50 ${s.p50?.toFixed(1)} ms, p95 ${s.p95?.toFixed(1)} ms`,
      ms: s.p50,
      measured: { entries: corpus.count, runs: s.n, ...s },
    });
  }

  // The number the phase was built for. No threshold is asserted: there
  // is no published one to hold it to, and inventing one here would make
  // the first run define the answer. It is recorded so the NEXT run has
  // something to be a regression against.
  atlas.record({
    id: 'surface.cache.cold-penalty',
    title: 'what a cold index costs against a warm one, end to end',
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: penalty
      ? `${penalty.toFixed(1)}x (cold p50 ${c.p50?.toFixed(1)} ms vs warm-fresh p50 ${f.p50?.toFixed(1)} ms)`
      : 'not computable',
    measured: {
      entries: corpus.count,
      coldP50: c.p50, coldP95: c.p95,
      warmFreshP50: f.p50, warmFreshP95: f.p95,
      warmIncrementalP50: w.p50, warmIncrementalP95: w.p95,
      coldOverWarmFresh: penalty,
      coldMinusWarmFreshMs: c.p50 !== null && f.p50 !== null ? c.p50 - f.p50 : null,
      incrementalOverWarmFresh: f.p50 ? w.p50 / f.p50 : null,
      note: 'every number includes one Node start; see environment.nodeStartupMsP50',
    },
  });

  atlas.blind('the cache at realistic scale',
    `measured at ${corpus.count} entries. src/search.mjs:1024 quotes ~1.5 s to load and `
    + '~2.6 s to write at 200k entries; those two numbers are still unmeasured here');
}

// --- 6. --help for every command -----------------------------------------

function helpForEveryCommand(atlas) {
  // Identity set on purpose: without it `mem inbox --help` fails on the
  // missing whoami, and the real defect (help is never dispatched) would
  // be hidden behind an unrelated refusal.
  const { root } = freshRoot('atlas-help-', 100);
  mem(['whoami', 'session'], { root, timeoutMs: CALL_TIMEOUT_MS });

  /**
   * Help is not "exit 0 and some bytes". Every help block in this CLI
   * opens with a usage line naming the command, so that is the test: a
   * command that prints its normal output under `--help` has exit 0 and
   * plenty of bytes, and has still not shown its help.
   */
  const showsUsage = (name, stdout) =>
    new RegExp(`(^|\\n)\\s*mem ${name.replace(/-/g, '\\-')}\\b`).test(stdout);

  // Positive control and sabotage counter-probe for that test itself.
  const control = mem(['find', '--help'], { root, timeoutMs: CALL_TIMEOUT_MS });
  const counter = mem(['find', 'deploy'], { root, timeoutMs: CALL_TIMEOUT_MS });
  atlas.record({
    id: 'surface.help.detector',
    title: 'the help detector separates a help block from ordinary output',
    verdict: showsUsage('find', control.stdout) && !showsUsage('find', counter.stdout)
      ? VERDICT.PASS : VERDICT.FAIL,
    expected: '`find --help` shows the usage line, `find <query>` does not',
    actual: `--help ${showsUsage('find', control.stdout)}, query ${showsUsage('find', counter.stdout)}`,
    severity: SEVERITY.MAJOR,
  });

  const all = commandList();
  const failures = [];
  for (const { name, group } of all) {
    const r = mem([name, '--help'], { root, timeoutMs: CALL_TIMEOUT_MS });
    const usage = showsUsage(name, r.stdout);
    const ok = r.status === 0 && usage;
    if (!ok) failures.push({ name, group, status: r.status, usage, first: firstLine(r) });
    // Three outcomes, not two. A command that refuses `--help` outright is
    // broken; one that exits 0 and prints its ordinary output instead of
    // help still ran, and still did not answer the question that was
    // asked. Collapsing those two into one verdict would hide which of
    // the sixty is actually unreachable behind `--help`.
    atlas.record({
      id: `surface.help.${name}`,
      title: `mem ${name} --help`,
      verdict: ok ? VERDICT.PASS : (r.status === 0 ? VERDICT.DEGRADED : VERDICT.FAIL),
      expected: 'exit 0 and a usage block naming the command',
      actual: r.status === 0 && !usage
        ? `exit 0, but printed ordinary output instead of help: ${firstLine(r)}`
        : `exit ${r.status}, usage line ${usage ? 'present' : 'ABSENT'}`,
      ms: r.ms,
      severity: r.status === 0 ? SEVERITY.MINOR : SEVERITY.MAJOR,
      measured: { group, status: r.status, usage, stdoutBytes: r.bytes },
      evidence: ok ? null : `mem ${name} --help -> exit ${r.status}\n${firstLine(r)}`,
    });
  }

  atlas.record({
    id: 'surface.help.all',
    title: 'every command answers --help with help',
    verdict: failures.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    expected: `${all.length} of ${all.length}`,
    actual: `${all.length - failures.length} of ${all.length}`,
    severity: SEVERITY.MAJOR,
    measured: { total: all.length, failures },
    evidence: failures.length
      ? failures.map((f) => `${f.name}: exit ${f.status}, usage=${f.usage} — ${f.first}`).join('\n')
      : null,
  });

  // `--help` must not DO anything. `mem init --help` runs through
  // checkFlags — which skips `help` — and reaches the initialiser.
  const virgin = tempRoot('atlas-helpwrite-');
  const before = fs.existsSync(path.join(virgin, '.mem', 'config.json'));
  const r = mem(['init', '--help'], { root: virgin, timeoutMs: CALL_TIMEOUT_MS });
  const after = fs.existsSync(path.join(virgin, '.mem', 'config.json'));
  atlas.record({
    id: 'surface.help.no-side-effect',
    title: 'mem init --help asks for help and does not initialise',
    verdict: !before && !after ? VERDICT.PASS : VERDICT.FAIL,
    expected: 'no .mem/config.json created by a --help call',
    actual: after ? '.mem/config.json was created' : 'nothing written',
    ms: r.ms,
    severity: SEVERITY.MAJOR,
    measured: { configBefore: before, configAfter: after, status: r.status },
    evidence: after ? `mem init --help -> exit ${r.status}: ${firstLine(r)}` : null,
  });
}

// --- the phase -----------------------------------------------------------

export async function run(atlas, { quick = false } = {}) {
  atlas.phase('surface', 'Every command, actually executed',
    'Sixty commands driven as real processes, their documented exit codes put '
    + 'into the situations that are supposed to produce them, and the index '
    + 'cache measured in three defined states instead of whichever one the '
    + 'previous run left behind. Nothing here is imported: `bin/mem` is '
    + 'started, exactly as a hook or a timer starts it.');

  const s = sweep(atlas, quick);
  exitContracts(atlas);
  statusJson(atlas);
  helpDispatch(atlas);
  cacheStates(atlas, quick);
  helpForEveryCommand(atlas);

  atlas.record({
    id: 'surface.coverage',
    title: 'how much of the surface this phase actually drove',
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: `${s.ran} of ${s.total} commands executed, ${s.notMeasured} not measurable here`,
    measured: {
      commands: s.total, executed: s.ran, notMeasured: s.notMeasured,
      corpusEntries: s.corpus.count, corpusFiles: s.corpus.files,
      repo: REPO, quick,
    },
  });
}
