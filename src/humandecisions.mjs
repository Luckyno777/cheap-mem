// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * humandecisions — THE source for "what waits on the human to decide" (H11, card-rule-doctor-cm).
 *
 * `today.decisionsForHuman` (the day part, `mem today`, the session-start line, the dashboard) and the doctor finding
 * `decision-without-explanation` count with THIS function, not with one calculation each: two counts of one thing drift apart.
 * It stands in a module of its own because the doctor needs it and `today.mjs` imports the doctor (`doctorMod`) — a ring if the
 * function lived in `today.mjs`. `today.decisionsForHuman` is a thin call.
 *
 *   `forHuman`      open duties whose addressee (`who`, else `owner`, else `to`; trimmed, `addressee.ofDuty`) is the configured
 *                   human, each with its card (`decisioncard.cardOf`). This is what the day part shows.
 *   `withQuestions` the same PLUS the open questions whose `who` is the human (owner decision 2026-10-13, 19po2xtvp7ae: a question
 *                   can carry an addressee). `mem today` does not list these yet — that would change the number on the session-start
 *                   line and is the owner's call (reported as open); the rule and the doctor count them.
 *
 * **Three states.** What cannot be read is `readable: false` with a reason — never a quiet empty list.
 * **No names.** The human comes from `.mem/config.json` (`config.humanParticipant`).
 */

// invariant: eine-regel-eine-stelle
// invariant: nicht-messbar-ist-nicht-null

import * as memory from './memory.mjs';
import * as dueCore from './due.mjs';
import * as cfgmod from './config.mjs';
import * as cardstore from './cardstore.mjs';
import * as decisioncard from './decisioncard.mjs';
import * as question from './question.mjs';
import * as addressee from './addressee.mjs';

/** The shelf as the callers want it: handed in, else read here; not readable gives an empty one (every item gets its fallback card). */
function shelfOf(root, cards) {
  if (cards !== undefined) return cards;
  try { return cardstore.latestCards(root); } catch { return new Map(); }
}

/** The duty fold, read: `memory.openDuties()`. THROWS when the drawers cannot be read. */
function readFold(root) { return memory.openDuties(root); }

/** A fold handed in by the caller (it read the drawers ONCE for the whole day result): `{ open }`, or `{ error }` when that read failed. */
function foldOrThrow(fold) {
  if (fold?.error) throw fold.error instanceof Error ? fold.error : new Error(String(fold.error));
  if (!Array.isArray(fold?.open)) throw new Error('no duty fold handed in');
  return fold;
}

/**
 * Open duties addressed to the human, oldest first, each `{id, title, due, since, card}`. `human` names him (else the configured
 * one). `cards`: the shelf (Map target_id -> card), handed in to be read once per result. `fold`: the open duties
 * (`memory.openDuties()`, or `{ error }` when that read failed) that the caller already read, so one day result passes over the
 * duty drawer ONCE (`today.today`); without it the drawer is read here. `now` and `zone`: with both, each decision carries
 * `dueState` (the core's verdict on its due date); without them it is null.
 * @returns {{readable: boolean, reason: string|null, who?: string, list: object[]}}
 */
export function forHuman(root, { human = null, cards = undefined, fold = undefined, now = undefined, zone = undefined } = {}) {
  let who = human === null ? null : addressee.nameOf(human);
  if (who === null) {
    let cfg;
    try { cfg = cfgmod.readConfig(root); } catch (e) {
      return { readable: false, reason: `config not readable: ${e?.message || e}`, list: [] };
    }
    const h = cfgmod.humanParticipant(cfg.participants);
    if (!h.name) return { readable: false, reason: h.reason, list: [] };
    who = h.name;
  }
  let open;
  try { open = (fold === undefined ? readFold(root) : foldOrThrow(fold)).open; } catch (e) {
    return { readable: false, reason: `duties not readable: ${e?.message || e}`, list: [] };
  }
  const shelf = shelfOf(root, cards);
  const list = open
    .filter((p) => addressee.ofDuty(p) === who)
    .map((p) => ({
      id: p.id, title: p.title ?? p.text ?? p.id, due: dueCore.dueText(p), since: dueCore.openSince(p),
      // The state of its due date, from the core (fresh | due | overdue | unknown), only when the caller names the clock and the
      // zone; null for a duty without a due date. A surface shows it as a chip next to the decision.
      dueState: zone !== undefined && now !== undefined && dueCore.dueValue(p) !== null
        ? dueCore.state(dueCore.dueValue(p), now, { zone }) : null,
      card: decisioncard.cardOf(p, { type: 'duty', context: { cards: shelf, human: who } }),
    }))
    .sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')));
  return { readable: true, reason: null, who, list };
}

/**
 * `forHuman` plus the open questions addressed to the human. Every item carries `kind` (`duty` | `question`). A question item is
 * `{kind, id, title (the question), due: null, since (its ts), card}`.
 * @returns {{readable: boolean, reason: string|null, who?: string, list: object[]}}
 */
export function withQuestions(root, { human = null, cards = undefined } = {}) {
  const duties = forHuman(root, { human, cards });
  if (!duties.readable) return duties;
  let open;
  try { open = question.open(root, { who: duties.who }); } catch (e) {
    return { readable: false, reason: `questions not readable: ${e?.message || e}`, list: [] };
  }
  const shelf = shelfOf(root, cards);
  const asked = open
    .filter((q) => addressee.ofQuestion(q) === duties.who)
    .map((q) => ({
      kind: 'question', id: q.id, title: q.question ?? q.id, due: null, since: q.ts ?? null,
      card: decisioncard.cardOf(q, { type: 'question', context: { cards: shelf, human: duties.who } }),
    }));
  const list = [...duties.list.map((d) => ({ kind: 'duty', ...d })), ...asked]
    .sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')));
  return { readable: true, reason: null, who: duties.who, list };
}
