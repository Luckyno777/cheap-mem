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
import { fileURLToPath } from 'node:url';
import * as cfgmod from '../config.mjs';
import * as inbox from '../inbox.mjs';
import * as switches from '../switches.mjs';
import * as onboarding from '../onboarding.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The root of the PACKAGE (not of the memory): src/cli -> .. -> .. */
export const PKG_ROOT = path.resolve(HERE, '..', '..');

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
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { args, rest };
}

export function out(t) { process.stdout.write(`${t}\n`); }
export function die(t) { process.stderr.write(`${t}\n`); process.exit(1); }
// On stderr, so that --json callers and hooks parsing stdout see nothing
// of it. A warning may disturb a write; it must never break a contract.
export function warn(text) { process.stderr.write(`! ${text}\n`); }

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

// Text fields, i.e. the ones whose value is prose a user typed. If one of
// these arrives as `true`, the value was eaten — see fieldsFrom().
export const TEXT_FIELDS = new Set(['title', 'text', 'topic', 'choice', 'why', 'fact',
  'summary', 'class', 'source', 'subject']);

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
    if (v === true && TEXT_FIELDS.has(k)) {
      die([
        `${command}: --${k} arrived without a value.`,
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
