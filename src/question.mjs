// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
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
 *
 * **Who may close it (owner decision, 2026-10-12, variant A).** A
 * question a PERSON asked (tier `user`) is closed only by the person's
 * confirmation - an edge of tier `user`. An agent's `resolves` edge on
 * it records an answer and leaves the question `waiting`: neither open
 * nor closed, and shown as "answered, waits for you". Every other
 * question closes on any valid edge, as before. This is still the one
 * mechanism (the edge) read by the one rule (`authority.mayCloseQuestion`);
 * the third state is derived from the graph, never stored on the question.
 */
import * as memory from './memory.mjs';
import * as authority from './authority.mjs';
import { maskText } from './outputguard.mjs';

export const TYPE = 'question';

/**
 * The three states of a question - derived from the graph, never stored.
 *   open      no `resolves` edge points at it.
 *   waiting   answered, but only by edges below the tier of the person who
 *             asked: it waits for that person's confirmation.
 *   closed    an edge closes it (`authority.mayCloseQuestion`).
 */
export const STATE = Object.freeze({ OPEN: 'open', WAITING: 'waiting', CLOSED: 'closed' });

/** The edge that closes a question. From the existing vocabulary. */
const RESOLVES = 'resolves';

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
 * The state of a question from its own tier and the tiers of the valid
 * `resolves` edges pointing at it - the ONE fold, shared by `all()` and
 * the dashboard's single pass (`src/dashboard-pass.mjs`, which reads the
 * graph as a stream and so only has tiers, not entries).
 */
export function stateFrom(questionTier, edgeTiers) {
  if (!edgeTiers.length) return STATE.OPEN;
  const q = { authority: questionTier };
  return edgeTiers.some((t) => authority.mayCloseQuestion({ authority: t }, q).ok) ? STATE.CLOSED : STATE.WAITING;
}

/**
 * Every question with its state.
 *
 * Open means: no `resolves` edge points at it. Answered means one does,
 * and the answering entry comes along. Whether that answer also CLOSES
 * the question is the rule of `authority.mayCloseQuestion`: a question
 * of tier `user` stays `waiting` until an edge of tier `user` confirms
 * it. `open` stays "no edge at all"; `waiting` is its own flag.
 *
 * The GRAPH is read, not a field on the question — otherwise there
 * would be two truths about one state, and one of them would eventually
 * disagree with the other.
 */
export function all(root, { project = undefined } = {}) {
  const projects = project === undefined ? [null, ...memory.listProjects(root)] : [project];
  const questions = [];
  for (const p of projects) {
    let res;
    try { res = memory.readLog(root, TYPE, { project: p }); } catch { continue; }
    const retired = memory.retiredMap(res.entries);
    for (const e of res.entries) {
      if (e.__broken || !e.question || !e.id) continue;
      if (!memory.holds(e, retired)) continue;
      questions.push({ e, p });
    }
  }
  if (!questions.length) return [];
  // Once, not per question: the entry overview AND the link drawers are
  // read in one pass for all questions (`memory.linksOfMany`; `linksOf` is
  // the same path with one id - one rule, one place).
  const graph = memory.linksOfMany(root, questions.map(({ e }) => e.id), { byId: memory.entriesById(root) });
  return questions.map(({ e, p }) => {
    const answers = graph.get(e.id).incoming.filter((r) => r.kind === RESOLVES).map((r) => ({
      id: r.from, entry: r.entry, edge: r.link?.id ?? null,
      tier: authority.tierOf(r.link), ts: r.link?.ts ?? null,
      closes: authority.mayCloseQuestion(r.link, e).ok,
    }));
    const state = stateFrom(authority.tierOf(e), answers.map((a) => a.tier));
    return {
      ...e,
      _project: p,
      state,
      open: state === STATE.OPEN,
      waiting: state === STATE.WAITING,
      answers,
    };
  });
}

/** Only the open ones. The usual case. */
export function open(root, opt = {}) {
  return all(root, opt).filter((q) => q.open);
}

/** Answered, but waiting for the confirmation of the person who asked. */
export function waiting(root, opt = {}) {
  return all(root, opt).filter((q) => q.waiting);
}

/**
 * Put an answer to a question: one `resolves` edge, nothing else. ONE place
 * for the CLI (`mem answer`, `mem questions confirm`) and the bridge
 * (`mem_answer`), so neither answers the tier question on its own. The caller
 * has already checked the right to claim `user` (`authority.checkUserWrite`
 * and the explicit claim); without a tier the write path stamps `agent`.
 * Returns `{ entry, path, state }`: the state of the question AFTER the edge.
 */
export function answer(root, questionId, withId, {
  why = undefined, agent = undefined, authority: tier = undefined, confirmed = false, project = null,
} = {}) {
  const data = { from: withId, to: questionId, kind: RESOLVES };
  if (why !== undefined && why !== null && why !== '') data.why = String(why);
  if (agent) data.agent = agent;
  if (tier) data.authority = String(tier);
  if (confirmed) data.confirmed = true;
  const { entry, path: p } = memory.logEntry(root, 'link', data, { project });
  const q = all(root).find((x) => x.id === questionId);
  return { entry, path: p, state: q?.state ?? null };
}

/** One line per question — open, answered and waiting, or closed. */
export function line(q) {
  const mark = q.open ? 'open   ' : q.waiting ? 'waiting' : 'closed ';
  const short = maskText(String(q.question)).replace(/\s+/g, ' ').slice(0, 100);
  const ids = q.answers.map((a) => a.id).join(', ');
  const rest = q.open ? ''
    : q.waiting ? `  <- ${ids}  (answered, waits for the person's confirmation)`
      : `  <- ${ids}`;
  return `${mark} ${String(q.id).padEnd(14)} ${short}${rest}`;
}
