/**
 * What the command handlers print, and how they read a date.
 *
 * Split out of `bin/mem` on 2026-09-18. These sat BELOW the command
 * table, hoisted into scope by the language rather than by any visible
 * structure — the same thing that was true of the git-hook block. Here
 * they are ordinary imports, and a handler that uses one says so.
 *
 * They are display and input-parsing, not domain logic: `--as-of` is
 * read strictly here because a flag a person just typed is not the same
 * as data a library reads (the reason is on `asOfOf` below), and the
 * rest turn entries into lines someone can read.
 */

import fs from 'node:fs';
import * as memory from '../memory.mjs';
import * as retrieval from '../retrieval.mjs';
import * as timesearch from '../timesearch.mjs';
import * as procedure from '../procedure.mjs';
import { out, die, checkFlags, isHelp, findRoot, requireConfig } from './shell.mjs';

/**
 * Parse `--as-of`, and REFUSE what cannot be parsed.
 *
 * **Why this is strict where `validAt` is lenient.** `retrieval.validAt`
 * treats an unparseable timestamp as "no bound" and returns true — right
 * for a library reading data it did not write, wrong for a flag a person
 * just typed. Measured on 2026-09-17, before this function existed:
 *
 *     mem retrieve "test" --as-of gestern    ->   exit 0, every claim
 *
 * No warning, no empty result — just the full present-day answer to a
 * question about the past. That is the worst shape a bug can take: it
 * looks like an answer. A tool that silently ignores the one flag that
 * changes the meaning of the question is lying about what it did.
 *
 * Returns the ISO string (never a Date), because that is what `validAt`
 * and the JSON envelope both want.
 */
export function asOfOf(value, where) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) {
    die(`${where}: --as-of '${value}' is not a date I can read.\n`
      + '  Use an ISO timestamp: 2026-09-01 or 2026-09-01T14:30:00Z\n'
      + '  (A date I cannot read would silently filter nothing, and you would\n'
      + '   get today\'s answer to a question about then.)');
  }
  return new Date(t).toISOString();
}

/**
 * Parse `--valid_until` (or `--valid_from`) at WRITE time, and REFUSE
 * what cannot be parsed. Same discipline as `asOfOf` above, and the same
 * reason: `retrieval.validAt` is deliberately LENIENT on an unparseable
 * bound — it reads data it did not write, and treats a bad stamp as "no
 * bound", i.e. as if the field had never been set at all.
 *
 * That leniency is correct for a reader and disastrous for a writer.
 * `mem log decision ... --valid_until banana` would, without this check,
 * write `"valid_until": "banana"` — valid JSON, exit 0, no complaint —
 * and every later reader would silently treat the claim as OPEN-ENDED,
 * the opposite of what was typed, with nothing to notice it by until
 * someone runs `mem doctor` and finds a timestamp nobody can explain.
 * Copied from `asOfOf` rather than reused because the message names a
 * different flag and a different moment (a value being WRITTEN into the
 * log, not a filter being applied to a read).
 */
export function dateFieldOf(value, field, where) {
  if (value === true) {
    die(`${where}: --${field} was given without a value.`);
  }
  const t = Date.parse(value);
  if (!Number.isFinite(t)) {
    die(`${where}: --${field} '${value}' is not a date I can read.\n`
      + '  Use an ISO timestamp: 2026-09-01 or 2026-09-01T14:30:00Z\n'
      + `  (An unparseable ${field} would silently read back as "no bound" —\n`
      + '   open-ended forever — which is the opposite of what you typed.)');
  }
  return new Date(t).toISOString();
}

export function sinceOf(s) {
  const m = /^(\d+)([dhm])$/.exec(s);
  if (m) {
    const [, n, unit] = m;
    const ms = { d: 86400000, h: 3600000, m: 60000 }[unit] * Number(n);
    return new Date(Date.now() - ms);
  }
  return new Date(s);
}

// Shared output for the time router (find) and `when`. `query` supplies the
// subject words to narrow by; empty = the whole window.
export function showWindow(root, query, window, args, { asOf = null } = {}) {
  const t0 = Date.now();
  const words = timesearch.keywordsOf(query);
  const project = args.project && args.project !== 'global' ? args.project : null;
  const all = timesearch.entriesInWindow(root, {
    from: window.from, to: window.to, project, words,
  });
  // **The time-window lane filters too.** Two different times, and they
  // do not clash: the window says WHEN something was written down,
  // `--as-of` says what HELD at a moment. Give both and you want both.
  //
  // More important than the nicety is the rule behind it: a flag that
  // works on one of three lanes and stays silent on the others is worse
  // than none — you cannot tell by looking when it applied.
  const entries = asOf ? all.filter((e) => retrieval.validAt(e, asOf)) : all;
  const ms = Date.now() - t0;
  const wj = { from: window.from.toISOString(), to: window.to.toISOString(), label: window.label };

  if (args.json) {
    // Newest first, capped: the hook takes only the top few — they should be
    // the freshest of the window, not the oldest.
    const newest = [...entries].reverse().slice(0, 20);
    const hits = newest.map((e, i) => ({
      score: 1000 - i, source: e._source, line: e._line, entry: e,
    }));
    out(JSON.stringify({ query, ms, window: wj, asOf, hits }, null, 2));
    return;
  }

  const narrow = words.length ? `, narrowed to ${words.join('/')}` : '';
  // Say that filtering happened, and how much fell away. A shorter list
  // with no explanation reads as an empty memory.
  const asOfNote = asOf ? `, as of ${asOf} — ${all.length - entries.length} not valid then` : '';
  out(`${entries.length} entries in window '${window.label}' (${wj.from} .. ${wj.to}${narrow}${asOfNote}, ${ms}ms):`);
  for (const e of entries) {
    out(`  [${e.ts}] ${e._source}:${e._line}`);
    out(`         ${compactLine(e)}`);
  }
  if (entries.length === 0) {
    out('  (nothing digested in this window — try --raw for the raw transcript)');
  }
  if (args.raw) {
    const { lines, capped, files } = timesearch.rawInWindow(root, {
      from: window.from, to: window.to, maxLines: Number(args['raw-max'] ?? 200),
    });
    out('');
    out(`--- raw conversation in window (${lines.length} lines from ${files} captures${capped ? ', capped' : ''}) ---`);
    for (const l of lines) out(`  [${l.ts}] ${l.type || ''}: ${l.text}`);
  }
}

export function compactLine(e) {
  const parts = [];
  // **A procedure never comes out without its marking.**
  //
  // Its text is instruction-shaped. Without the "issued by X on Y"
  // prefix the next agent reads it as a fact and follows it, never
  // having known that somebody set it — or who. The latch lives in the
  // DISPLAY, not in the caller: there are several display paths, and a
  // guarantee each of them has to keep on its own is only as strong as
  // the sloppiest one.
  if (e.rule) parts.push(procedure.mark(e));
  if (e.class) parts.push(`[${e.class}]`);
  if (e.topic) parts.push(`[${e.topic}]`);
  if (e.title) parts.push(e.title);
  if (e.choice) parts.push(`→ ${e.choice}`);
  if (e.text) parts.push(String(e.text).slice(0, 80).replace(/\s+/g, ' '));
  if (e.why) parts.push(`because ${String(e.why).slice(0, 60)}`);
  if (e.rule) parts.push(String(e.rule).slice(0, 120).replace(/\s+/g, ' '));
  if (e.question) parts.push(String(e.question).slice(0, 120).replace(/\s+/g, ' '));
  return parts.join(' — ') || '(no compact text)';
}

/**
 * An entry as a JSON consumer should see it.
 *
 * A procedure carries its marking as a FIELD here. The human paths get
 * it from `compactLine`, but the full `--json` output hands over the
 * raw entry — and a hook rendering `rule` out of that would show the
 * instruction text with no author at all. The guarantee has to hold on
 * the machine-readable path too, or it holds where it is least needed.
 */
export function markedEntry(e) {
  return e && e.rule ? { ...e, marking: procedure.mark(e) } : e;
}

export function countLines(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter((z) => z.trim()).length;
}

// discard/done: retire an entry without deleting it. Appends a tombstone
// line to the same log; recall hides the original from here on, the
// viewer keeps it (marked).
export function retireCmd(state, rest, args) {
  const verb = state === 'discarded' ? 'discard' : 'done';
  if (isHelp(args)) {
    out([
      `mem ${verb} <id> [--why "..."] [--type <type>] [--project <name>]`,
      "",
      `  Marks entry <id> as ${state} without deleting it. Recall stops`,
      "  showing it; the viewer keeps it (struck through). --type/--project",
      "  are only needed when the id is not uniquely locatable.",
    ].join('\n'));
    return;
  }
  checkFlags(args, ['why', 'type', 'project'], verb);
  const root = findRoot(args);
  requireConfig(root);
  const id = rest[0];
  if (!id) die(`${verb}: which id? Example: mem ${verb} a1b2c3 --why "..."`);
  const loc = args.type
    ? { type: args.type, project: args.project ? (args.project === 'global' ? null : args.project) : null }
    : memory.findEntryLocation(root, id);
  if (!loc) die(`${verb}: id '${id}' not found in any log. (a tombstone? already retired?)`);
  memory.retireEntry(root, loc.type, id, { state, why: args.why ?? null, project: loc.project });
  out(`${state}: ${id} (${loc.type}${loc.project ? `/${loc.project}` : ''})`);
}
