// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Procedures — "this is how we do it here", and who said so.
 *
 * **Why not `skill`.** A `skill` in this memory means "a capability
 * acquired, with evidence" — a STATEMENT ABOUT AN AGENT. What is
 * needed is a NORM FOR ALL. A different thing, and conflating them was
 * what made the original "skill lane" dangerous: a capability is
 * ACQUIRED, a procedure is ISSUED. The rename does not soften the
 * security problem, it dissolves it — it makes the authority question
 * visible instead of hidden.
 *
 * **The danger, stated plainly.** The body of a procedure IS an
 * instruction. That collides with the most important rule in this
 * system: what comes back out of the memory is DATA, not instructions.
 * Without a latch this would be the path along which one connected
 * agent gives orders to all the others.
 *
 * So three things, and all three must hold:
 *
 *   1. **The bridge does not write this type.** Not as a permission,
 *      not as a flag — at all. `mem_log` refuses `type: procedure`.
 *      A connected foreign agent has no write path to it.
 *   2. **Issued and written are two fields.** `issued_by` is the human
 *      who set the rule; `agent` is whoever typed it. If they differ,
 *      the entry carries `on_instruction: true`.
 *   3. **Every display carries the marking.** "Procedure, issued by X
 *      on Y" precedes the text, always. Without it the next reader
 *      launders the rule into a fact.
 *
 * **What is NOT solved here, said honestly.** Who is "the user" for a
 * foreign agent? It connects over MCP under an agent name; "the owner
 * asked me to" is unfalsifiable from there. No field solves that — a
 * field anybody can set is not authority. What this file achieves is
 * narrower and honest: the write path is closed, and where writing does
 * happen it is ATTRIBUTABLE who claims to have ordered it. A forgeable
 * claim becomes a forgeable but VISIBLE claim.
 */

import * as memory from './memory.mjs';
import * as errorclass from './errorclass.mjs';
import * as authority from './authority.mjs';

/** The type name, written in exactly one place. */
export const TYPE = 'procedure';

/**
 * Who can issue a rule: a human.
 *
 * `owner` is the role in the inbox, `human:<name>` the origin from the
 * CLI (see `memory.agentDefault`). An agent name is refused — not
 * because an agent could not be wise enough, but because a norm for
 * all agents cannot come from one of them.
 */
export function isHuman(name) {
  const n = String(name ?? '').trim();
  return n === 'owner' || /^human:[^\s]+$/.test(n);
}

/**
 * Check the fields before anything is written.
 *
 * Returns `{ ok, errors }`. Does not throw: the caller decides whether
 * that is an abort or a warning.
 */
export function check(fields = {}) {
  const problems = [];
  const title = String(fields.title ?? '').trim();
  const rule = String(fields.rule ?? '').trim();
  const by = String(fields.issued_by ?? '').trim();

  if (!title) problems.push('title missing — a rule without a name is never found again');
  if (!rule) problems.push('rule missing — that is the text meant to be followed');
  if (!by) {
    problems.push('issued_by missing — a rule without an author is an anonymous instruction');
  } else if (!isHuman(by)) {
    problems.push(`issued_by '${by}' is not a human. A norm for all agents cannot come `
      + 'from one of them (allowed: owner, human:<name>).');
  }
  // Scope is optional and stays optional: absent means the rule applies
  // everywhere, which is the conservative reading, not the convenient one.
  return { ok: problems.length === 0, errors: problems };
}

/** Complete the fields the way they should be stored. */
export function complete(fields = {}, { agent = null } = {}) {
  const by = String(fields.issued_by ?? '').trim();
  const out = { ...fields, issued_by: by };
  // `on_instruction` means: somebody other than the claimed issuer
  // typed this. That is the normal case (an agent writing for the
  // owner) and still a fact that has to travel — otherwise an invented
  // instruction looks exactly like a real one.
  if (agent && agent !== by) out.on_instruction = true;
  return out;
}

/**
 * The marking that precedes EVERY display.
 *
 * One line, not a paragraph: it goes wherever a short line goes, and a
 * paragraph would not survive there.
 */
export function mark(entry = {}) {
  const by = entry.issued_by ?? '(no author)';
  const day = String(entry.ts ?? '').slice(0, 10) || '(no date)';
  const how = entry.on_instruction ? `, written down by ${entry.agent ?? '?'}` : '';
  return `Procedure, issued by ${by} on ${day}${how}`;
}

/** Marking plus rule text — for retrieval and `mem show`. */
export function display(entry = {}) {
  const head = mark(entry);
  const title = entry.title ? `${entry.title}\n` : '';
  const scope = entry.scope ? `  (applies to: ${entry.scope})\n` : '';
  return `${head}\n${title}${scope}${entry.rule ?? ''}`.trimEnd();
}

/**
 * The error classes a procedure wants to be offered for.
 *
 * **Why a procedure gets a trigger at all.** A rule that only surfaces
 * when somebody remembers to run `mem procedures` is a rule that
 * applies when it is least needed. The moment a procedure is actually
 * wanted is the moment somebody is filing the failure it was written
 * for — and at that moment they are already typing the class name.
 *
 * **Why the closed vocabulary makes this cheap here.** Matching by
 * keyword would mean guessing; matching by twelve fixed names is a
 * lookup. This is the one place where having spent the effort on
 * `errorclass.mjs` pays a second time.
 *
 * Stored as `on_class`, comma-separated. Unknown names are refused at
 * write time (see bin/mem) rather than silently never firing.
 */
export function triggersOf(entry = {}) {
  const raw = entry.on_class ?? entry.onClass ?? '';
  const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const n = errorclass.normalise(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The procedures in force that name this error class.
 *
 * Retired and closing lines are excluded the same way `mem procedures`
 * excludes them — one reading of "in force", not two.
 */
export function forClass(root, className, { project = null } = {}) {
  const wanted = errorclass.normalise(className);
  if (!wanted) return [];
  const out = [];
  for (const p of [null, ...(project ? [project] : memory.listProjects(root))]) {
    let entries;
    try { ({ entries } = memory.readLog(root, TYPE, { project: p })); }
    catch { continue; }
    const retired = memory.retiredMap(entries);
    for (const e of entries) {
      if (!e.rule || !e.id || !memory.holds(e, retired)) continue;
      if (triggersOf(e).includes(wanted)) out.push({ ...e, _project: p });
    }
  }
  return out;
}

/**
 * A SECOND, keyword lane — beside the class lane above, not instead of
 * it.
 *
 * **Why this needs a lane of its own.** The class lane matches a closed
 * vocabulary of twelve names (`errorclass.mjs`) — cheap because it is a
 * lookup, not a guess. Most procedures are not written against an error
 * class at all ("this is how we name a release", "always ask before
 * touching prod") and never had a way to arm themselves on anything
 * typed at the keyboard. `triggers` closes that gap for the price the
 * outside proposal actually asked for: literal keyword membership, no
 * scoring, no model call.
 *
 * **Why literal substring and not a scorer.** A score needs a
 * threshold nobody can calibrate, and — the whole reason this rewrite
 * exists — the proposal reached for a per-machine USE COUNT to break
 * ties between near-equal scores. That is the exact defect this build
 * removes: identical data plus identical input must offer the same
 * procedures in the same order, on any machine, on any run. Literal
 * substring membership has no such tie: either the keyword is there or
 * it is not.
 *
 * Stored as `triggers`, a JSON array or comma-separated string of
 * literal words/phrases — not run through `errorclass.normalise`,
 * because there is no closed vocabulary to normalise against here.
 */
export function keywordTriggersOf(entry = {}) {
  const raw = entry.triggers ?? entry.trigger_words ?? '';
  const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const p of parts) if (!out.includes(p)) out.push(p);
  return out;
}

/** Does any of this procedure's keywords occur, literally, in `input`? */
export function matchesKeywords(entry, input) {
  const hay = String(input ?? '').toLowerCase();
  if (!hay) return false;
  return keywordTriggersOf(entry).some((kw) => hay.includes(kw));
}

/**
 * Deterministic order for a set of matched procedures: highest
 * authority first, then most recent (`ts` descending), then `id`
 * (ascending) as the final, arbitrary but STABLE break.
 *
 * Never by use count — that is the telemetry this rewrite removes. Two
 * runs against the same files, in either order the entries happen to be
 * read, must produce the identical sequence: that is the determinism
 * the outside proposal claimed and did not keep, because a per-machine
 * counter is by definition not the same on two machines.
 */
export function orderByAuthorityThenRecency(entries) {
  return [...entries].sort((a, b) => {
    const ra = authority.rank(authority.tierOf(a));
    const rb = authority.rank(authority.tierOf(b));
    if (ra !== rb) return ra - rb;
    const ta = a.ts ?? '';
    const tb = b.ts ?? '';
    if (ta !== tb) return ta > tb ? -1 : 1; // newer first
    const ia = String(a.id ?? '');
    const ib = String(b.id ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/**
 * The procedures in force whose `triggers` match something in `input`,
 * ordered by authority then recency (see `orderByAuthorityThenRecency`).
 *
 * Scope mirrors `forClass`: global plus either the one named project or
 * every project — one reading of "in force" between the two lanes.
 */
export function forKeywords(root, input, { project = null } = {}) {
  const hay = String(input ?? '');
  if (!hay.trim()) return [];
  const out = [];
  for (const p of [null, ...(project ? [project] : memory.listProjects(root))]) {
    let entries;
    try { ({ entries } = memory.readLog(root, TYPE, { project: p })); }
    catch { continue; }
    const retired = memory.retiredMap(entries);
    for (const e of entries) {
      if (!e.rule || !e.id || !memory.holds(e, retired)) continue;
      if (matchesKeywords(e, hay)) out.push({ ...e, _project: p });
    }
  }
  return orderByAuthorityThenRecency(out);
}

/**
 * A THIRD lane, beside class and keyword: procedures shown at the start
 * of every SUBAGENT, not because something matched but because a human
 * decided the assignment itself always needs saying.
 *
 * **Why this needs a lane of its own, not another `on_class`/`triggers`
 * value.** Both existing lanes fire on something the CALLER offers (a
 * class being filed, a phrase being typed). A subagent offers nothing
 * of the kind at the moment it starts — no error class, no question
 * text — so a rule that matters for every subagent has no situation to
 * match against. `tags` already exists on every logged entry (see
 * `onboarding.mjs`'s `PROBE_TAG` for the same idiom: one fixed string,
 * looked up, never guessed at); this reuses it rather than adding a
 * fourth field that means the same thing.
 *
 * **Ported from an idea, not a file.** A sibling memory (lucky-mem)
 * built the identical shape under a different name (`verfahren.mjs`,
 * `fuerUnteragenten`) for its own SubagentStart hook. What is ported
 * here is the SHAPE — one fixed tag, materialised entries (never a
 * streaming reader that has not learned about a correction — see the
 * paragraph below), oldest first — not its code and not its rule text:
 * the rules a norm names are this memory's own, set by this memory's
 * own human, never the sibling's.
 *
 * **Why `readLog` + `retiredMap` + `holds`, not a hand-rolled scan.**
 * The sibling's first build read its log with a STREAMING iterator that
 * only ever saw one entry at a time and never learned that a later
 * correction (`replaces_id`) had superseded an earlier one — so a
 * retired rule kept being shown next to the text that replaced it. The
 * fix there was to collect corrections by hand before filtering. That
 * whole class of bug does not exist on this side to begin with: this
 * function reads every procedure the ordinary way, through the same
 * `readLog` + `retiredMap` + `holds` that `forClass` and `forKeywords`
 * two lanes up already use — the checked, single-pass materialisation.
 * A `retiredMap` computed from a partial view is not a `retiredMap`,
 * and there is exactly one function in this codebase that builds one.
 */
export const SUBAGENT_START_TAG = 'subagent-start';

/**
 * The procedures in force that carry `SUBAGENT_START_TAG`, oldest first
 * — the order they were issued in, not the order they sit in the log
 * (a later-filed correction keeps its predecessor's place in time).
 */
export function forSubagentStart(root, { project = null } = {}) {
  const out = [];
  for (const p of [null, ...(project ? [project] : memory.listProjects(root))]) {
    let entries;
    try { ({ entries } = memory.readLog(root, TYPE, { project: p })); }
    catch { continue; }
    const retired = memory.retiredMap(entries);
    for (const e of entries) {
      if (!e.rule || !e.id || !memory.holds(e, retired)) continue;
      const tags = Array.isArray(e.tags) ? e.tags : [];
      if (!tags.includes(SUBAGENT_START_TAG)) continue;
      out.push({ ...e, _project: p });
    }
  }
  // `ts` has one-SECOND resolution (see the entries this repo actually
  // writes), so two procedures logged back to back routinely tie. No id
  // tiebreak: an id is assigned randomly and sorting by it would UNDO
  // insertion order on exactly the ties it is meant to break. A stable
  // sort (guaranteed by the language since ES2019) leaves tied entries
  // in the order `readLog` produced them, which for entries from the
  // same append-only file already IS insertion order.
  out.sort((a, b) => {
    const ta = String(a.ts ?? '');
    const tb = String(b.ts ?? '');
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return out;
}
