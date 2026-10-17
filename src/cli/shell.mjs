// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The CLI's shell: what every command needs before it does anything.
 *
 * Split out of `bin/mem` on 2026-09-18. That file had 4503 lines and was
 * the largest in a project whose `src/` holds 62 focused modules beside
 * it. Not a matter of taste: the file has no extension, and that is
 * exactly how it slipped past ESLint on 2026-09-08 without anyone
 * noticing. A file too big to be held in view is also too big for anyone
 * to notice that nothing is checking it.
 *
 * Only what holds ACROSS commands lives here: reading arguments, output,
 * refusal, checking switches, finding the root, knowing who writes.
 * Domain logic belongs in the modules in `src/`, not here — this file
 * must not become the next one that grows too large.
 */
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import * as cfgmod from '../config.mjs';
import * as inbox from '../inbox.mjs';
import * as switches from '../switches.mjs';
import * as authority from '../authority.mjs';
import * as onboarding from '../onboarding.mjs';
import { maskOutput } from '../outputguard.mjs';
import { frozenSet } from '../frozenset.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The root of the PACKAGE (not of the memory): src/cli -> .. -> .. */
export const PKG_ROOT = path.resolve(HERE, '..', '..');

// The few `mem log` / `mem correction` flags that are real SWITCHES (no value): everything else needs one. A flag without
// a value used to be written as `true` for any field that was not on a short list of prose fields, so `--tags`, `--key`,
// `--files` ... wrote `tags: true` / `key: true` and the readers broke on them (review 2026-10-12). See fieldsFrom().
// (`without-scaffold` and `no-broadcast` are taken out of the entry by the log handler.)
const SWITCH_FIELDS = frozenSet(['shred', 'automatic', 'without-scaffold', 'no-broadcast']);

/**
 * **The register of boolean switches: the one place the parser learns that a `--name` is a switch and not a value-taker.**
 *
 * The parser reads `--key next` as "key is next" unless next starts with `--`. For a boolean switch that is wrong in exactly
 * one case that matters: `-h`. `mem init --force -h`, `mem serve --readonly -h`, `mem raw delete <p> --yes -h`,
 * `mem epoch --force -h` read `-h` as the VALUE of the switch, so the command ran (and wrote, or started a server) instead of
 * showing its help (help-after-bool-cm, 2026-10-17; the sibling of the `-h` position fix of 2026-10-13). A name listed here
 * never takes `-h` as its value; `-h` stays a help request, as everywhere else.
 *
 * **What is listed.** Names that are switches in EVERY command that knows them (read as `Boolean(args.x)` / `if (args.x)`,
 * never through `textFlag` / `numberFlag` / `String(args.x)`): test/bool-switch-help.test.mjs holds that against the source.
 * Left out on purpose: `quiet` (a switch in `doctor`, a number of minutes in `digest due`), `human` (a switch OR a name in
 * `init`; so `doctor --quiet -h` runs the doctor), and every name that is a value switch somewhere. A value switch keeps its old reading (`--text -h` still writes
 * the text "-h"; `--top 5`, `--root x` are untouched).
 *
 * **What is NOT changed.** Any other word after a switch is still taken as its value, as before: the handlers that refuse a
 * value for a switch (`serve --allow-writes maybe`, `--as-me <word>`) keep refusing it, rather than silently dropping a word.
 * `mem log` / `mem correction` take any `--name value` as a field: there `--open word` still writes the field; only
 * `--open -h` asks for help.
 */
export const BOOL_SWITCHES = frozenSet([
  ...SWITCH_FIELDS,
  'json', 'force', 'dry-run', 'readonly', 'allow-writes', 'local-no-token', 'as-me', 'write', 'yes', 'all', 'open',
  'all-proposals', 'alarm', 'brief', 'briefing', 'check-only', 'conflicts', 'derived', 'flat', 'fresh', 'full', 'graph',
  'hook', 'large', 'list-stores', 'literal', 'markdown', 'names-only', 'new-baseline', 'no-mmr', 'no-raw', 'no-write',
  'non-interactive', 'off', 'only-raw', 'pre-push', 'private', 'proposals', 'rebuild', 'recall', 'self-test',
  'session-start', 'shown', 'skip-fetch', 'stale', 'status', 'strict', 'suggested', 'sync', 'table', 'weak', 'weekly',
  'wildcard', 'with-disputed', 'with-echo', 'with-retired', 'content-words', 'head', 'raw', 'no-mark', 'html', 'line', 'draw',
]);

export function parseArgs(argv) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // `--key=value` first: here the value is unambiguous even when it
      // begins with dashes. Without this form there is NO way to pass such
      // a value — and the guard against a swallowed value recommends
      // exactly this syntax, so leaving it out would make the advice a
      // dead end. Found by the test for that advice, not by reading.
      const eq = a.indexOf('=');
      if (eq > 2) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      // A word after a boolean switch is still its value (the handlers that refuse one keep refusing), except `-h`: that is a
      // help request, never the value of a switch listed in BOOL_SWITCHES.
      if (next !== undefined && !next.startsWith('--') && !(next === '-h' && BOOL_SWITCHES.has(key))) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else if (a === '-h') {
      // **`-h` where a switch would stand is `--help`.** Until 2026-10-13 only
      // bin/mem's first-argument check knew `-h`; anywhere else it was just a
      // positional word, so `mem init -h` built a whole memory and `mem serve
      // -h` started the server. It is handled HERE, once, so no handler needs
      // its own copy: it becomes `args.help`, the very thing `isHelp()` reads.
      // A `-h` that a preceding `--key` took as its VALUE never gets here (the
      // branch above consumed it): `mem log learning --text -h` still writes
      // the text "-h". A switch that is a known BOOLEAN (BOOL_SWITCHES) never takes it,
      // so `mem init --force -h` is a help request.
      markHelp(args);
    } else {
      rest.push(a);
    }
  }
  return { args, rest };
}

// **Captured output (M10, 2026-09-30).** The warm recall server
// (src/recallserver.mjs) runs the SAME `find` handler the hook runs as
// `mem find --json` — one search path, not two (O1). Inside a
// long-running server `out()` must not reach the server's own stdout and
// `die()` must not end the server, so a run inside `captureOutput()`
// collects `out()` lines and turns `die()` into a thrown `CapturedDie`.
// Outside a capture both behave exactly as before.
const CAPTURE = new AsyncLocalStorage();

/** What `die()` throws inside `captureOutput()`: the message, and exit 1. */
export class CapturedDie extends Error {
  constructor(message) { super(message); this.name = 'CapturedDie'; this.exitCode = 1; }
}

/** Run `fn` with `out()` collected; resolves to the collected stdout text. */
export async function captureOutput(fn) {
  const buffer = [];
  await CAPTURE.run(buffer, fn);
  return buffer.join('');
}

// **Output guard (src/outputguard.mjs).** ON for every command, switched off only for the ones in `UNGUARDED`
// (since the mask-before-cut round, 2026-10-13: it used to be an allow-list, `READ_COMMANDS`, and every command
// that was forgotten there printed entry text in the clear: `inbox`, `skills`, `teach`, `net`, `observations`,
// `appointment`, `suggest` were found that way). Everything the commands print through `out()` passes the mask for
// known key shapes; a command that shows no entry content pays almost nothing (one pass over short lines).
let guardOutput = true;
/**
 * The commands whose output is NOT masked, each with its reason. Keep this list short and argued; a command is
 * added here only when masking would break what it is for.
 *   serve  `mem serve setup-code` prints the one-time code the owner types into the dashboard (and the local
 *          link); a mask on it would hide exactly what the command exists to show.
 */
const UNGUARDED = frozenSet(['serve']);
/** Set once, before the handler (bin/mem calls this). */
export function guardOutputFor(command) { guardOutput = !UNGUARDED.has(command); }

export function out(t) {
  const text = guardOutput ? maskOutput(t) : t;
  const c = CAPTURE.getStore();
  if (c) { c.push(`${text}\n`); return; }
  process.stdout.write(`${text}\n`);
}
export function die(t) {
  if (CAPTURE.getStore()) throw new CapturedDie(String(t));
  process.stderr.write(`${t}\n`); process.exit(1);
}
// On stderr, so that --json callers and hooks parsing stdout see nothing
// of it. A warning may disturb a write; it must never break a contract.
export function warn(text) { process.stderr.write(`! ${text}\n`); }

/**
 * Every value of a flag that stands several times on the command line (`--option a --option b`, also `--option=a`). The
 * parser keeps only the last one; a list flag that may repeat reads them from here. Stops at `--`.
 */
export function repeatedFlag(name, argv = process.argv.slice(3)) {
  const found = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--') break;
    if (argv[i] === `--${name}`) {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { found.push(argv[i + 1]); i += 1; }
    } else if (argv[i].startsWith(`--${name}=`)) found.push(argv[i].slice(name.length + 3));
  }
  return found;
}

export function checkFlags(args, known, sub) {
  const bad = Object.keys(args).filter((k) => k !== 'help' && k !== 'root' && !known.includes(k));
  if (bad.length) {
    die([
      `${sub}: unknown flag '--${bad[0]}'`,
      `Known: ${known.map((k) => `--${k}`).join(', ') || '(none)'}`,
    ].join('\n'));
  }
}

export function isHelp(args) { return args.help === true; }
/** The one writer of the flag `isHelp()` reads: parseArgs, for a bare `-h`. (The parameter is not called `args` so
 * that test/f5-handler-flags.test.mjs, which keeps handlers from touching the flag directly, stays meaningful.) */
function markHelp(parsed) { parsed.help = true; }

/**
 * A text from a switch -- or a loud refusal. `mem done <id> --why` (no value) arrives as `true`; written as it stood it made a
 * closing line the readers call broken, so the target stayed open (second review 2026-10-12). Returns `null` when the switch is
 * absent. The same wording as the log commands use for a value-less flag.
 */
export function textFlag(args, name, command) {
  const v = args[name];
  if (v === undefined || v === null) return null;
  if (v === true || v === false) {
    die([
      `${command}: --${name} arrived without a value.`,
      `  Write it with one: --${name} "<text>".`,
      '  If the value starts with --, the parser eats it as a switch:',
      `    --${name}="--your text"`,
      '  Nothing was written.',
    ].join('\n'));
  }
  return String(v);
}

/**
 * A number from a switch -- or a loud refusal.
 *
 * `Number('abc')` is `NaN`, and `NaN` does not break a comparison, it just
 * makes it `false`: `--top abc` then meant "no limit" or "no results" with
 * exit 0, indistinguishable from a real answer. This is the ONLY way a
 * command handler turns a switch into a number (test/f5-numberflag-guard).
 * Mirror of `zahlAus()` in lucky-mem's bin/mem.
 *
 * Returns `fallback` (default `null`) when the switch is absent or empty.
 * A bare `--top` arrives as `true`: that is an error, not a 1.
 */
export function numberFlag(name, value, { fallback = null, min = null, max = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') die(`Error: --${name} needs a number, but came without a value.`);
  const n = Number(value);
  if (!Number.isFinite(n)) die(`Error: --${name} needs a number, got '${value}'.`);
  if (min !== null && n < min) die(`Error: --${name} must be at least ${min}, got ${n}.`);
  if (max !== null && n > max) die(`Error: --${name} must be at most ${max}, got ${n}.`);
  return n;
}

/**
 * A switch that NARROWLY misses a reserved name is a typo, not a field.
 *
 * The rule itself lives in `src/switches.mjs` — one place, so that the
 * probe measuring it cannot quietly measure its own copy.
 */
export function refuseNearReserved(command, k) {
  const r = switches.nearReserved(k);
  if (r) die(switches.typoMessage(command, k, r));
}

/**
 * Turn `--switches` into the fields of a JSONL entry.
 *
 * **Why this is one function and not two loops.** `mem log` and
 * `mem correction` both write lines into the same files and both had
 * their own copy of this loop. Copies drift, and nothing about either
 * copy LOOKS wrong while they do — that is what makes the class of bug
 * expensive. The sibling project lucky-mem carried the same rule in six
 * places at one point; the second copy here was already one behind.
 *
 * Four things are enforced, all of them silent failures before:
 *
 *   1. A list may be given comma-separated OR as a JSON array. Half a
 *      JSON array is refused instead of being cut at the commas —
 *      `--tags '["a","b"]'` used to become the tags `["a` and `"b"]`.
 *      Valid JSON, exit 0, no complaint, and the entry is no longer
 *      findable by any of its tags. lucky-mem has 17 such entries.
 *   2. `--origin` may be a JSON object (unchanged behaviour, kept here
 *      so the two commands cannot disagree about it either).
 *   3. A swallowed value is refused. `--title "--flag-ish text"` parses
 *      as a switch, and the entry became
 *      `{"title": true, "--flag-ish text": true}` — valid JSON,
 *      destroyed content, no message. Both halves are safely
 *      recognisable: a field name cannot contain whitespace, and a text
 *      field cannot legitimately be `true`.
 *   4. A switch that narrowly misses a RESERVED name is refused rather
 *      than turned into a field — see `refuseNearReserved` above.
 *
 * `command` only appears in error messages, so someone running
 * `mem correction` is not told what `log` disliked.
 */
/**
 * Y4b: `--authority <tier>` on a state-changing command (done, discard,
 * supersede, duties close, correction) — the tier the new line is
 * stamped with. `null` when not given (the write path then stamps its
 * default, `agent`, or the process ceiling). A name that is not a tier
 * is refused here: the write path would otherwise normalise it to
 * `unknown` without a word, and the writer would believe they had
 * asserted something. `user` is only ever set this way — explicitly —
 * and CHEAP_MEM_MAX_AUTHORITY still lowers it on the write path.
 */
export function authorityArg(args, command) {
  const v = args.authority;
  if (v === undefined) return null;
  const t = v === true ? '' : String(v).toLowerCase().trim();
  if (!authority.TIERS.includes(t)) {
    die(`${command}: --authority takes one of ${authority.TIERS.join(', ')} (got '${v === true ? '' : v}').`);
  }
  return t;
}

/**
 * The scope of a skill, workflow, snippet or procedure (`src/experience.mjs`) and the files of an
 * error are LISTS like `tags`: `--topics '["mcp","skill"]'` used to stay one string that the reader
 * tore apart at its commas (port of lucky-mem `skill-geltung`, 2026-10-03: the skill's account
 * showed 0 cases because of it), and `errorfile.files()` ignored a comma string of `--files`.
 */
const SCOPE_LISTS = new Set(['classes', 'files', 'topics']);

/** One scope list from `--<k>`: a JSON list or a comma list, as an array; half-JSON is refused like for `--tags`. */
function scopeList(command, k, v) {
  if (/^\s*\[/.test(v)) {
    let list;
    try { list = JSON.parse(v); }
    catch (e) { die(`${command}: --${k} looks like JSON but is not: ${e.message}`); }
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
      die(`${command}: --${k} as JSON must be a list of strings.`);
    }
    return list.map((x) => x.trim()).filter(Boolean);
  }
  const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
  const bent = parts.filter((x) => /["[\]{}]/.test(x));
  if (bent.length) {
    die(`${command}: --${k} contains brackets or quotes (${JSON.stringify(bent[0])}). `
      + 'Write it comma-separated, or as a JSON list — both work, half JSON does not.');
  }
  return parts;
}

export function fieldsFrom(command, args, except = []) {
  const data = {};
  // `help` is the parser's, the rest are `src/switches.mjs`'s — the same
  // list the typo guard below measures against, so the two cannot drift.
  const skip = new Set([...switches.RESERVED_SWITCHES, 'help', ...except]);

  for (const [k, v] of Object.entries(args)) {
    if (skip.has(k)) continue;
    refuseNearReserved(command, k);

    // **Roads not taken are split on a SEMICOLON, not a comma.**
    //
    // The value is a sentence, not a keyword: "PostgreSQL: too heavy,
    // and too much operations for a file database". A comma split turns
    // that into two fragments, neither of which is a statement any
    // more — the same silent damage that once made 17 entries
    // unfindable by tag in the reference deployment.
    if (k === 'rejected' && typeof v === 'string' && !/^\s*\[/.test(v)) {
      const parts = v.split(';').map((x) => x.trim()).filter(Boolean);
      if (!parts.length) die(`${command}: --rejected is empty.`);
      data[k] = parts;
      continue;
    }

    // The scope lists have a branch of their own (the `--tags` / `--asked` lines below stay as the
    // mutation anchors in bench/mutation.mjs expect them).
    if (SCOPE_LISTS.has(k) && typeof v === 'string') {
      data[k] = scopeList(command, k, v);
      continue;
    }

    if ((k === 'tags' || k === 'asked' || k === 'rejected') && typeof v === 'string' && /^\s*\[/.test(v)) {
      let list;
      try { list = JSON.parse(v); }
      catch (e) { die(`${command}: --${k} looks like JSON but is not: ${e.message}`); }
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
        die(`${command}: --${k} as JSON must be a list of strings.`);
      }
      data[k] = list.map((x) => x.trim()).filter(Boolean);
      continue;
    }

    if ((k === 'tags' || k === 'asked') && typeof v === 'string') {
      // `asked` are QUESTION WORDS: what someone would search for
      // without using the entry's own words. Comma-separated like tags,
      // because that is what they are — access words for questions
      // instead of for topics.
      const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
      const bent = parts.filter((x) => /["[\]{}]/.test(x));
      if (bent.length) {
        die(`${command}: --${k} contains brackets or quotes (${JSON.stringify(bent[0])}). `
          + 'Write it comma-separated, or as a JSON list — both work, half JSON does not.');
      }
      data[k] = parts;
      continue;
    }

    if (k === 'origin' && typeof v === 'string' && /^\s*[{[]/.test(v)) {
      // Provenance is a STRUCTURE, and every doc tells you to pass it as
      // one: --origin '{"raw":"...","derived_from":["id"]}'. Stored flat
      // it parses as nothing — origin.raw is undefined, so the
      // digest-yield check measures no provenance at all, and
      // origin.derived_from stays invisible, so no learning can ever be
      // backed. The documented syntax has to actually mean something.
      try { data.origin = JSON.parse(v); }
      catch { die(`${command}: --origin is not valid JSON: ${v}`); }
      continue;
    }

    data[k] = v;
  }

  // The swallowed value. No ordinary call trips this; the broken one
  // always does.
  for (const [k, v] of Object.entries(data)) {
    if (/\s/.test(k)) {
      die([
        `${command}: '${k.slice(0, 60)}${k.length > 60 ? '…' : ''}'`,
        '  arrived as a FIELD NAME, but field names have no whitespace.',
        '  Almost certainly this was the value of a switch whose text starts',
        '  with --. Write it unambiguously:',
        '    --title="--your text"      (or put a space in front)',
        '  Nothing was written.',
      ].join('\n'));
    }
    if (v === true && !SWITCH_FIELDS.has(k)) {
      die([
        `${command}: --${k} arrived without a value.`,
        `  Write it with one: --${k} <value> (a list: comma-separated, or as a JSON list).`,
        '  If the value starts with --, the parser eats it as a switch:',
        `    --${k}="--your text"`,
        '  Nothing was written.',
      ].join('\n'));
    }
  }

  return data;
}

export function findRoot(args) {
  if (args.root) return path.resolve(String(args.root));
  const env = process.env.CHEAP_MEM_ROOT;
  if (env) return path.resolve(env);
  const walked = cfgmod.findRoot(process.cwd());
  if (walked) return walked;
  return process.cwd();
}

export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export function requireConfig(root) {
  try {
    return cfgmod.readConfig(root);
  } catch (e) {
    if (e.code === 'ENOCONFIG') die(e.message);
    die(`Config error: ${e.message}`);
  }
}

/**
 * Who a local `--as-me` write is by: the identity of THIS install, never a guess (port of lucky-mem `--ich`, F1b, with the
 * source the other way round: lucky-mem takes the name the caller types, cheap-mem takes it from the install).
 *
 * The finding behind it: a write without `--agent` is stamped `agentDefault()`, and without `CHEAP_MEM_AGENT` that is
 * `human:<os user>` - in a cloud session `human:root`, a name that reads as a person (`authority.isHumanName`) on a line an
 * agent wrote. `--as-me` asks for the install's own identity instead:
 *
 *   1. `CHEAP_MEM_AGENT` / `MEM_AGENT`   what a deployment names its process (the same order as `memory.agentDefault`)
 *   2. `mem whoami`                      the stored participant of this install (`.mem/inbox-whoami`)
 *   3. neither                           REFUSED. Never `human:<os user>`: an invented origin looks like evidence.
 *
 * Three states of the stored name, none of them guessed: not set / blank -> refused with the way out; set but no longer a
 * configured participant (broken) -> refused naming it; set and configured -> used.
 *
 * **It carries no rank.** The switch stamps the NAME only; the tier stays what the write path gives (`agent`, or the process
 * ceiling), so `--as-me` never raises a rank the caller does not have. It refuses to be combined with `--authority` (a claim
 * of rank is its own act, `--authority user` behind `authority.checkUserWrite`), with `--agent` (two writers), and it
 * refuses a name that reads as a person (`owner`, `human:<name>`): that stamp comes only from a shell, by `agentDefault`, and the
 * configured human participant (`human: true` in the config): the switch never puts a person's name on an agent's line.
 *
 * @returns {string|null} the writer name, or null when `--as-me` is not given. Refuses via `die` (nothing written).
 */
export function asMeWriter(root, cfg, args, command, env = process.env) {
  const v = args['as-me'];
  if (v === undefined) return null;
  if (v !== true) {
    // The value is not echoed: it is the next word of the command line (an address, a path), which may carry a secret.
    die(`${command}: --as-me is a switch without a value, but the parser read the next word as its value. `
      + 'Put --as-me last, after the other arguments. Nothing was written.');
  }
  if (Object.hasOwn(args, 'agent')) die(`${command}: --as-me and --agent name two writers. Use one. Nothing was written.`);
  if (Object.hasOwn(args, 'authority')) {
    die(`${command}: --as-me carries no rank, and --authority claims one; they are not combined. `
      + 'Use --as-me for the writer and leave the tier to the write path (agent). Nothing was written.');
  }
  const set = String(env.CHEAP_MEM_AGENT ?? env.MEM_AGENT ?? '').trim();
  let name = set;
  if (!name) {
    const stored = inbox.whoAmI(root);
    if (!stored) {
      die([
        `${command}: --as-me: this install has no identity (no CHEAP_MEM_AGENT, and \`mem whoami\` is not set).`,
        `  Once:  mem whoami <${Object.keys(cfg.participants).join('|')}>`,
        '  The OS account name is not used for this: it would stamp a person where an agent wrote. Nothing was written.',
      ].join('\n'));
    }
    if (!Object.hasOwn(cfg.participants, stored)) {
      die(`${command}: --as-me: \`mem whoami\` names '${stored}', which is not a configured participant `
        + `(known: ${Object.keys(cfg.participants).join(', ')}). Set it again: mem whoami <name>. Nothing was written.`);
    }
    name = stored;
  }
  // The configured human is no agent's name either (the mark `human: true` in the config, never a name in the code): the
  // recommended switch must not put a person's name on an agent's line. `--agent <name>` stays the explicit way.
  if (cfgmod.isHuman(cfg.participants?.[name])) {
    die(`${command}: --as-me: '${name}' is the human participant of this memory. The switch stamps an agent's line, `
      + 'and a person\'s name does not belong on it. Set the identity of the agent (mem whoami <name>, or CHEAP_MEM_AGENT). '
      + 'Nothing was written.');
  }
  if (authority.isHumanName(name)) {
    die(`${command}: --as-me: '${name}' reads as a person (owner, human:<name>). Only a shell stamps that, `
      + 'by itself (leave --as-me out). Nothing was written.');
  }
  return name;
}

export function whoAmIOrDie(root, args, cfg) {
  const stored = inbox.whoAmI(root);
  const chosen = args.as ?? stored;
  if (!chosen) {
    die([
      `Who is this install in the channel?`,
      `  Once:      mem whoami <${Object.keys(cfg.participants).join('|')}>`,
      `  Per call:  --as <name>`,
    ].join('\n'));
  }
  if (!Object.hasOwn(cfg.participants, chosen)) {
    die(`'${chosen}' has no inbox. Known: ${Object.keys(cfg.participants).join(', ')}`);
  }
  return chosen;
}

/**
 * Reading is not a receipt. `inbox new`/`inbox all` only records a message
 * as locally seen (.mem/inbox-seen.json); it does NOT change the message's
 * State, so for the sender it stays 'open' forever until the recipient runs
 * `inbox ack`. Nobody notices, because reading and acking feel like one
 * mechanism and are two. So when mail addressed to me is still open, say once
 * how to send a receipt. Auto-acking on read would be wrong: it turns every
 * poll into a git write and hides which messages were actually acted on. A
 * hint, not a silent write.
 */
export function receiptHint(messages) {
  const open = (messages ?? []).filter((m) => m.state === inbox.STATE.OPEN);
  if (open.length === 0) return;
  out('');
  out(`Note: reading is not a receipt — for the sender these ${open.length}`);
  out(`still read 'open'. When you have dealt with one:`);
  out(`  mem inbox ack <name> [replied|processed|closed]`);
  out(`  then git add/commit/push — otherwise the sender never sees the receipt.`);
}

/**
 * Show the onboarding status.
 *
 * Every open step names the COMMAND that closes it. A finding without
 * a next move is a complaint.
 */
export function showOnboarding(st) {
  out(`Onboarding '${st.agent}':`);
  for (const name of onboarding.STEPS) {
    const s = st.steps[name];
    out(`  ${s.state === 'green' ? 'ok  ' : 'OPEN'} ${name.padEnd(12)} ${s.why}`);
    if (s.todo) for (const l of String(s.todo).split('\n')) out(`      -> ${l}`);
  }
  out('');
  if (st.done) {
    out('The loop stands: this agent writes and finds again.');
  } else {
    out(`${st.open.length} of ${onboarding.STEPS.length} steps open.`);
    out("There is no 'essentially onboarded' — created is not connected.");
  }
}
