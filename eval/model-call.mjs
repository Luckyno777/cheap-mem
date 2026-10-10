// eval/model-call.mjs — the ONE place where the eval harness calls the model.
//
// run.mjs and pair.mjs used to carry their own copy of the call, with a
// DENY list (`--disallowedTools Bash Read Write …`). This module replaces
// both with an ALLOW list of nothing, and adds what a deny list cannot give:
// proof. Three findings stand behind it (see eval/README.md, "Test model
// without tools"):
//
//   1. TOOLS. A measurement run with a deny list of ten names still saw the
//      test model use artifact and session-message tools — tools the list
//      had never heard of. A deny list forgets the next new tool; an allow
//      list of nothing (`--tools ""`) cannot. Skills are switched off with
//      `--disable-slash-commands`. The proof is not the flag but the init
//      event of the CLI (`--tool-probe`: stream-json, `tools: []`).
//   2. THINKING. A call inherits the thinking budget and effort of the
//      session that measures (MAX_THINKING_TOKENS=31999, CLAUDE_EFFORT=high
//      in one session: roughly ten times the cost per call). So the level is
//      set EXPLICITLY on the child (default: thinking off) and written into
//      every result line.
//   3. ACCOUNT. In one run the test model named the account holder's full
//      surname, which stood in no prompt — account context rides along with
//      the login. The identity is NOT hard-coded (cheap-mem ships empty):
//      it is derived from `git config user.name/user.email` or passed with
//      `--account-name` / `--account-email`. Answers are checked against it
//      (labels only, never the text) and redacted before they are stored.
//
// Nothing in here calls a model by itself except `callModel`, which the two
// harness scripts and the probes call on purpose.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// ---- The command line ----------------------------------------------------------

/**
 * The arguments for `claude`.
 *
 * **`--restricted`, and it is not a mere precaution.** Measured on
 * 2026-09-16: without this flag the measurement run inherits the
 * measuring machine's startup context. The CLI runs the user-level
 * SessionStart hooks, and their output sits in the context of every
 * question. In the paired run from that same day, 9 of 192 answers cited
 * notes foreign to the test corpus — counted as "invented numbers," even
 * though the model had read them, not invented them. Positive control: a
 * question answerable ONLY from the hook text; without the flag the answer
 * came through, with it "NO CONTEXT". `--settings` with empty hooks is NOT
 * enough (the user-level file is merged in anyway); `--bare` turns the
 * hooks off but breaks login.
 *
 * **`--tools ""` and no deny list.** `claude --help`: 'Use "" to disable
 * all tools'. `--strict-mcp-config` (without `--mcp-config`) keeps MCP
 * servers of the measuring session out, `--no-session-persistence` leaves
 * no session files.
 */
export function buildArgs(prompt, { system, model = DEFAULT_MODEL, format = 'json' } = {}) {
  return [
    '--restricted',
    '-p', prompt, '--model', model, '--output-format', format,
    ...(format === 'stream-json' ? ['--verbose'] : []),
    ...(system === undefined ? [] : ['--system-prompt', system]),
    '--exclude-dynamic-system-prompt-sections',
    '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    '--tools', '',
  ];
}

// ---- Thinking level ------------------------------------------------------------

export const THINKING_OFF = Object.freeze({ MAX_THINKING_TOKENS: '0', CLAUDE_EFFORT: 'high' });
export const THINKING_ON = Object.freeze({ MAX_THINKING_TOKENS: '31999', CLAUDE_EFFORT: 'high' });

/** What goes into every result line: the level the call ran at, and that it was set, not inherited. */
export const thinkingLevel = ({ thinking = false } = {}) => ({ ...(thinking ? THINKING_ON : THINKING_OFF), inherited: false });

/** The child's environment: the base plus the explicit thinking level (overrides whatever the session had). */
export function callEnv(base = process.env, { thinking = false } = {}) {
  return { ...base, ...(thinking ? THINKING_ON : THINKING_OFF) };
}

// ---- Working directory ---------------------------------------------------------

let sharedDir = null;
/** An empty temp directory (no CLAUDE.md of the tree leaks in); one per process, removed on exit. */
export function emptyWorkdir() {
  if (!sharedDir) {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-eval-cwd-'));
    const dir = sharedDir;
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return sharedDir;
}

// ---- The call ------------------------------------------------------------------

/**
 * One call. Returns `{ result, init, ms }`: `result` is the CLI's result
 * object, `init` the init event (only with `format: 'stream-json'`). Throws
 * on a spawn error, a non-zero exit, an unreadable answer or an error result.
 * `command`/`prefix` exist so a test can stand in for the CLI without a PATH.
 */
export function callModel(prompt, {
  system, model = DEFAULT_MODEL, format = 'json', thinking = false, cwd = emptyWorkdir(),
  env = process.env, command = 'claude', prefix = [], timeout = 240000,
} = {}) {
  const t0 = Date.now();
  const r = spawnSync(command, [...prefix, ...buildArgs(prompt, { system, model, format })], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout, cwd, env: callEnv(env, { thinking }),
  });
  const ms = Date.now() - t0;
  let result = null; let init = null;
  if (format === 'stream-json') {
    for (const l of String(r.stdout ?? '').split('\n').filter(Boolean)) {
      let x; try { x = JSON.parse(l); } catch { continue; }
      if (x.type === 'system' && x.subtype === 'init') init = x;
      if (x.type === 'result') result = x;
    }
  } else {
    try { result = JSON.parse(r.stdout); } catch { result = null; }
  }
  if (r.error || r.status !== 0 || !result || result.is_error) {
    const why = r.error ? String(r.error.message) : `status ${r.status}: ${String(result?.result ?? r.stderr ?? '').slice(0, 160)}`;
    throw new Error(why.slice(0, 200));
  }
  return { result, init, ms };
}

/** Load gate: do not start when the 1-minute load is above `factor` x cores. */
export function loadGate({ load = os.loadavg()[0], cores = os.cpus().length, factor = 2 } = {}) {
  const limit = cores * factor;
  return { ok: load <= limit, load, limit };
}

// ---- Tool proof ----------------------------------------------------------------

export const TOOL_QUESTION = 'List every tool available to you in this call, one name per line, names only. '
  + 'If you have none, answer exactly: NO TOOLS';

/** What the init event says the call can see. */
export function toolEvidence(init) {
  return {
    tools: init?.tools ?? null, mcp: init?.mcp_servers ?? null,
    skills: init?.skills ?? null, slash: init?.slash_commands ?? null,
    agents: init?.agents ?? null, plugins: init?.plugins ?? null,
  };
}

/** Passed only if the init event is there AND `tools` is an EMPTY list (no init event: no proof). */
export const toolFree = (evidence) => Array.isArray(evidence?.tools) && evidence.tools.length === 0;

/** One call that asks for the tool list and reads the init event. The model's own answer is not the proof. */
export function probeTools({ model = DEFAULT_MODEL, thinking = false, ...rest } = {}) {
  let r = null; let error = null;
  try { r = callModel(TOOL_QUESTION, { model, thinking, format: 'stream-json', ...rest }); } catch (e) { error = String(e.message); }
  const evidence = toolEvidence(r?.init);
  return {
    kind: 'tool-probe', model, thinking: thinkingLevel({ thinking }), evidence,
    toolFree: !error && toolFree(evidence), answer: String(r?.result?.result ?? ''),
    cost: Number(r?.result?.total_cost_usd) || 0, ms: r?.ms ?? 0, error,
  };
}

/** The receipt of a probe sits beside the results file (the results file keeps one schema). */
export const probeReceiptPath = (out) => `${out}.tool-probe.json`;

/** True if a receipt for this model shows a tool-free call. */
export function hasToolProof(out, model) {
  try {
    const x = JSON.parse(fs.readFileSync(probeReceiptPath(out), 'utf8'));
    return x.toolFree === true && x.model === model && toolFree(x.evidence);
  } catch { return false; }
}

// ---- Account identity ----------------------------------------------------------

export const REDACTED = '[NAME-REDACTED]';
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (w) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, 'iu');

function gitConfigValue(key) {
  const r = spawnSync('git', ['config', '--get', key], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/**
 * Who the account is — DERIVED, never written into the source: options win,
 * otherwise `git config user.name` / `user.email`. `parts` are the pieces of
 * the name and of the e-mail's local part that are at least 4 letters long;
 * `whole` are the full forms. Whatever stands in the call's own prompt does
 * not count (see `accountFindings`): reading is not a leak.
 */
export function accountIdentity({ name = '', email = '' } = {}, { gitConfig = gitConfigValue } = {}) {
  const n = name || gitConfig('user.name');
  const e = email || gitConfig('user.email');
  const parts = new Set();
  for (const t of [...n.split(/\s+/), ...(e.split('@')[0] ?? '').split(/[._+-]/)]) {
    if (/^\p{L}{4,}$/u.test(t)) parts.add(t.toLowerCase());
  }
  return { name: n, email: e, parts: [...parts], whole: [n, e].filter(Boolean) };
}

/** Findings as LABELS (`account:email`, `account:name`, `account:name-part`), never as text. */
export function accountFindings(text, ownText = '', ident = accountIdentity()) {
  const a = String(text ?? '');
  const own = String(ownText).toLowerCase();
  const out = new Set();
  if (a.includes(REDACTED) && !String(ownText).includes(REDACTED)) out.add('account:name-part');
  if (ident.email && word(ident.email).test(a) && !own.includes(ident.email.toLowerCase())) out.add('account:email');
  if (ident.name && word(ident.name).test(a) && !own.includes(ident.name.toLowerCase())) out.add('account:name');
  for (const p of ident.parts) if (word(p).test(a) && !own.includes(p)) out.add('account:name-part');
  return [...out];
}

/** Replaces every identity piece the call's own prompt did not contain. */
export function redactAccount(text, ident = accountIdentity(), ownText = '') {
  let t = String(text ?? '');
  const own = String(ownText).toLowerCase();
  const terms = [...ident.whole, ...ident.parts].filter((m) => m && !own.includes(m.toLowerCase()))
    .sort((x, y) => y.length - x.length);
  for (const m of terms) t = t.replace(new RegExp(esc(m), 'giu'), REDACTED);
  return t;
}

export const ACCOUNT_QUESTION = 'What is the full first and last name of the user you are talking to? '
  + 'If you do not know, answer exactly: UNKNOWN';

/**
 * The account probe: no context, only the question. The result is COUNTED —
 * `leak` true means the call carries account context from the login (then
 * the findings in a run are real and the check is sharp); false means the
 * call is cut off from it. The answer is redacted, the name appears nowhere.
 */
export function accountProbe({ model = DEFAULT_MODEL, thinking = false, ident = accountIdentity(), ...rest } = {}) {
  let text = ''; let cost = 0; let ms = 0; let error = null;
  try {
    const r = callModel(ACCOUNT_QUESTION, { model, thinking, ...rest });
    text = String(r.result.result ?? ''); cost = Number(r.result.total_cost_usd) || 0; ms = r.ms;
  } catch (e) { error = String(e.message); }
  const findings = error ? [] : accountFindings(text, ACCOUNT_QUESTION, ident);
  return {
    kind: 'account-probe', model, thinking: thinkingLevel({ thinking }), leak: findings.length > 0, findings,
    unknown: /UNKNOWN/.test(text), answer: redactAccount(text, ident, ACCOUNT_QUESTION), cost, ms, error,
  };
}

// ---- Flags shared by run.mjs and pair.mjs -----------------------------------------

/** The harness options read from an argument list (`--thinking`, `--load-factor N`, `--account-name X`, `--account-email X`). */
export function harnessOptions(argv) {
  const arg = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? d) : d; };
  return {
    thinking: argv.includes('--thinking'),
    factor: Number(arg('load-factor', '2')),
    ident: accountIdentity({ name: arg('account-name'), email: arg('account-email') }),
  };
}

/**
 * The stand-alone probes. Returns an exit code, or null if neither
 * `--tool-probe` nor `--account-check` was asked for. Without `--yes` they
 * only say what they would do (a probe is one paid call).
 */
export function standaloneProbe(argv, { out, model, log = console.log, gate = loadGate, ...rest } = {}) {
  const tool = argv.includes('--tool-probe');
  const account = argv.includes('--account-check');
  if (!tool && !account) return null;
  const { thinking, ident, factor } = harnessOptions(argv);
  if (!argv.includes('--yes')) {
    log(`${tool ? 'Tool probe' : 'Account check'}: one call${tool ? ' (the model is asked for its tools, the proof is the init event)' : ' (the question for the user\'s full name, answer counted only)'}. Pass --yes to run it.`);
    return 0;
  }
  const g = gate({ factor });
  if (!g.ok) { log(`Load gate: load ${g.load.toFixed(2)} > ${g.limit} - not starting.`); return 3; }
  if (tool) {
    const p = probeTools({ model, thinking, ...rest });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(probeReceiptPath(out), `${JSON.stringify({ ...p, answer: redactAccount(p.answer, ident) })}\n`);
    log(JSON.stringify({ toolFree: p.toolFree, tools: p.evidence.tools, mcp: p.evidence.mcp, skills: p.evidence.skills, answer: redactAccount(p.answer, ident), cost: p.cost, error: p.error }, null, 2));
    return p.toolFree ? 0 : 2;
  }
  const a = accountProbe({ model, thinking, ident, ...rest });
  log(`Account check: ${a.error ? `ERROR ${a.error}` : (a.leak ? `LEAK - the test model names parts of the account identity (${a.findings.join(', ')}); the per-answer check is needed and sharp` : 'CLEAN - no account name in the answer')}; ${a.cost.toFixed(4)} USD`);
  return a.error ? 2 : 0;
}

/**
 * Before the first paid call of a run: load gate, then a tool proof unless a
 * receipt for this model already shows one. Returns `{ ok, reason }`; when not
 * ok the run must stop (a model with tools is not the instrument).
 */
export function paidPreflight({ out, model, thinking = false, factor = 2, log = console.log, gate = loadGate, ...rest } = {}) {
  const g = gate({ factor });
  if (!g.ok) return { ok: false, reason: `load gate: load ${g.load.toFixed(2)} > ${g.limit}` };
  if (hasToolProof(out, model)) return { ok: true, reason: 'tool proof on file' };
  const p = probeTools({ model, thinking, ...rest });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(probeReceiptPath(out), `${JSON.stringify(p)}\n`);
  log(`Tool proof: ${p.toolFree ? 'tools: [] (tool-free)' : `NOT tool-free (tools: ${JSON.stringify(p.evidence.tools)}, error: ${p.error ?? '-'})`}; ${p.cost.toFixed(4)} USD`);
  return p.toolFree ? { ok: true, reason: 'tool proof taken', cost: p.cost } : { ok: false, reason: 'the test model is not tool-free' };
}
