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
