/**
 * Open questions as a memory class of their own.
 *
 * **The finding (2026-09-08).** Across the ten entry types there was
 * none for "we do not know this". Everything the memory could hold was
 * KNOWN: a decision, an error, a learning, a duty. This was the only
 * genuinely new proposal out of two rounds of ideas.
 *
 * **Why not a state on `duty`.** A duty has a DEBTOR and a lifecycle —
 * it is somebody's job and counts as neglected when it sits. An open
 * question has no owner and may never be answered without anybody
 * having done anything wrong. Filing it under `duty` would manufacture
 * a pile of apparently neglected work and make the duty board useless.
 *
 * **Why its own type and not a `thought` with a question mark.**
 * Because the point is to retrieve them as a CLASS: "what do we not
 * know about X?" That only works with a drawer of its own. A question
 * mark inside a thought is not queryable.
 *
 * **Why no lifecycle of its own.** A question closes when something
 * else answers it — and the `resolves` edge already exists for that. A
 * second mechanism would say the same thing twice, and two truths
 * about one state drift apart.
 */
import * as memory from './memory.mjs';

export const TYPE = 'question';

/** The edge that closes a question. From the existing vocabulary. */
export const RESOLVES = 'resolves';

/**
 * Check the fields. A question needs exactly one thing: the question.
 *
 * `why` is optional and stays optional. A mandatory "why does this
 * matter" sounds diligent and costs the very gesture at stake: a
 * question gets noted in passing or not at all.
 */
export function check(fields = {}) {
  const errors = [];
  const warnings = [];
  const q = String(fields.question ?? '').trim();
  if (!q) errors.push('question missing — that is the text somebody is meant to answer');
  else if (!q.includes('?')) {
    // A warning, not an abort: some questions are written flat
    // ("unclear whether the tunnel is doubled"), and refusing those
    // would be formalism.
    warnings.push('the question has no question mark — sure this is a question?');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Every question with its state.
 *
 * Open means: no `resolves` edge points at it. Answered means one does,
 * and the answering entry comes along.
 *
 * The GRAPH is read, not a field on the question — otherwise there
 * would be two truths about one state, and one of them would eventually
 * disagree with the other.
 */
export function all(root, { project = undefined } = {}) {
  const projects = project === undefined ? [null, ...memory.listProjects(root)] : [project];
  const out = [];
  for (const p of projects) {
    let res;
    try { res = memory.readLog(root, TYPE, { project: p }); } catch { continue; }
    const retired = memory.retiredMap(res.entries);
    for (const e of res.entries) {
      if (e.__broken || !e.question || !e.id) continue;
      if (retired.has(e.id) || memory.isClosingLine(e)) continue;
      const g = memory.linksOf(root, e.id);
      const answers = g.incoming.filter((r) => r.kind === RESOLVES);
      out.push({
        ...e,
        _project: p,
        open: answers.length === 0,
        answers: answers.map((r) => ({ id: r.from, entry: r.entry })),
      });
    }
  }
  return out;
}

/** Only the open ones. The usual case. */
export function open(root, opt = {}) {
  return all(root, opt).filter((q) => q.open);
}

/** One line per question — open or answered. */
export function line(q) {
  const mark = q.open ? 'open   ' : 'closed ';
  const short = String(q.question).replace(/\s+/g, ' ').slice(0, 100);
  const rest = q.open ? '' : `  <- ${q.answers.map((a) => a.id).join(', ')}`;
  return `${mark} ${String(q.id).padEnd(14)} ${short}${rest}`;
}
