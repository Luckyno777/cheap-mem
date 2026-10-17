// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/silent-errors-gaps.mjs — the groups of the phase `silent-errors` that the sister house measures and this
// phase did not (atlas-luecken, 2026-10-17; the sister's phase `silent-errors` E1 to E4):
//
//   visibility-states   E1  the journal of which client saw which tool has FIVE read states, and an unreadable one is
//                           not "missing" (before: only broken and unreadable-versus-missing were asked)
//   visibility-bridge   E1  the bridge keeps answering when its own journal cannot be read, and writes a row when it can
//   doctor              E2  `mem doctor` tells the five states of a drawer apart: broken (unparsable line, with the line)
//                           from unreadable (the read failed, with the reason); missing and empty are no error
//   task-lane-real      E3  the block a subagent gets names a lane that FAILED, with a real unreadable drawer (the older
//                           records inject the failure; these have the file system do it)
//
// **What is not here, and why.** E4 of the sister house is a review suggestion that stays on the daily summary after the
// entry was discarded. This house has no review lane: `src/today.mjs` lists part (d) `review` as not built, so there is
// nothing to measure (the phase says so in its blind spots). The other lanes of the sister's E2 are read paths that
// this house either does not have or covers with its own probes.
//
// **The code tree is a parameter** (`tree`, default this repository), as in bench/atlas/bridge-gaps.mjs. Module code is
// asked in a CHILD process (`askTree`), so a scratch tree that was changed between two asks is never answered from the
// module cache of this process. A red here is a finding, not a bug of the phase.
import fs from 'node:fs';
import path from 'node:path';
import { SEVERITY, REPO, tempRoot } from './core.mjs';
import { openBridge, writeBridgeConfig } from './bridge-client.mjs';
import {
  emit, notMeasured, guard, short, askTree, setState,
} from './gap-records.mjs';
import * as memory from '../../src/memory.mjs';

const STATES = Object.freeze(['ok', 'missing', 'empty', 'broken', 'unreadable']);
const JOURNAL = path.join('.pipeline', 'mcp-visibility.jsonl');
const ROW = { ts: '2026-10-01T10:00:00.000Z', method: 'tools/call', tool: 'mem_find', client: 'atlas-probe' };
const NOT_JSON = 'this line is not json at all\n';

// --- E1: the five read states of the journal ------------------------------------------------------------------------

/** A root whose journal is in the state; `broken` here means NO usable line (a good line next to a bad one reads as `good`). */
function journalRoot(state) {
  const root = tempRoot(`atlas-silent-vis-${state}-`);
  writeBridgeConfig(root);
  const file = path.join(root, JOURNAL);
  if (state === 'broken') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, NOT_JSON); } else setState(file, state, ROW);
  return root;
}

export async function visibilityStates(atlas, { tree = REPO } = {}) {
  const ids = ['silent-errors.visibility.states'];
  const roots = Object.fromEntries(STATES.map((s) => [s, journalRoot(s)]));
  const asked = askTree(tree, roots.ok, `
    const m = await tree('src/mcpvisibility.mjs');
    const out = {};
    for (const [k, r] of Object.entries(JSON.parse(process.env.ROOTS))) { const x = m.read(r); out[k] = { state: x.state, rows: x.rows.length, broken: x.broken, reason: x.reason ?? null }; }
    console.log(JSON.stringify(out));
  `, { ROOTS: JSON.stringify(roots) });
  const item = {
    id: ids[0], title: 'E1: the visibility journal in each of five states is read as that state (good, missing, empty, broken, unreadable): five different answers, and an unreadable one carries the reason',
    expected: 'ok -> good, missing -> missing, empty -> empty, broken -> broken, unreadable -> unreadable (with a reason); five distinct states',
  };
  if (!asked.ok) { notMeasured(atlas, { ...item, reason: `the child that reads the journal gave no answer (exit ${asked.status}): ${asked.stderr}` }); return; }
  const want = { ok: 'good', missing: 'missing', empty: 'empty', broken: 'broken', unreadable: 'unreadable' };
  const got = asked.value;
  const distinct = new Set(STATES.map((s) => got[s]?.state)).size;
  emit(atlas, {
    ...item,
    ok: STATES.every((s) => got[s]?.state === want[s]) && distinct === STATES.length && Boolean(got.unreadable?.reason),
    actual: `${STATES.map((s) => `${s} -> ${got[s]?.state ?? 'no answer'}`).join(', ')}; ${distinct} distinct; reason for unreadable: ${got.unreadable?.reason ?? 'none'}`,
    evidence: `src/mcpvisibility.mjs read() in a child process against the journal ${JOURNAL} of five throwaway roots (unreadable = a directory in its place)`,
    measured: got, severity: SEVERITY.MAJOR,
  });
}

// --- E1: the bridge keeps answering ------------------------------------------------------------------------------

export async function visibilityBridge(atlas, { tree = REPO } = {}) {
  const ids = ['silent-errors.visibility.bridge-control', 'silent-errors.visibility.bridge-unreadable'];
  const MARK = 'visprobemarker';
  const plant = (state) => {
    const root = tempRoot(`atlas-silent-visbridge-${state}-`);
    writeBridgeConfig(root);
    memory.logEntry(root, 'learning', { id: 'vis-learning-1', title: `${MARK} note`, text: `${MARK} is the word to find`, tags: ['silent-errors'], agent: 'probe' });
    const file = path.join(root, JOURNAL);
    if (state === 'unreadable') { fs.mkdirSync(file, { recursive: true }); }
    return { root, file };
  };
  const ask = async (w) => {
    const b = await openBridge(w.root, { tree });
    try { return await b.call('mem_find', { query: MARK }); } finally { await b.close(); }
  };
  const control = plant('ok');
  const a = await ask(control);
  let rowsSeen = 0;
  try { rowsSeen = fs.readFileSync(control.file, 'utf8').split('\n').filter((l) => /"tool":"mem_find"/.test(l)).length; } catch { rowsSeen = 0; }
  const controlOk = emit(atlas, {
    id: ids[0], title: 'E1 control: with a journal that can be written, a bridge call is answered with the entry and leaves a row for the tool it called',
    ok: !a.isError && a.text.includes(MARK) && rowsSeen >= 1,
    expected: 'mem_find answered with the entry; at least one journal row naming mem_find',
    actual: `${a.isError ? `error: ${short(a.text, 100)}` : 'answered'}; entry shown ${a.text.includes(MARK)}; ${rowsSeen} rows for mem_find`,
    evidence: `real stdio client against bin/mem-mcp; journal ${JOURNAL} of the throwaway root`, measured: { rows: rowsSeen }, severity: SEVERITY.MINOR,
  });
  if (!controlOk) {
    notMeasured(atlas, { id: ids[1], title: 'E1: an unreadable journal does not silence the bridge', expected: 'see the group', reason: 'the positive control silent-errors.visibility.bridge-control failed: the bridge does not write its journal here, so an unreadable one proves nothing' });
    return;
  }
  const w = plant('unreadable');
  const r = await ask(w);
  emit(atlas, {
    id: ids[1], title: 'E1: with a journal that cannot be read or written (a directory in its place) the bridge still answers the call with the entry: a log of sightings never blocks a tool',
    ok: !r.isError && r.text.includes(MARK), expected: 'mem_find answered with the entry, no error',
    actual: r.isError ? `error: ${short(r.text, 140)}` : `answered; entry shown ${r.text.includes(MARK)}`,
    evidence: 'the same call as the control, journal path occupied by a directory', measured: { error: r.isError, shown: r.text.includes(MARK) }, severity: SEVERITY.MAJOR,
  });
}

// --- E2: the doctor tells the states of a drawer apart ----------------------------------------------------------

const GOOD_ERROR = { id: 'sef-error-1', class: 'wrong-cause', title: 'sefmarker error', text: 'zorbleplex broke', tags: ['silent-errors'], agent: 'probe' };
/** The doctor findings that speak about the drawers. */
const WATCHED = Object.freeze(['drawers', 'integrity', 'entry-form', 'index']);

export async function doctorStates(atlas, { tree = REPO } = {}) {
  const ids = STATES.map((s) => `silent-errors.doctor.${s}`);
  const found = {};
  for (const state of STATES) {
    const root = tempRoot(`atlas-silent-doctor-${state}-`);
    writeBridgeConfig(root);
    memory.logEntry(root, 'error', GOOD_ERROR);
    const file = memory.logPath(root, 'error');
    if (state === 'broken') fs.appendFileSync(file, 'this line is not json at all\n');
    else if (state !== 'ok') setState(file, state, GOOD_ERROR);
    const asked = askTree(tree, root, `
      const d = await tree('src/doctor.mjs');
      const r = d.checkAll(process.env.ROOT, { full: false });
      console.log(JSON.stringify(r.findings.filter((f) => ${JSON.stringify(WATCHED)}.includes(f.name)).map((f) => ({ name: f.name, level: f.level, text: String(f.text) }))));
    `, { ROOT: root });
    found[state] = asked;
  }
  const level = (state, name) => found[state].value?.find((f) => f.name === name)?.level ?? null;
  const text = (state, name) => found[state].value?.find((f) => f.name === name)?.text ?? '';
  const errors = (state) => (found[state].value ?? []).filter((f) => f.level === 'error').map((f) => f.name);
  const checks = {
    ok: { ok: !errors('ok').length && level('ok', 'drawers') === 'good', expected: 'no error finding about the drawers; `drawers` good' },
    missing: { ok: !errors('missing').length, expected: 'no error finding: a drawer that is not there is not an error' },
    empty: { ok: !errors('empty').length, expected: 'no error finding: an empty drawer is not an error' },
    broken: {
      ok: level('broken', 'drawers') === 'error' && /errors\.jsonl:2/.test(text('broken', 'drawers')) && /not JSON/.test(text('broken', 'drawers')) && level('broken', 'integrity') === 'error',
      expected: '`drawers` error naming errors.jsonl:2 and "not JSON"; `integrity` error',
    },
    unreadable: {
      ok: level('unreadable', 'drawers') === 'error' && /errors\.jsonl/.test(text('unreadable', 'drawers')) && /unreadable/.test(text('unreadable', 'drawers'))
        && !/not JSON/.test(text('unreadable', 'drawers')) && errors('unreadable').length >= 2,
      expected: '`drawers` error naming errors.jsonl and "unreadable" (not "not JSON"); at least one more finding that is an error',
    },
  };
  const titles = {
    ok: 'E2 control: a readable drawer gives the doctor no error finding and `drawers` is good',
    missing: 'E2: a drawer that is missing is no error in `mem doctor`',
    empty: 'E2: an empty drawer is no error in `mem doctor`',
    broken: 'E2: a drawer with a line that is not JSON is an error in `mem doctor`, naming file and line',
    unreadable: 'E2: a drawer whose read FAILED is an error in `mem doctor` that says "unreadable", not the "not JSON" of a broken line and not silence',
  };
  const describe = (s) => (found[s].ok ? `${s}: errors [${errors(s).join(', ') || 'none'}]; drawers ${level(s, 'drawers') ?? 'absent'}: ${short(text(s, 'drawers'), 90)}` : `${s}: no answer (exit ${found[s].status})`);
  for (const [i, state] of STATES.entries()) {
    const id = ids[i];
    if (!found[state].ok) { notMeasured(atlas, { id, title: titles[state], expected: checks[state].expected, reason: `the child that runs the doctor gave no answer in the state ${state} (exit ${found[state].status}): ${found[state].stderr}` }); continue; }
    if (state !== 'ok' && !checks.ok.ok) { notMeasured(atlas, { id, title: titles[state], expected: checks[state].expected, reason: 'the positive control silent-errors.doctor.ok failed' }); continue; }
    emit(atlas, {
      id, title: titles[state], ok: checks[state].ok, expected: checks[state].expected, actual: describe(state),
      evidence: 'src/doctor.mjs checkAll (no concurrent-append probe) in a child process against a throwaway root, findings drawers / integrity / entry-form / index',
      measured: { state, errors: errors(state), drawers: level(state, 'drawers') }, severity: state === 'unreadable' || state === 'broken' ? SEVERITY.MAJOR : SEVERITY.MINOR,
    });
  }
}

// --- E3: the task block names a lane that really failed ----------------------------------------------------------

const TASK_MATCH = 'The spreadsheet writer loses formulas in the worksheet columns of the xlsx file';

export async function taskLaneReal(atlas, { tree = REPO } = {}) {
  const ids = ['silent-errors.task-lane.real-control', 'silent-errors.task-lane.real-unreadable'];
  const roots = {};
  for (const state of STATES) {
    const root = tempRoot(`atlas-silent-task-${state}-`);
    writeBridgeConfig(root);
    memory.logEntry(root, 'error', { id: 'tsk-error-1', class: 'wrong-cause', title: 'Spreadsheet writer loses formulas in the worksheet columns', text: 'formulas written as text into the xlsx columns', agent: 'probe' });
    const file = memory.logPath(root, 'error');
    if (state !== 'ok') setState(file, state, null);
    if (state === 'broken') fs.writeFileSync(file, `${NOT_JSON}${JSON.stringify({ id: 'tsk-error-1', ts: '2026-10-01T10:00:00Z', class: 'wrong-cause', title: 'Spreadsheet writer loses formulas in the worksheet columns', text: 'formulas written as text into the xlsx columns', agent: 'probe' })}\n`);
    roots[state] = root;
  }
  const asked = askTree(tree, roots.ok, `
    const m = await tree('src/subagenttask.mjs');
    const out = {};
    for (const [k, r] of Object.entries(JSON.parse(process.env.ROOTS))) {
      out[k] = await m.forTask(r, { prompt: process.env.TASK }, { env: { MEM_RETRIEVE_MIN: '0.1' } });
    }
    console.log(JSON.stringify(out));
  `, { ROOTS: JSON.stringify(roots), TASK: TASK_MATCH });
  const control = {
    id: ids[0], title: 'E3 control: the block of a subagent carries the matching error from a readable drawer and from one with a broken line, and no block at all when the drawer is missing or empty',
    expected: 'ok and broken: a block with the error id; missing and empty: null',
  };
  if (!asked.ok) {
    notMeasured(atlas, { ...control, reason: `the child that asks forTask gave no answer (exit ${asked.status}): ${asked.stderr}` });
    notMeasured(atlas, { id: ids[1], title: 'E3: a drawer that cannot be read is told in the block', expected: 'see the group', reason: 'the control silent-errors.task-lane.real-control could not run' });
    return;
  }
  const v = asked.value;
  const has = (s) => Array.isArray(v[s]?.ids) && v[s].ids.includes('tsk-error-1');
  const controlOk = emit(atlas, {
    ...control, ok: has('ok') && has('broken') && v.missing === null && v.empty === null,
    actual: STATES.filter((s) => s !== 'unreadable').map((s) => `${s}: ${v[s] === null ? 'null' : (has(s) ? 'block with the error' : 'block without the error')}`).join(', '),
    evidence: 'src/subagenttask.mjs forTask in a child process, one throwaway root per state, the error log in that state',
    measured: Object.fromEntries(STATES.filter((s) => s !== 'unreadable').map((s) => [s, v[s] === null ? null : { ids: v[s]?.ids ?? [] }])), severity: SEVERITY.MAJOR,
  });
  const item = {
    id: ids[1], title: 'E3: a drawer that cannot be read (a directory in its place) gives a block that says the lookup failed and names the lane; it is not the null of a lane that found nothing',
    expected: 'a block (not null) with no hit, `failed` naming the error lane, and the sentence "... failed - ... NOT searched / nothing was searched ... does not mean nothing known"',
  };
  if (!controlOk) { notMeasured(atlas, { ...item, reason: 'the positive control silent-errors.task-lane.real-control failed' }); return; }
  const u = v.unreadable;
  emit(atlas, {
    ...item,
    ok: u !== null && Array.isArray(u.ids) && u.ids.length === 0 && Array.isArray(u.failed) && u.failed.includes('error') && /failed/.test(u.text) && /does not mean "nothing known"/.test(u.text),
    actual: u === null ? 'null: the same answer as for a drawer with nothing in it' : `block of ${String(u.text).length} characters; failed lanes [${(u.failed ?? []).join(', ')}]; ${/does not mean "nothing known"/.test(u.text) ? 'says "nothing shown" is not "nothing known"' : 'does not say it'}`,
    evidence: 'the same call as the control; the lane fails for real (EISDIR from the file system), no injection; src/subagenttask.mjs failureNotice',
    measured: { block: u === null ? null : { ids: u.ids ?? [], failed: u.failed ?? [] } }, severity: SEVERITY.MAJOR,
  });
}

// --- all groups ----------------------------------------------------------------------------------------------------

export async function gapGroups(atlas, { tree = REPO } = {}) {
  const list = [
    [visibilityStates, ['silent-errors.visibility.states']],
    [visibilityBridge, ['silent-errors.visibility.bridge-control', 'silent-errors.visibility.bridge-unreadable']],
    [doctorStates, STATES.map((s) => `silent-errors.doctor.${s}`)],
    [taskLaneReal, ['silent-errors.task-lane.real-control', 'silent-errors.task-lane.real-unreadable']],
  ];
  for (const [fn, ids] of list) await guard(atlas, ids, () => fn(atlas, { tree }));
}

