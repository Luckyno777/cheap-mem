/**
 * integrationcontract — the integration contract as DATA, in exactly
 * this place (X2).
 *
 * The outside criticism of 2026-09-29: that a tool is AVAILABLE
 * guarantees neither that it is searched in time, nor that anything is
 * logged, nor that duties are honoured. The memory has hooks and an MCP
 * bridge, but nowhere was written down, per occasion and per client,
 * what is guaranteed and what only exists. This module is that
 * statement, and `docs/integration-contract.md` carries a generated
 * copy of it (between markers) that a test keeps equal.
 *
 * ## Five occasions
 *
 * session-start   the session begins (the standing core, recent context)
 * task-start      a task begins / a relevant message arrives
 * before-change   before an important change (a file is about to be edited)
 * after-error     after a failure, before the second attempt
 * task-end        the task is finished
 *
 * ## Three clients
 *
 * claude-code     hooks registered by `install/claude-code.sh`
 * mcp             MCP clients (a chat bridge, an IDE): tools, no hooks
 * cli             plain command line: commands, no trigger at all
 *
 * ## Three states per cell
 *
 * full     an AUTOMATIC trigger exists (a registered hook), its file
 *          exists, and it does what the occasion asks for.
 * partial  an entry exists (a hook that covers only part of the
 *          occasion, or a tool/command someone must remember to call).
 *          A missing hook is written down HERE as partial support, not
 *          left out.
 * missing  nothing exists.
 *
 * ## One truth
 *
 * A cell does not just claim a state, it names its evidence (a file, a
 * registration in the installer, a tool name in a source file).
 * {@link evaluate} checks every piece of evidence against the tree. A
 * cell declared `full` whose evidence is gone is `broken`, and the
 * doctor reports that as an error. Registrations are DERIVED from the
 * installer text ({@link registrations}), not restated here.
 *
 * ## Three measures per occasion
 *
 * delivered   the hook put text into the context (journal line with
 *             reason null)
 * retrieved   a search actually ran (any journal line, including the
 *             ones that found nothing, with their reason) — so "never
 *             searched" is told apart from "searched, nothing found"
 * considered  afterwards an entry was named, opened or edited within
 *             the window (src/effect.mjs) — approximate, and only past
 *             its floor of pairs
 * {@link MEASURE} says, per occasion, which of the three is measured
 * today. "Not measured" is written as such, never as zero.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const OCCASION = Object.freeze({
  SESSION_START: 'session-start',
  TASK_START: 'task-start',
  BEFORE_CHANGE: 'before-change',
  AFTER_ERROR: 'after-error',
  TASK_END: 'task-end',
});
export const OCCASIONS = Object.freeze(Object.values(OCCASION));

export const CLIENT = Object.freeze({ CLAUDE_CODE: 'claude-code', MCP: 'mcp', CLI: 'cli' });
export const CLIENTS = Object.freeze(Object.values(CLIENT));

export const STATUS = Object.freeze({ FULL: 'full', PARTIAL: 'partial', MISSING: 'missing' });

/** The installer whose registrations are the ground truth for hooks. */
export const INSTALLER = 'install/claude-code.sh';

/** The measure states. Closed list. */
export const MEASURED = Object.freeze({
  YES: 'measured',
  APPROX: 'approximate',
  PARTLY: 'partly measured',
  NO: 'not measured',
});

// --- evidence builders --------------------------------------------------

const file = (p) => ({ file: p });
const registered = (event, hook, matcher = null) => ({ register: { event, hook, matcher } });
const contains = (f, text) => ({ file: f, has: text });

const MCP = 'bin/mem-mcp';
const CLI_SEARCH = 'src/cli/commands/search.mjs';
const CLI_WRITE = 'src/cli/commands/write.mjs';
const CLI_SETUP = 'src/cli/commands/setup.mjs';

/**
 * The matrix. `entries` is the evidence, `note` the one sentence that
 * says what is covered and what is not.
 */
export const MATRIX = Object.freeze({
  [CLIENT.CLAUDE_CODE]: {
    [OCCASION.SESSION_START]: {
      status: STATUS.FULL,
      entries: [
        registered('SessionStart', 'cheap-mem-session-start.sh'),
        file('install/hooks/session-start.sh'),
        registered('SubagentStart', 'cheap-mem-subagent-start.sh'),
        file('install/hooks/subagent-start.sh'),
        file('bin/mem-subagent-start'),
      ],
      note: 'Core facts and recent context at every start; a subagent gets its own block.',
    },
    [OCCASION.TASK_START]: {
      status: STATUS.FULL,
      entries: [
        registered('UserPromptSubmit', 'cheap-mem-user-prompt.sh'),
        file('install/hooks/user-prompt.sh'),
        file('bin/mem-retrieve'),
      ],
      note: 'Every message is searched; the top hits above the score bar are injected.',
    },
    [OCCASION.BEFORE_CHANGE]: {
      status: STATUS.FULL,
      entries: [
        registered('PreToolUse', 'cheap-mem-pre-edit.sh', 'Edit|Write|NotebookEdit'),
        file('install/hooks/pre-edit.sh'),
        file('bin/mem-before-edit'),
      ],
      note: 'Literal path lookup before Edit, Write and NotebookEdit; once per file per session. Reading a file or a shell command does not trigger it.',
    },
    [OCCASION.AFTER_ERROR]: {
      status: STATUS.PARTIAL,
      entries: [
        registered('PostToolUse', 'cheap-mem-catch-fail.sh', 'Bash'),
        file('bin/mem-catch-fail'),
      ],
      note: 'Only failures the exit code hid (exit 0, failure in the output). There is NO hook on PostToolUseFailure: a command that really exits nonzero gets no recall. The error-log hint (src/errorcontext.mjs) fires on writing an error, not on having one.',
    },
    [OCCASION.TASK_END]: {
      status: STATUS.PARTIAL,
      entries: [
        registered('Stop', 'cheap-mem-session-stop.sh'),
        file('install/hooks/session-stop.sh'),
        file('bin/mem-stop'),
        file('src/answercheck.mjs'),
      ],
      note: 'Captures and persists the session and checks the last answer against logged error patterns. Nothing checks open duties or asks for a log entry at the end.',
    },
  },
  [CLIENT.MCP]: {
    [OCCASION.SESSION_START]: {
      status: STATUS.PARTIAL,
      entries: [contains(MCP, "name: 'mem_context'")],
      note: 'Tool exists; nothing makes the client call it at the start (docs/system-prompt.txt only asks).',
    },
    [OCCASION.TASK_START]: {
      status: STATUS.PARTIAL,
      entries: [contains(MCP, "name: 'mem_retrieve'"), contains(MCP, "name: 'mem_find'")],
      note: 'Tools exist; the client decides whether and when to search.',
    },
    [OCCASION.BEFORE_CHANGE]: {
      status: STATUS.PARTIAL,
      entries: [contains(MCP, "name: 'mem_component'")],
      note: 'Component lookup by path exists; no trigger before an edit.',
    },
    [OCCASION.AFTER_ERROR]: {
      status: STATUS.PARTIAL,
      entries: [contains(MCP, "name: 'mem_find'"), contains(MCP, "name: 'mem_log'")],
      note: 'Search and error logging exist; no trigger after a failure.',
    },
    [OCCASION.TASK_END]: {
      status: STATUS.PARTIAL,
      entries: [contains(MCP, "name: 'mem_log'"), contains(MCP, "name: 'mem_duties'")],
      note: 'Logging and the duty list exist; nothing asks for either at the end.',
    },
  },
  [CLIENT.CLI]: {
    [OCCASION.SESSION_START]: {
      status: STATUS.PARTIAL,
      entries: [contains(CLI_SEARCH, '  context: async')],
      note: '`mem context`, run by hand.',
    },
    [OCCASION.TASK_START]: {
      status: STATUS.PARTIAL,
      entries: [contains(CLI_SEARCH, '  find: async')],
      note: '`mem find`, run by hand.',
    },
    [OCCASION.BEFORE_CHANGE]: {
      status: STATUS.PARTIAL,
      entries: [contains(CLI_SETUP, '  component: async')],
      note: '`mem component <path>`, run by hand.',
    },
    [OCCASION.AFTER_ERROR]: {
      status: STATUS.PARTIAL,
      entries: [contains(CLI_SEARCH, '  find: async'), contains(CLI_WRITE, '  log: async')],
      note: '`mem find` and `mem log error`, run by hand.',
    },
    [OCCASION.TASK_END]: {
      status: STATUS.PARTIAL,
      entries: [contains(CLI_WRITE, '  duties: async'), contains(CLI_WRITE, '  log: async')],
      note: '`mem duties` and `mem log`, run by hand.',
    },
  },
});

/**
 * What is measured today, per occasion, for the hook path (the only
 * path that books a journal line). Delivered / retrieved / considered.
 * `where` names the reader.
 */
export const MEASURE = Object.freeze({
  [OCCASION.SESSION_START]: {
    delivered: MEASURED.NO, retrieved: MEASURED.NO, considered: MEASURED.NO,
    where: 'the start hook prints straight to the context; it books no journal line',
  },
  [OCCASION.TASK_START]: {
    delivered: MEASURED.YES, retrieved: MEASURED.YES, considered: MEASURED.APPROX,
    where: 'src/injection.mjs (occasion question, reason null = delivered, any reason = retrieved); src/effect.mjs (30-minute window, floor of pairs)',
  },
  [OCCASION.BEFORE_CHANGE]: {
    delivered: MEASURED.NO, retrieved: MEASURED.NO, considered: MEASURED.NO,
    where: 'the journal vocabulary has occasion before-edit (and a latency budget), but no writer books it',
  },
  [OCCASION.AFTER_ERROR]: {
    delivered: MEASURED.NO, retrieved: MEASURED.NO, considered: MEASURED.NO,
    where: 'the catch-fail hook books no journal line',
  },
  [OCCASION.TASK_END]: {
    delivered: MEASURED.NO, retrieved: MEASURED.NO, considered: MEASURED.NO,
    where: 'the stop hook writes the raw capture (that is the record), not a delivery line',
  },
});

/** What each occasion puts in, and its budget. Documentation data. */
export const BUDGET = Object.freeze({
  [OCCASION.SESSION_START]: {
    delivers: 'FACTS.md, `mem context --n 10`, the working-style block; for a subagent the tagged procedures plus a recap',
    budget: '10 context entries; a subagent block gets the remainder of its byte budget',
  },
  [OCCASION.TASK_START]: {
    delivers: 'up to 3 hits above the score bar for the message',
    budget: 'MEM_RETRIEVE_TOP=3, MEM_RETRIEVE_MIN=5.0; 4000 ms latency budget (src/latencybudget.mjs)',
  },
  [OCCASION.BEFORE_CHANGE]: {
    delivers: 'up to 3 entries that name the file about to be changed',
    budget: 'MEM_BEFORE_EDIT_TOP=3, once per file per session; 1000 ms latency budget',
  },
  [OCCASION.AFTER_ERROR]: {
    delivers: 'up to 3 entries matching the failure signature',
    budget: 'MEM_CATCH_FAIL_TOP=3, MEM_CATCH_FAIL_MIN=2.0, once per session per signature; capped at 5 s',
  },
  [OCCASION.TASK_END]: {
    delivers: 'nothing is retrieved; the answer check may block once, the capture is written and pushed',
    budget: 'capture about 50 ms; push best-effort',
  },
});

// --- deriving the registrations -----------------------------------------

function readText(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

/**
 * Every hook the installer registers, derived from its own text:
 * `[{ event, hook, matcher }]`. `hook` is the installed file name.
 * `null` if the installer cannot be read — not an empty list.
 */
export function registrations(codeRoot = CODE_ROOT) {
  const text = readText(codeRoot, INSTALLER);
  if (text === null) return null;
  const out = [];
  for (const m of text.matchAll(/^upsertHook\('(\w+)', '([\w-]+)'(?:, '([^']*)')?\);/gm)) {
    out.push({ event: m[1], hook: `cheap-mem-${m[2]}.sh`, matcher: m[3] ?? null });
  }
  return out;
}

// --- checking the evidence ----------------------------------------------

function describe(e) {
  if (e.register) {
    const r = e.register;
    return `installer registers ${r.event}${r.matcher ? `[${r.matcher}]` : ''} -> ${r.hook}`;
  }
  if (e.has) return `${e.file} (contains ${e.has.trim()})`;
  return e.file;
}

function resolveEntry(e, codeRoot, regs) {
  if (e.register) {
    const r = e.register;
    const ok = Array.isArray(regs)
      && regs.some((x) => x.event === r.event && x.hook === r.hook && (r.matcher === null || x.matcher === r.matcher));
    return { ok, what: describe(e) };
  }
  const text = readText(codeRoot, e.file);
  if (text === null) return { ok: false, what: describe(e) };
  if (e.has) return { ok: text.includes(e.has), what: describe(e) };
  return { ok: true, what: describe(e) };
}

/**
 * Check every cell against the tree.
 * `{ cells: { client: { occasion: { status, ok, missing[], entries[], note } } } }`
 * A cell is `ok` when ALL its evidence exists.
 */
export function evaluate(codeRoot = CODE_ROOT, matrix = MATRIX) {
  const regs = registrations(codeRoot);
  const cells = {};
  for (const client of Object.keys(matrix)) {
    cells[client] = {};
    for (const occasion of Object.keys(matrix[client])) {
      const c = matrix[client][occasion];
      const checked = c.entries.map((e) => resolveEntry(e, codeRoot, regs));
      cells[client][occasion] = {
        status: c.status,
        ok: checked.every((x) => x.ok),
        missing: checked.filter((x) => !x.ok).map((x) => x.what),
        entries: checked.map((x) => x.what),
        note: c.note,
      };
    }
  }
  return { cells };
}

/** Cells declared full whose evidence is gone. `[{ client, occasion, missing }]` */
export function brokenCells(ev) {
  const out = [];
  for (const client of Object.keys(ev.cells)) {
    for (const occasion of Object.keys(ev.cells[client])) {
      const c = ev.cells[client][occasion];
      if (c.status === STATUS.FULL && !c.ok) out.push({ client, occasion, missing: c.missing });
    }
  }
  return out;
}

// --- which client is installed ------------------------------------------

/**
 * Which clients can be told apart on this machine. Only Claude Code
 * leaves a trace (hooks in a settings file); an MCP client or a shell
 * leaves none this module can read. `settingsPaths` are read, never
 * written. Returns `{ clients: string[], readable: number }`.
 */
export function detectClients({ settingsPaths = [], matrix = MATRIX } = {}) {
  const hookNames = new Set();
  for (const occ of Object.values(matrix[CLIENT.CLAUDE_CODE] ?? {})) {
    for (const e of occ.entries) if (e.register) hookNames.add(e.register.hook);
  }
  let readable = 0;
  let commands = '';
  for (const p of settingsPaths) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      readable += 1;
      commands += `\n${JSON.stringify(cfg?.hooks ?? {})}`;
    } catch { /* not there, or not JSON: not evidence of anything */ }
  }
  const found = [...hookNames].some((h) => commands.includes(h));
  return { clients: found ? [CLIENT.CLAUDE_CODE] : [], readable, commands };
}

/**
 * The doctor's verdict. Four states, `level` in
 * `good | warn | error | unknown`:
 *
 *   error    a cell declared full has no existing hook file / entry
 *   unknown  cannot tell which client is installed
 *   warn     the active client has a cell that is not full, or a full
 *            hook that is not registered on this machine
 *   good     every occasion of the active client is full
 */
export function judge({ codeRoot = CODE_ROOT, settingsPaths = [], matrix = MATRIX } = {}) {
  const ev = evaluate(codeRoot, matrix);
  const broken = brokenCells(ev);
  if (broken.length) {
    return {
      level: 'error',
      text: `${broken.length} cell(s) declared full without their hook file or entry: `
        + broken.map((b) => `${b.client}/${b.occasion} (${b.missing.join('; ')})`).join('; '),
      advice: 'Restore the file, or change the cell in src/integrationcontract.mjs to partial and say why. '
        + 'The contract must not claim more than the tree holds.',
    };
  }
  const det = detectClients({ settingsPaths, matrix });
  if (!det.clients.length) {
    return {
      level: 'unknown',
      text: `cannot tell which client is installed (${det.readable} settings file(s) readable, none registers this tool's hooks)`,
      advice: 'Run install/claude-code.sh for Claude Code. MCP clients and a plain shell leave no trace to read; '
        + 'both are partial by construction (see docs/integration-contract.md).',
    };
  }
  const gaps = [];
  for (const client of det.clients) {
    for (const occasion of OCCASIONS) {
      const c = ev.cells[client]?.[occasion];
      if (!c) { gaps.push(`${client}/${occasion} missing`); continue; }
      if (c.status !== STATUS.FULL) gaps.push(`${client}/${occasion} ${c.status}`);
      else {
        for (const e of matrix[client][occasion].entries) {
          if (e.register && !det.commands.includes(e.register.hook)) {
            gaps.push(`${client}/${occasion} full in the tree but ${e.register.hook} is not registered here`);
          }
        }
      }
    }
  }
  if (gaps.length) {
    return {
      level: 'warn',
      text: `${det.clients.join(', ')}: ${gaps.length} occasion(s) not fully covered: ${gaps.join('; ')}`,
      advice: 'Partial support is written down in docs/integration-contract.md with what is covered and what is not. '
        + 'A tool being available does not mean it is called: only a registered hook makes an occasion certain.',
    };
  }
  return {
    level: 'good',
    text: `${det.clients.join(', ')}: all ${OCCASIONS.length} occasions full`,
    advice: null,
  };
}

// --- the generated block of the document --------------------------------

export const BLOCK_BEGIN = '<!-- BEGIN GENERATED: integration-matrix -->';
export const BLOCK_END = '<!-- END GENERATED: integration-matrix -->';

const CLIENT_TITLE = Object.freeze({
  [CLIENT.CLAUDE_CODE]: 'Claude Code (hooks)',
  [CLIENT.MCP]: 'MCP clients',
  [CLIENT.CLI]: 'plain CLI',
});

/** The generated markdown, without the markers. */
export function renderBlock(matrix = MATRIX) {
  const lines = [];
  lines.push('| Occasion | ' + CLIENTS.map((c) => CLIENT_TITLE[c]).join(' | ') + ' |');
  lines.push('|---|' + CLIENTS.map(() => '---|').join(''));
  for (const o of OCCASIONS) {
    lines.push(`| ${o} | ` + CLIENTS.map((c) => matrix[c][o].status).join(' | ') + ' |');
  }
  lines.push('');
  lines.push('Evidence and scope per cell:');
  lines.push('');
  for (const c of CLIENTS) {
    for (const o of OCCASIONS) {
      const cell = matrix[c][o];
      lines.push(`- **${c} / ${o}: ${cell.status}.** ${cell.note}`);
      for (const e of cell.entries) lines.push(`  - \`${describe(e)}\``);
    }
  }
  lines.push('');
  lines.push('Budget per occasion:');
  lines.push('');
  lines.push('| Occasion | Puts in | Budget |');
  lines.push('|---|---|---|');
  for (const o of OCCASIONS) lines.push(`| ${o} | ${BUDGET[o].delivers} | ${BUDGET[o].budget} |`);
  lines.push('');
  lines.push('Measured today on the hook path:');
  lines.push('');
  lines.push('| Occasion | Delivered | Retrieved | Considered | Where |');
  lines.push('|---|---|---|---|---|');
  for (const o of OCCASIONS) {
    const m = MEASURE[o];
    lines.push(`| ${o} | ${m.delivered} | ${m.retrieved} | ${m.considered} | ${m.where} |`);
  }
  return lines.join('\n');
}

/** The text between the markers of a document, or null if they are not both there. */
export function extractBlock(docText) {
  const a = docText.indexOf(BLOCK_BEGIN);
  const b = docText.indexOf(BLOCK_END);
  if (a < 0 || b < 0 || b < a) return null;
  return docText.slice(a + BLOCK_BEGIN.length, b).replace(/^\n/, '').replace(/\n$/, '');
}

/** The document with the block replaced by the generated one. */
export function withBlock(docText, matrix = MATRIX) {
  const a = docText.indexOf(BLOCK_BEGIN);
  const b = docText.indexOf(BLOCK_END);
  if (a < 0 || b < 0 || b < a) throw new Error('integration contract: the block markers are missing');
  return docText.slice(0, a + BLOCK_BEGIN.length) + '\n' + renderBlock(matrix) + '\n' + docText.slice(b);
}

// `node src/integrationcontract.mjs --write` regenerates the block.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    && process.argv.includes('--write')) {
  const doc = path.join(CODE_ROOT, 'docs', 'integration-contract.md');
  fs.writeFileSync(doc, withBlock(fs.readFileSync(doc, 'utf8')));
  process.stdout.write(`wrote ${doc}\n`);
}
