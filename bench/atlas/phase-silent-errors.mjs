// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-silent-errors.mjs — does a read that failed look different
// from a read that found nothing?
//
// **The phase id.** `silent-errors`. The sister house (lucky-mem) calls the
// same phase `stille-fehler` ("silent errors" in German); the mapping is
// recorded in test/atlas-phase-parity.json.
//
// **The rule (CLAUDE.md, design commitment 2).** Reads distinguish
// missing / empty / broken, and never collapse to `[]` on failure. A failure
// that turns into an empty answer is the quietest bug there is: the caller
// believes it asked, and was told "nothing". The sister house cross-checked
// its code for this on 2026-10-10 (items E1 to E4 of its plan 03) and found
// four places; this phase asks the same of this house, as measured records.
//
// **What it does.**
//
//   readlog       `memory.readLog` on a log in each of five states: ok,
//                 missing, empty, broken (one line that is not JSON), unreadable
//                 (a directory where the file should be). The five answers
//                 must be five different answers; unreadable must throw.
//   surfaces      The same five states on the files `mem find` and `mem
//                 context` read, asked four ways: the CLI and the bridge
//                 (`mem_find`, `mem_context`). ok is the positive control.
//                 Missing and empty may share an answer ("nothing recorded")
//                 but must not be an error; unreadable must be an error that
//                 names the file; a broken line must not be skipped without a
//                 word (`degraded` when the other lines are returned and the
//                 skipped one is not mentioned: the answer is partial and does
//                 not say so; `mem doctor` reports the line).
//   visibility    E1. The client-visibility journal (src/mcpvisibility.mjs)
//                 in the same five states. An unreadable journal must not
//                 read as "no tool was ever seen".
//   task-lane     E3. The task block a subagent gets at SubagentStart
//                 (src/subagenttask.mjs, `forTask`): a search lane that
//                 throws must not read as "no known error". A child process
//                 loads bench/atlas/inject-search-failure.mjs, which makes the
//                 lane for `error` throw; three runs compare the healthy
//                 answer (positive control), an assignment nothing matches
//                 (the "nothing found" answer) and the failing lane.
//
// **Counters.** Every record carries the answer it saw (exit code, whether
// it was an error, whether it named the file or the skipped line), never a
// duration.
//
// **A red here is a finding, not a bug of the phase.** E1 and E3 were red in
// this house when the phase was written (they are ported with the next
// change to src/, not in the change that added this phase). The phase records
// them as `fail` with the evidence: the line in the source that turns the
// failure into an empty answer. When the port lands, the records turn green
// with no change here. They did: E1 (src/mcpvisibility.mjs `read()`/`sightings()`)
// and E3 (src/subagenttask.mjs `failureNotice()`) were ported in change
// silent-errors-cm, and read `pass` since.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  VERDICT, SEVERITY, REPO, mem, tempRoot,
} from './core.mjs';
import { openBridge, writeBridgeConfig } from './bridge-client.mjs';
import * as memory from '../../src/memory.mjs';
import * as mcpvisibility from '../../src/mcpvisibility.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECTOR = pathToFileURL(path.join(HERE, 'inject-search-failure.mjs'));

/** The five states a log can be in, in the order they are asked. */
export const STATES = Object.freeze(['ok', 'missing', 'empty', 'broken', 'unreadable']);

/** What the question asks for, and the word that stands only in the planted entries' titles (the question's own echo must not count as "shown"). */
const QUERY = 'zorbleplex';
const MARK = 'sefmarker';
const GOOD_LEARNING = { id: 'sef-learning-1', ts: '2026-10-01T10:00:00Z', title: `${MARK} note`, text: `${QUERY} works the way it should`, tags: ['silent-errors'] };
const GOOD_ERROR = { id: 'sef-error-1', ts: '2026-10-01T10:00:00Z', class: 'wrong-cause', title: `${MARK} error`, text: `${QUERY} broke`, tags: ['silent-errors'] };

const short = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true });

/** The 1-based line of the first line of `rel` that contains `needle`, or `null`. */
function lineOf(rel, needle) {
  try {
    const at = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').findIndex((l) => l.includes(needle));
    return at === -1 ? null : at + 1;
  } catch { return null; }
}
const where = (rel, needle) => { const n = lineOf(rel, needle); return n ? `${rel}:${n}` : rel; };

/** Put `file` into one of the five states; `good` is the content of the ok state. */
function setState(file, state, good) {
  rmDir(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (state === 'ok') fs.writeFileSync(file, `${JSON.stringify(good)}\n`);
  else if (state === 'empty') fs.writeFileSync(file, '');
  else if (state === 'broken') fs.writeFileSync(file, `this line is not json at all\n${JSON.stringify(good)}\n`);
  else if (state === 'unreadable') fs.mkdirSync(file);
  // missing: nothing is left at the path
}

function rec(atlas, { id, title, verdict, expected, actual, evidence, measured = null, severity = null }) {
  return atlas.record({
    id, title, verdict, expected, actual: String(actual), evidence: String(evidence || '(no further evidence)'), measured, severity,
  });
}
const pf = (ok) => (ok ? VERDICT.PASS : VERDICT.FAIL);
function skipped(atlas, { id, title, expected }, reason) {
  return rec(atlas, { id, title, verdict: VERDICT.NOT_MEASURED, expected, actual: 'not asked', evidence: reason });
}

// --- readlog -----------------------------------------------------------------------------

function readlogGroup(atlas) {
  const root = tempRoot('atlas-silent-readlog-');
  const file = memory.logPath(root, 'learning');
  const answers = {};
  for (const state of STATES) {
    setState(file, state, GOOD_LEARNING);
    try {
      const r = memory.readLog(root, 'learning');
      answers[state] = { threw: false, missing: r.missing === true, count: r.entries.length, broken: r.entries.filter((e) => e.__broken).length };
    } catch (e) { answers[state] = { threw: true, name: e?.name ?? 'Error', message: short(e?.message, 100) }; }
  }
  const a = answers;
  const checks = [
    ['ok', !a.ok.threw && !a.ok.missing && a.ok.count === 1 && a.ok.broken === 0, 'one entry, not missing, nothing broken'],
    ['missing', !a.missing.threw && a.missing.missing === true && a.missing.count === 0, 'missing: true, no entries'],
    ['empty', !a.empty.threw && a.empty.missing === false && a.empty.count === 0, 'missing: false, no entries (not the same as missing)'],
    ['broken', !a.broken.threw && a.broken.broken === 1 && a.broken.count === 2, 'the broken line comes back as a marked entry next to the good one'],
    ['unreadable', a.unreadable.threw === true, 'throws (not an empty answer)'],
  ];
  const controlOk = checks[0][1];
  for (const [state, ok, expected] of checks) {
    const id = `silent-errors.readlog.${state}`;
    const title = `memory.readLog: a log in the state "${state}" is answered as that state`;
    if (state !== 'ok' && !controlOk) { skipped(atlas, { id, title, expected }, 'the positive control silent-errors.readlog.ok failed'); continue; }
    rec(atlas, {
      id, title, verdict: pf(ok), expected, severity: SEVERITY.MAJOR,
      actual: JSON.stringify(a[state]), evidence: `${where('src/memory.mjs', 'export function readLog')}; log: global/learnings.jsonl in a throwaway root`, measured: a[state],
    });
  }
}

// --- surfaces ------------------------------------------------------------------------------

/** What a surface said, reduced to the facts the verdicts need. */
export function digest(answer, { mark, file }) {
  const text = `${answer.stdout ?? ''}\n${answer.stderr ?? ''}\n${answer.text ?? ''}`;
  return {
    error: answer.isError === true || (typeof answer.status === 'number' && answer.status !== 0),
    shows: text.includes(mark),
    namesFile: text.includes(path.basename(file)),
    mentionsSkip: /\b(broken|unparsable|unparseable|malformed|corrupt|skipped|not valid json|not json)\b/i.test(text.replace(/this line is not json at all/g, '')),
    text: short(text, 220),
  };
}

export function judge(state, d) {
  switch (state) {
    case 'ok': return { verdict: d.shows && !d.error ? VERDICT.PASS : VERDICT.FAIL, expected: `no error; the entry ("${MARK}") is shown` };
    case 'missing':
    case 'empty': return { verdict: !d.error && !d.shows ? VERDICT.PASS : VERDICT.FAIL, expected: 'no error; nothing shown (nothing recorded)' };
    case 'unreadable': {
      const expected = 'an error that names the file; not an empty answer';
      if (!d.error) return { verdict: VERDICT.FAIL, expected };
      return { verdict: d.namesFile ? VERDICT.PASS : VERDICT.DEGRADED, expected };
    }
    default: {
      if (d.error) return { verdict: VERDICT.PASS, expected: 'the good entry is shown and the skipped line is mentioned (or the call is an error)' };
      if (d.shows && d.mentionsSkip) return { verdict: VERDICT.PASS, expected: 'the good entry is shown and the skipped line is mentioned' };
      if (d.shows) return { verdict: VERDICT.DEGRADED, expected: 'the good entry is shown and the skipped line is mentioned' };
      return { verdict: VERDICT.FAIL, expected: 'the good entry is shown and the skipped line is mentioned' };
    }
  }
}

async function surfacesGroup(atlas) {
  const root = tempRoot('atlas-silent-surfaces-');
  writeBridgeConfig(root);
  const learnings = memory.logPath(root, 'learning');
  const errors = memory.logPath(root, 'error');
  const bridge = await openBridge(root);
  try {
    const surfaces = [
      {
        key: 'cli-find', file: learnings, good: GOOD_LEARNING, mark: MARK, what: '`mem find`',
        ask: () => mem(['find', QUERY], { root }),
      },
      {
        key: 'cli-context', file: errors, good: GOOD_ERROR, mark: MARK, what: '`mem context`',
        ask: () => mem(['context'], { root }),
      },
      {
        key: 'bridge-find', file: learnings, good: GOOD_LEARNING, mark: MARK, what: 'the bridge tool `mem_find`',
        ask: () => bridge.call('mem_find', { query: QUERY }),
      },
      {
        key: 'bridge-context', file: errors, good: GOOD_ERROR, mark: MARK, what: 'the bridge tool `mem_context`',
        ask: () => bridge.call('mem_context', {}),
      },
    ];
    for (const s of surfaces) {
      // The other file of the pair is healthy and empty while this one is varied, so one log at a time is the variable.
      const other = s.file === learnings ? errors : learnings;
      setState(other, 'missing', null);
      let controlOk = true;
      for (const state of STATES) {
        const id = `silent-errors.${s.key}.${state}`;
        const title = `${s.what}: a log in the state "${state}" is answered as that state`;
        const expected = judge(state, { shows: true, error: false, namesFile: false, mentionsSkip: false }).expected;
        if (state !== 'ok' && !controlOk) { skipped(atlas, { id, title, expected }, `the positive control silent-errors.${s.key}.ok failed`); continue; }
        setState(s.file, state, s.good);
        const answer = await s.ask();
        const d = digest(answer, s);
        const j = judge(state, d);
        if (state === 'ok') controlOk = j.verdict === VERDICT.PASS;
        rec(atlas, {
          id, title, verdict: j.verdict, expected: j.expected, severity: state === 'broken' ? SEVERITY.MINOR : SEVERITY.MAJOR,
          actual: `${d.error ? 'error' : 'answer'}; entry shown: ${d.shows}; file named: ${d.namesFile}; skipped line mentioned: ${d.mentionsSkip}`,
          evidence: `answer: ${d.text}`,
          measured: { surface: s.key, state, error: d.error, shows: d.shows, namesFile: d.namesFile, mentionsSkip: d.mentionsSkip },
        });
      }
      setState(s.file, 'missing', null);
    }
  } finally { await bridge.close(); }
}

// --- E1: the visibility journal ----------------------------------------------------------------

function visibilityGroup(atlas) {
  const root = tempRoot('atlas-silent-visibility-');
  const file = path.join(root, mcpvisibility.LOG);
  const row = { ts: '2026-10-01T10:00:00.000Z', method: 'tools/call', tool: 'mem_find', client: 'atlas-probe' };
  const seen = {};
  for (const state of STATES) {
    setState(file, state, row);
    const read = mcpvisibility.read(root);
    let latest;
    try { latest = mcpvisibility.latestPerTool(root); } catch (e) { latest = e; }
    seen[state] = {
      keys: Object.keys(read).sort().join(','), rows: read.rows?.length ?? null, broken: read.broken ?? null,
      state: read.state ?? read.status ?? read.error ?? null,
      latestThrew: latest instanceof Error, latestSize: latest instanceof Map ? latest.size : null,
    };
  }
  const missing = seen.missing; const un = seen.unreadable;
  const same = un.rows === missing.rows && un.broken === missing.broken && un.state === missing.state && un.latestThrew === missing.latestThrew && un.latestSize === missing.latestSize;
  const readLine = where('src/mcpvisibility.mjs', 'return { rows: [], broken: 0 }');
  const consumer = where('bin/mem-serve', 'mcpvisibility.latestPerTool');
  const okState = seen.ok.rows === 1 && seen.ok.broken === 0;
  const items = [
    { id: 'silent-errors.visibility.broken', title: 'the visibility journal with one broken line counts the line (E1)', expected: 'one row read, one broken line counted',
      ok: seen.broken.rows === 1 && seen.broken.broken === 1, actual: `rows ${seen.broken.rows}, broken ${seen.broken.broken}` },
    { id: 'silent-errors.visibility.unreadable', title: 'an unreadable visibility journal is not read as "no tool was ever seen" (E1)',
      expected: 'an answer that differs from the one for a missing journal (a state, an error, or a throw)',
      ok: !same, actual: same
        ? `unreadable gives rows ${un.rows}, broken ${un.broken}, state ${un.state}: the same as missing (rows ${missing.rows}, broken ${missing.broken})`
        : `unreadable gives rows ${un.rows}, broken ${un.broken}, state ${un.state}; missing gives rows ${missing.rows}, broken ${missing.broken}`,
      evidence: `read() answers with the empty value for any failed read at ${readLine}; ${consumer} turns the empty answer into "not seen by any client" for every tool; fields of the answer: ${missing.keys}` },
  ];
  for (const it of items) {
    if (!okState) { skipped(atlas, it, 'the positive control silent-errors.visibility.ok failed'); continue; }
    rec(atlas, { id: it.id, title: it.title, verdict: pf(it.ok), expected: it.expected, actual: it.actual, severity: SEVERITY.MAJOR, evidence: it.evidence ?? `read(): ${where('src/mcpvisibility.mjs', 'export function read')}`, measured: seen });
  }
  rec(atlas, {
    id: 'silent-errors.visibility.ok', title: 'a readable visibility journal with one row is read (the positive control)', verdict: pf(okState),
    expected: 'one row, nothing broken', actual: `rows ${seen.ok.rows}, broken ${seen.ok.broken}`, evidence: 'journal at .pipeline/mcp-visibility.jsonl in a throwaway root', measured: seen.ok,
  });
}

// --- E3: the task lane of a subagent --------------------------------------------------------------

const TASK_MATCH = 'The spreadsheet writer loses formulas in the worksheet columns of the xlsx file';
const TASK_OTHER = 'Rename the quarterly invoices folder and update the readme';

function taskGroup(atlas) {
  const root = tempRoot('atlas-silent-task-');
  writeBridgeConfig(root);
  const r = mem(['log', 'error', '--class', 'wrong-cause', '--title', 'Spreadsheet writer loses formulas in the worksheet columns', '--text', 'formulas written as text into the xlsx columns'], { root });
  const script = `const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'subagenttask.mjs')).href)});`
    + 'const r = await m.forTask(process.env.TASK_ROOT, { prompt: process.env.TASK_TEXT }, { env: { MEM_RETRIEVE_MIN: "0.1" } });'
    + 'console.log(JSON.stringify(r));';
  const ask = (fail, task) => {
    const pre = `--import=${INJECTOR.href}${fail ? `?fail=${fail}` : ''}`;
    const c = spawnSync(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', pre, '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TASK_ROOT: root, TASK_TEXT: task },
    });
    let value; let readable = false;
    try { value = JSON.parse(String(c.stdout).trim().split('\n').pop()); readable = c.status === 0; } catch { value = undefined; }
    return { readable, value, status: c.status, stderr: short(c.stderr, 200) };
  };
  const healthy = ask('', TASK_MATCH);
  const nothing = ask('', TASK_OTHER);
  const failing = ask('error', TASK_MATCH);
  const lane = where('src/subagenttask.mjs', 'the extra is never a reason to stop the start');
  const controlOk = r.status === 0 && healthy.readable && healthy.value && /error/.test(healthy.value.text ?? '') && healthy.value.ids?.length >= 1;
  rec(atlas, {
    id: 'silent-errors.task-lane.control', title: 'the task block of a subagent carries the matching error when the lane works (the positive control)',
    verdict: pf(Boolean(controlOk)), expected: 'a block with one error card',
    actual: healthy.readable ? `${healthy.value ? `a block of ${String(healthy.value.text).length} characters, ${healthy.value.ids.length} ids` : 'null (no block)'}` : `no readable answer (exit ${healthy.status})`,
    evidence: healthy.readable ? `assignment: ${TASK_MATCH}` : healthy.stderr, severity: SEVERITY.MAJOR,
    measured: { blockIds: healthy.value?.ids?.length ?? 0 },
  });
  const nothingOk = nothing.readable && nothing.value === null;
  rec(atlas, {
    id: 'silent-errors.task-lane.nothing-found', title: 'an assignment that matches nothing gets no block (the "nothing found" answer the failing lane is compared with)',
    verdict: pf(nothingOk), expected: 'null', actual: nothing.readable ? JSON.stringify(nothing.value)?.slice(0, 120) ?? 'undefined' : `no readable answer (exit ${nothing.status})`,
    evidence: `assignment: ${TASK_OTHER}`, severity: SEVERITY.MINOR, measured: { value: nothing.value ?? null },
  });
  const item = {
    id: 'silent-errors.task-lane.failed-lane', title: 'a search lane that throws is not answered like a lane that found nothing (E3)',
    expected: 'an answer that differs from the "nothing found" answer: a block that says the error lane failed',
  };
  if (!controlOk || !nothingOk || !failing.readable) {
    skipped(atlas, item, !controlOk ? 'the positive control silent-errors.task-lane.control failed'
      : !nothingOk ? 'the "nothing found" comparison silent-errors.task-lane.nothing-found failed'
        : `the child with the injected failure gave no readable answer (exit ${failing.status}: ${failing.stderr})`);
    return;
  }
  const same = JSON.stringify(failing.value) === JSON.stringify(nothing.value);
  rec(atlas, {
    id: item.id, title: item.title, verdict: pf(!same), expected: item.expected, severity: SEVERITY.MAJOR,
    actual: same ? `the failing lane returned ${JSON.stringify(failing.value)}, the same as an assignment nothing matches` : `the failing lane returned a different answer (${String(failing.value?.text ?? '').length} characters)`,
    evidence: `the error lane was made to throw (bench/atlas/inject-search-failure.mjs); the throw is caught and dropped at ${lane}`,
    measured: { failing: failing.value ?? null, nothing: nothing.value ?? null, healthyIds: healthy.value?.ids?.length ?? 0 },
  });
}

export async function run(atlas, { quick = false } = {}) {
  void quick; // the phase is small at any size: five files, four surfaces, three child processes
  const phase = atlas.phase('silent-errors', 'Silent errors: a read that failed must not look like a read that found nothing');
  readlogGroup(atlas);
  await surfacesGroup(atlas);
  visibilityGroup(atlas);
  taskGroup(atlas);

  phase.note = 'Counters, not clocks: per state, the answer each surface gave (error or not, entry shown or not, file named or not, skipped line mentioned or not). E1 (visibility journal) and E3 (task lane) are recorded as measured; both were red when the phase was added and were fixed by the port that followed (silent-errors-cm).';
  atlas.blind('E2: other catch blocks that return an empty value in critical paths',
    'the sister house found its E2 by searching the code for `catch` that returns empty; this phase asks the surfaces above, not the whole code base, so an empty catch elsewhere is invisible to it');
  atlas.blind('E4: dismissed suggestions on the daily summary',
    'the sister house\'s `mem heute` showed review suggestions that had been dismissed; this house has no command of that name and its counterpart was not looked for in this phase');
  atlas.blind('the file lane of the task block',
    'src/subagenttask.mjs also drops a failing component-table lookup into an empty list (lane 0); only the content-word lane (lane 1) is made to fail');
  atlas.blind('the SubagentStart hook end to end',
    'forTask() is called in a child process with the failure injected; bin/mem-subagent-start and its fallback to the old block are not run');
  atlas.blind('the dashboard page for the visibility journal',
    'bin/mem-serve is not started; the consumer of the journal is named by file and line, its page is not rendered');
  atlas.blind('other unreadable states than a directory in place of the file',
    'EACCES (a permission) cannot be produced reliably when the atlas runs as root, so "unreadable" is a directory where the file should be (EISDIR); the code path is the same catch');
}
