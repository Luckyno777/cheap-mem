// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-cost.mjs — what one call costs, counted instead of timed.
//
// **The phase id.** `cost`, the same id the sister house (lucky-mem) uses; the
// state of the sister phase is recorded in test/atlas-phase-parity.json.
//
// **Where the question comes from.** The tempo findings of 2026-10-11 (plan
// item TB) named the places where a call is slow for a reason that is a COUNT:
// how many node processes a hook starts (TB5), how many command groups a CLI
// start imports (TB4), how often `retrieve` opens a log (TB6), whether the
// doctor starts the concurrent-append probe without being asked (TB7), how many
// file-system calls the doctor makes per entry (TB2), how often the journal is
// read for the day's card (TB8). Each of those was fixed or measured once, in
// its own change, with a stopwatch on a loaded box. This phase asks them all
// again, every run, by counting. TB1 (a route that rebuilds everything on each
// call) has its counterpart in the `dashboard` phase, where the server is
// running.
//
// **Counters, never time.** The counters are preloads (NODE_OPTIONS or
// `--import`, with the output file in the URL's query string, so no variable is
// added): bench/atlas/start-counter.mjs (node process starts),
// bench/atlas/module-counter.mjs (modules loaded, command groups among them),
// bench/atlas/call-counter.mjs (file-system calls, opens per log, worker
// threads) and bench/atlas/io-counter.mjs (bytes read). Each has a header that
// names what it cannot see.
//
// **The expectations are ratchets and bounds of the design, not wishes.** A
// start count is today's measured number (`HOOK_STARTS`, `CLI_MODULES`): it may
// fall and must not grow, and the number says nothing about whether it is good.
// The record prints the figure so a reader can disagree. A bound that a past
// fix made (the log is opened at most three times by `retrieve`: two passes of
// the state derivation and one read of the index) is a bound.
//
// **A red here is a finding, not a bug of the phase.** `cost.today-journal` is
// red when the phase was written: `mem today` reads the injection journal
// twice per call (the slope is 2.0 bytes read per journal byte). The phase
// measures; it does not fix src/.
//
// **Platform branch.** The hook rows need `bash`, and the ratchets hold where a
// time cap exists as a program (`timeout`, `gtimeout` or `perl`); without one
// the cap is a node watchdog and every capped call starts one more process. In
// either case the rows say `not-measured` with that reason. The PowerShell
// twins are not driven (named as a blind spot).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  VERDICT, SEVERITY, REPO, MEM, mem, tempRoot, buildCorpus,
} from './core.mjs';
import { readStarts } from './start-counter.mjs';
import { readModules, groupsOf } from './module-counter.mjs';
import { readRows, total } from './call-counter.mjs';
import * as memory from '../../src/memory.mjs';
import * as injection from '../../src/injection.mjs';
import { waitForRebuildIdle } from '../../src/component-table.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const spec = (file, query) => `${pathToFileURL(path.join(HERE, file)).href}?${Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

/**
 * Node processes one hook call starts (warm: the second call, the component table built; the labelled rebuild child not counted),
 * measured 2026-10-17 on Linux, Node 22.22. They may fall; raising one needs a reason in this comment. TB5 brought `before-edit` from 13 to 1.
 *   retrieve        two `node -e` snippets, the CLI call, the hook module
 *   after-failure   two runs of the hook module (parse, finish) and three snippets
 *   catch-fail      four `node -e` snippets
 *   stop            the answer check, the closing report, two snippets, the capture
 */
export const HOOK_STARTS = Object.freeze({
  'before-edit': 1, retrieve: 4, 'after-failure': 5, 'catch-fail': 4, 'subagent-start': 1, stop: 5,
});

/**
 * Modules a CLI start loads, measured 2026-10-17 (Node 22.22) as 103 (`version`), 62 (`--help`) and 94 (`find`) after the merge of kette/cm
 * (101/61/92 before it); the limits leave a headroom of 8, 9 and 8: one new module is not a regression, a whole command group (about 30) is.
 * TB4 took `mem version` from 158 modules to 93.
 */
export const CLI_MODULES = Object.freeze({ version: 111, help: 71, find: 102 });

/** `retrieve` opens each typed log at most this often on a warm index: two passes of the state derivation and the read in `loadIndex`. TB6 brought it down from four-plus. */
export const OPENS_PER_LOG = 3;
/** Stat-class calls (exists, stat, lstat, access, readdir, realpath) the doctor may add per entry that is added to the memory: a stat per mention would add one. */
export const DOCTOR_CALLS_PER_ENTRY = 0.05;
/** Bytes read of the injection journal per journal byte, per `mem today` call: once. */
export const JOURNAL_READS = 1;

/**
 * The detached rebuild of a stale component table (src/component-table.mjs) is a start of its own that no hook can avoid
 * when the table is stale; it carries this variable and is labelled, not counted (as test/before-edit-node-starts.test.mjs does).
 */
export const REBUILD_MARK = 'CM_REBUILD_LOCK';
/** The starts of a run without the labelled rebuild children. */
export const countedStarts = (rows) => (rows ?? []).filter((s) => !s.tagged);

const short = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const IDS = [
  'cli-start', 'hook.before-edit', 'hook.retrieve', 'hook.after-failure', 'hook.catch-fail', 'hook.subagent-start', 'hook.stop',
  'retrieve-opens', 'doctor-probe', 'doctor-fs', 'today-journal', 'today-probe',
];
const TITLES = {
  'cli-start': 'A CLI start is one node process and loads at most one command group (TB4)',
  'hook.before-edit': 'The before-edit hook is within its node-start ratchet (TB5)',
  'hook.retrieve': 'The prompt hook is within its node-start ratchet',
  'hook.after-failure': 'The after-failure hook is within its node-start ratchet',
  'hook.catch-fail': 'The swallowed-failure hook is within its node-start ratchet',
  'hook.subagent-start': 'The subagent-start hook is within its node-start ratchet',
  'hook.stop': 'The stop hook is within its node-start ratchet',
  'retrieve-opens': 'A warm `mem retrieve` opens each entry log at most three times (TB6)',
  'doctor-probe': 'The doctor starts the concurrent-append probe only with --full (TB7)',
  'doctor-fs': 'The doctor makes no more file-system calls for more entries (TB2)',
  'today-journal': 'A `mem today` call reads each byte of the injection journal at most once (TB8)',
  'today-probe': 'A `mem today` call starts no concurrent-append probe (TB7 holds for the doctor; the day card runs the doctor too)',
};

function rec(atlas, {
  id, ok, expected, actual, evidence, measured = null, severity = SEVERITY.MAJOR, verdict = null,
}) {
  return atlas.record({
    id: `cost.${id}`, title: TITLES[id], verdict: verdict ?? (ok ? VERDICT.PASS : VERDICT.FAIL), expected, actual: String(actual), evidence: String(evidence), measured, severity,
  });
}
function notMeasured(atlas, ids, why) {
  for (const id of ids) {
    atlas.record({
      id: `cost.${id}`, title: TITLES[id], verdict: VERDICT.NOT_MEASURED, expected: 'a count', actual: 'not asked', evidence: why,
    });
  }
}

/** Is there a time cap as a program? Without one, a capped call starts a node watchdog and the hook ratchets do not hold. */
export function capIsProgram() {
  return ['timeout', 'gtimeout', 'perl'].some((c) => spawnSync('bash', ['-c', `command -v ${c}`], { encoding: 'utf8' }).status === 0);
}
export function bashStarts() {
  const b = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' });
  return !b.error && b.status === 0;
}

const where = (rel, needle) => {
  try {
    const at = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').findIndex((l) => l.includes(needle));
    return at === -1 ? rel : `${rel}:${at + 1}`;
  } catch { return rel; }
};

/** One node call with a counter preload; returns the rows the counter wrote (`null` when it never ran). */
export function counted(kind, args, { root, env = {}, cwd, input = '' } = {}) {
  const dir = tempRoot('atlas-cost-c-');
  // No file is made beforehand: a counter that never ran leaves none, and `null` ("never ran") must not be told from `[]` ("ran, counted nothing").
  const out = path.join(dir, 'out.txt');
  const file = { starts: 'start-counter.mjs', modules: 'module-counter.mjs', calls: 'call-counter.mjs' }[kind];
  const query = kind === 'calls' ? { root, out } : kind === 'starts' ? { out, tag: REBUILD_MARK } : { out };
  // The start counter goes in through NODE_OPTIONS so that every node child counts; the others look at the one process.
  const viaEnv = kind === 'starts';
  const r = spawnSync(process.execPath, [...(viaEnv ? [] : [`--import=${spec(file, query)}`]), ...args], {
    encoding: 'utf8', timeout: 120000, input, cwd: cwd ?? root,
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...(viaEnv ? { NODE_OPTIONS: `--import=${spec(file, query)}` } : {}), ...env },
  });
  const rows = kind === 'starts' ? readStarts(out) : kind === 'modules' ? readModules(out) : readRows(out);
  return { r, rows };
}

// --- cli-start (TB4) ----------------------------------------------------------------------------------

function cliGroup(atlas, root) {
  const cases = [['version', ['version']], ['help', ['--help']], ['find', ['find', 'queue']]];
  const seen = {};
  for (const [key, args] of cases) {
    const starts = counted('starts', [MEM, '--root', root, ...args], { root });
    const mods = counted('modules', [MEM, '--root', root, ...args], { root });
    seen[key] = {
      starts: starts.rows === null ? null : countedStarts(starts.rows).length,
      modules: mods.rows === null ? null : mods.rows.length,
      groups: mods.rows === null ? null : groupsOf(mods.rows),
      status: mods.r.status,
    };
  }
  const v = seen.version; const h = seen.help; const f = seen.find;
  const alive = Object.values(seen).every((s) => s.starts !== null && s.modules !== null && s.modules > 0 && s.status === 0);
  const ok = alive
    && Object.values(seen).every((s) => s.starts === 1 && s.groups.length <= 1)
    && h.groups.length === 0 && f.groups.length === 1 && f.modules > h.modules
    && v.modules <= CLI_MODULES.version && h.modules <= CLI_MODULES.help && f.modules <= CLI_MODULES.find;
  rec(atlas, {
    id: 'cli-start', ok,
    expected: `1 node process each; at most one command group (none for --help, the group of the command for find: positive control, find loads more than --help); modules loaded: version <= ${CLI_MODULES.version}, --help <= ${CLI_MODULES.help}, find <= ${CLI_MODULES.find}`,
    actual: Object.entries(seen).map(([k, s]) => `${k}: ${s.starts} start(s), ${s.modules} modules, groups [${(s.groups ?? []).join(',')}]`).join('; '),
    evidence: `bench/atlas/start-counter.mjs and bench/atlas/module-counter.mjs on bin/mem; ${where('src/cli/command-index.mjs', 'GROUP_COMMANDS')} names the group of each command`,
    measured: { seen, limit: CLI_MODULES },
  });
}

// --- hooks (TB5 and the other four) ----------------------------------------------------------------------

const EDIT_FILE = 'src/lockrace.mjs';
function hookInputs(root, transcript) {
  return {
    'before-edit': { session_id: 'cost-1', hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: root, tool_input: { file_path: path.join(root, EDIT_FILE), old_string: 'a', new_string: 'b' } },
    retrieve: { session_id: 'cost-1', hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'what is known about the lockfile race and the sperrdatei-rennen probe?' },
    'after-failure': {
      session_id: 'cost-1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', cwd: root, tool_input: { command: 'npm test' }, error: 'Exit code 1\nnot ok 2 - lockfile race: two runs overwrote the lock file',
    },
    'catch-fail': {
      session_id: 'cost-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: 'npm test 2>&1 | tail -20' },
      tool_response: { stdout: 'ok 1 - reading works\nnot ok 2 - lockfile race: two runs overwrote the lock file\n# tests 2\n# pass 1\n# fail 1', stderr: '', interrupted: false, isImage: false },
    },
    'subagent-start': { session_id: 'cost-1', hook_event_name: 'SubagentStart', agent_type: 'general-purpose', cwd: root },
    stop: { session_id: 'cost-1', hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript, cwd: root },
  };
}
const HOOK_FILE = {
  'before-edit': 'mem-before-edit', retrieve: 'mem-retrieve', 'after-failure': 'mem-after-failure', 'catch-fail': 'mem-catch-fail', 'subagent-start': 'mem-subagent-start', stop: 'mem-stop',
};

function hookGroup(atlas, root) {
  const home = tempRoot('atlas-cost-home-');
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, `${Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: `line ${i}: building the lockfile race probe, recall hooks ${i * 7919}` } })).join('\n')}\n`);
  const input = hookInputs(root, transcript);
  const dir = tempRoot('atlas-cost-h-');
  const startsFile = path.join(dir, 'starts.txt');
  const env = {
    ...process.env,
    CHEAP_MEM_ROOT: root,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    LOCALAPPDATA: path.join(home, 'AppData'),
    MEM_STOP_NO_PUSH: '1',
    MEM_HOOK_OFF: '',
    MEM_BEFORE_EDIT_OFF: '',
    NODE_OPTIONS: `--import=${spec('start-counter.mjs', { out: startsFile, tag: REBUILD_MARK })}`,
  };
  const call = (name) => {
    fs.writeFileSync(startsFile, '');
    const r = spawnSync('bash', [path.join(REPO, 'bin', HOOK_FILE[name])], {
      input: JSON.stringify(input[name]), encoding: 'utf8', timeout: 90000, cwd: root, env: { ...env, MEM_BEFORE_EDIT_MARKS: path.join(root, '.mem', `be-${name}-${Math.random().toString(36).slice(2)}`) },
    });
    return { r, rows: readStarts(startsFile) };
  };
  for (const name of Object.keys(HOOK_STARTS)) {
    const id = `hook.${name}`;
    call(name); // warm: the first call builds the component table and the compile cache
    waitForRebuildIdle(root);
    const second = call(name);
    const own = countedStarts(second.rows);
    const n = second.rows === null ? null : own.length;
    const rebuilds = (second.rows ?? []).length - own.length;
    const kinds = {};
    for (const s of own) kinds[s.script || '(node -e)'] = (kinds[s.script || '(node -e)'] ?? 0) + 1;
    rec(atlas, {
      id, ok: n !== null && n >= 1 && n <= HOOK_STARTS[name] && second.r.status === 0,
      expected: `exit 0 and 1 to ${HOOK_STARTS[name]} node processes (today's number; at least 1: the counter sees the hook run)`,
      actual: `exit ${second.r.status}, ${n} node process(es): ${Object.entries(kinds).map(([k, c]) => `${k} x${c}`).join(', ')}`,
      evidence: `bin/${HOOK_FILE[name]} through bash, a hit in the memory, the second call (the first builds the component table and the compile cache); bench/atlas/start-counter.mjs through NODE_OPTIONS`,
      measured: { starts: n, limit: HOOK_STARTS[name], by: kinds, status: second.r.status, rebuildsLabelled: rebuilds },
    });
  }
}

// --- retrieve, doctor, today -----------------------------------------------------------------------------------

function worldWith(entries) {
  const root = tempRoot('atlas-cost-w-');
  const init = mem(['init'], { root });
  if (init.status !== 0) throw new Error(`mem init failed: ${short(init.stderr)}`);
  buildCorpus(root, entries);
  return root;
}

function retrieveGroup(atlas) {
  const root = worldWith(300);
  const args = [MEM, '--root', root, 'retrieve', 'queue latency'];
  counted('calls', args, { root }); // builds the index cache
  const { r, rows } = counted('calls', args, { root });
  const t = total(rows);
  const files = Object.entries(t.opens);
  const worst = files.reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
  rec(atlas, {
    id: 'retrieve-opens', ok: rows !== null && r.status === 0 && files.length >= 3 && worst[1] >= 1 && worst[1] <= OPENS_PER_LOG,
    expected: `exit 0; at least 3 entry logs opened (positive control: the counter sees the opens); no log opened more than ${OPENS_PER_LOG} times`,
    actual: `exit ${r.status}; ${files.length} logs opened, the most-opened ${worst[0] || '(none)'} ${worst[1]} time(s); ${files.reduce((n, [, k]) => n + k, 0)} opens in all`,
    evidence: `bench/atlas/call-counter.mjs on a warm \`mem retrieve\` over 300 entries; the opens are ${where('src/memory.mjs', 'iterLogFile')} (state derivation, two passes) and ${where('src/search.mjs', 'loadIndex')} (the index)`,
    measured: { logs: files.length, mostOpened: worst[1], opens: t.opens, limit: OPENS_PER_LOG },
  });
}

/** Calls of the stat class and the number of worker threads of one `mem doctor` on `root` (the second call, so a cold cache does not count). */
function doctorOnce(root, extra = []) {
  const args = [MEM, '--root', root, 'doctor', '--quiet', ...extra];
  counted('calls', args, { root });
  const { r, rows } = counted('calls', args, { root });
  const t = total(rows);
  const statClass = ['existsSync', 'statSync', 'lstatSync', 'accessSync', 'readdirSync', 'realpathSync'].reduce((n, k) => n + t.calls[k], 0);
  return { status: r.status, rows, statClass, workers: t.workers };
}

function doctorGroup(atlas) {
  const small = worldWith(100);
  const big = worldWith(400);
  const a = doctorOnce(small);
  const b = doctorOnce(big);
  const full = doctorOnce(small, ['--full']);
  rec(atlas, {
    id: 'doctor-probe', ok: a.rows !== null && full.rows !== null && a.workers === 0 && full.workers >= 2,
    expected: 'no worker thread without --full, at least 2 with --full (the writers of the concurrent-append probe; positive control: the counter sees them)',
    actual: `default: ${a.workers} worker(s), --full: ${full.workers} worker(s)`,
    evidence: `bench/atlas/call-counter.mjs wraps new Worker; ${where('src/environment.mjs', 'new Worker(APPEND_PROBE_WORKER_SRC')} is the probe`,
    measured: { default: a.workers, full: full.workers },
  });
  const perEntry = (b.statClass - a.statClass) / 300;
  // A bigger memory made of more FILES shows the counter does move when the work moves.
  const wide = worldWith(100);
  for (let i = 0; i < 30; i += 1) {
    fs.mkdirSync(path.join(wide, 'projects', `wide${i}`), { recursive: true });
    memory.logEntry(wide, 'learning', { title: `wide ${i}`, text: 'x' }, { project: `wide${i}` });
  }
  const w = doctorOnce(wide);
  rec(atlas, {
    id: 'doctor-fs', ok: a.rows !== null && b.rows !== null && w.rows !== null && a.statClass > 0 && perEntry <= DOCTOR_CALLS_PER_ENTRY && w.statClass > a.statClass,
    expected: `stat-class calls per added entry <= ${DOCTOR_CALLS_PER_ENTRY} (100 -> 400 entries); positive control: 30 more project folders raise the count`,
    actual: `100 entries: ${a.statClass} calls, 400 entries: ${b.statClass} calls (${perEntry.toFixed(3)} per added entry); 30 more projects: ${w.statClass} calls (${((w.statClass - a.statClass) / 30).toFixed(0)} per project folder, not judged)`,
    evidence: 'bench/atlas/call-counter.mjs on the second `mem doctor --quiet` of each world (exists, stat, lstat, access, readdir, realpath); the module loader\'s own reads are not counted',
    measured: {
      small: a.statClass, big: b.statClass, perEntry: +perEntry.toFixed(4), wide: w.statClass, perProject: +((w.statClass - a.statClass) / 30).toFixed(1), limit: DOCTOR_CALLS_PER_ENTRY,
    },
  });
}

function journalWorld(lines) {
  const root = worldWith(50);
  const file = path.join(root, injection.JOURNAL_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.parse('2026-10-17T12:00:00Z');
  let text = '';
  for (let i = 0; i < lines; i += 1) {
    text += `${JSON.stringify(injection.buildLine({
      ts: new Date(now - i * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'), session: `s${i % 7}`, occasion: 'question', bytes: 900, hits: 3, searched: 300, sources: [`global/decisions.jsonl:${i}`],
    }))}\n`;
  }
  fs.writeFileSync(file, text);
  return { root, bytes: fs.statSync(file).size };
}

/** Bytes of the injection journal one `mem today` call reads: the counter WATCHES that one file (the rest of what the call reads comes and goes). */
function bytesRead(root) {
  const dir = tempRoot('atlas-cost-io-');
  const out = path.join(dir, 'io.txt');
  fs.writeFileSync(out, '');
  const watch = injection.JOURNAL_FILE.split(path.sep).join('/');
  const r = spawnSync(process.execPath, [`--import=${spec('io-counter.mjs', { root, out, watch })}`, MEM, '--root', root, 'today'], { encoding: 'utf8', timeout: 120000, cwd: root, env: { ...process.env, CHEAP_MEM_ROOT: root } });
  const rows = readRows(out);
  return { status: r.status, bytes: rows && rows.length ? rows.reduce((n, x) => n + (x.watchedBytesRead ?? 0), 0) : null };
}

function todayGroup(atlas, quick) {
  const lo = journalWorld(quick ? 200 : 400);
  const hi = journalWorld(quick ? 2000 : 4000);
  bytesRead(lo.root); // the first call may write derived state
  const a = bytesRead(lo.root);
  const b = bytesRead(hi.root);
  const ok0 = a.bytes !== null && b.bytes !== null && a.status === 0 && b.status === 0;
  const slope = ok0 ? (b.bytes - a.bytes) / (hi.bytes - lo.bytes) : null;
  rec(atlas, {
    id: 'today-journal', ok: ok0 && slope >= 0.9 && slope <= JOURNAL_READS + 0.05, severity: SEVERITY.MINOR,
    expected: `bytes read per journal byte, from the difference of two journals, between 0.9 (positive control: the journal is read at all) and ${JOURNAL_READS}`,
    actual: ok0 ? `${slope.toFixed(2)} bytes read per journal byte (journal ${lo.bytes} -> ${hi.bytes} bytes; read ${a.bytes} -> ${b.bytes} bytes)` : 'the counter wrote nothing or `mem today` failed',
    evidence: `bench/atlas/io-counter.mjs (watchedBytesRead: the counter watches the journal file) on \`mem today\`; the card reads the journal once itself (${where('src/today.mjs', 'injection.read(root)')}) and once more through the doctor it runs (${where('src/doctor.mjs', 'j = injection.read(root)')}), two whole reads of the same file (traced 2026-10-17). Two journals of different size, the same memory otherwise, so the constant part cancels`,
    measured: { journalLo: lo.bytes, journalHi: hi.bytes, readLo: a.bytes, readHi: b.bytes, slope: slope === null ? null : +slope.toFixed(3), limit: JOURNAL_READS },
  });
}

/**
 * The verdict of `cost.today-probe` from one counted call. A counter that never ran (`rows` null) or ran and saw no file-system call at all
 * is not "0 workers": it is a broken counter, and says so.
 * @returns {{ ok: boolean, workers: number, why: string|null }}
 */
export function todayProbeVerdict({ rows, status }) {
  if (rows === null || rows === undefined) return { ok: false, workers: 0, why: 'counter did not run (no counter file)' };
  const t = total(rows);
  const alive = t.rows >= 1 && Object.values(t.calls).reduce((a, b) => a + b, 0) > 0;
  if (!alive) return { ok: false, workers: t.workers, why: 'counter did not run (no row, or no file-system call seen)' };
  if (status !== 0) return { ok: false, workers: t.workers, why: `\`mem today\` exited ${status}` };
  return { ok: t.workers === 0, workers: t.workers, why: null };
}

/** The day card runs the doctor; the doctor's append probe (six writer threads) was limited to `--full` by TB7. Does the card respect that? */
function todayProbe(atlas) {
  const root = worldWith(50);
  const args = [MEM, '--root', root, 'today'];
  counted('calls', args, { root }); // the first call may write derived state
  const { r, rows } = counted('calls', args, { root });
  const v = todayProbeVerdict({ rows, status: r.status });
  rec(atlas, {
    id: 'today-probe', ok: v.ok, severity: SEVERITY.MINOR,
    expected: 'the counter ran (at least one row, file-system calls seen), exit 0 and 0 worker threads (the probe only with --full, as for `mem doctor`; control: doctor-probe sees the six writers with --full)',
    actual: v.why ?? `exit ${r.status}, ${v.workers} worker thread(s)`,
    evidence: `bench/atlas/call-counter.mjs wraps new Worker on a warm \`mem today\`; the card calls ${where('src/today.mjs', 'check = doctorMod.checkAll')}, and ${where('src/doctor.mjs', 'export function checkAll')} measures by default (\`full = true\`); it also writes a probe folder under the memory root on every call`,
    measured: { workers: v.workers, status: r.status, counterRan: v.why === null || !/counter did not run/.test(v.why) },
  });
}

export async function run(atlas, opt = {}) {
  atlas.phase('cost', 'What one call costs: node starts per hook, modules per CLI start, opens per log, probe threads, stat calls, journal bytes (counters, no clock)',
    'Each row runs the real code in a scratch memory with a counter preload (start, module, call and io counters) and compares the count with a ratchet or a bound; no duration is measured.');
  const quick = opt.quick === true;
  const hooksOk = bashStarts() && capIsProgram();
  let root;
  try { root = worldWith(300); } catch (e) { notMeasured(atlas, IDS, `the scratch memory could not be made: ${short(e?.message)}`); atlas.blind('cost: the whole phase', 'no scratch memory'); return; }
  // the entries the hooks find: a hit for the prompt, the failure, the file
  mem(['log', 'error', '--title', 'lockfile race - two runs overwrote it', '--text', `the sperrdatei-rennen probe failed because two test runs overwrote the same lock file; seen in ${EDIT_FILE}`, '--class', 'race'], { root });
  mem(['log', 'decision', '--topic', 'lockfile race handling', '--choice', 'serialize the two test runs on one lock file', '--why', 'two runs overwrote the same lock file'], { root });

  cliGroup(atlas, root);
  if (hooksOk) hookGroup(atlas, root);
  else {
    notMeasured(atlas, IDS.filter((i) => i.startsWith('hook.')), bashStarts()
      ? 'no timeout, gtimeout or perl: a capped call starts a node watchdog, so the node-start ratchets (measured with a program as the cap) do not hold'
      : 'no bash starts here; the hooks are bash scripts (their PowerShell twins are not driven)');
  }
  retrieveGroup(atlas);
  doctorGroup(atlas);
  todayGroup(atlas, quick);
  todayProbe(atlas);

  atlas.blind('cost: the PowerShell twins', 'the PowerShell twins of the hooks (the .ps1 files in bin/) are not driven; their node starts are held by test/before-edit-twin.test.mjs for the before-edit hook only. The ratchets here are the bash hooks.');
  atlas.blind('cost: the ratchets are today\'s numbers', 'a start count that is far above what the work needs (the after-failure, prompt and stop hooks start four or five processes) passes while it does not grow; the phase says what is, not what could be.');
  atlas.blind('cost: what a process costs', 'a count of processes and modules is not a duration: one node start is not one unit of time, and the compile cache (NODE_COMPILE_CACHE, src/ hook shells) changes the price of a module without changing the count.');
  atlas.blind('cost: size', 'the memories hold 50 to 400 entries and journals of a few thousand lines; the counters do not depend on the size by design, a cost that only appears at 100,000 entries is the skala phase\'s question.');
  atlas.blind('cost: the doctor\'s own reads', 'doctor-fs counts stat-class calls only; the bytes the doctor reads are not asked, and neither is `mem doctor --full` beyond its worker threads.');
  atlas.blind('cost: TB3, TB6 and TB9 of the plan', 'the index cache load of a cold find (TB3, sister house), the retire derivation count (TB6, only the opens per log) and the word-normalisation memo (TB9, measured and not built) have no row of their own.');
}
