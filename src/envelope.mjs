// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * envelope — what a message INTENDS, and the one rule that decides
 * whether it may wake a model.
 *
 * Ported from lucky-mem (src/umschlag.mjs, Block S: S2 intent and one
 * wake rule, S4 permission, the turn budget). Before this, `mem watch`
 * woke the handler — a fresh `claude -p` run, paid for — on EVERY new
 * message: a broadcast note, a thank-you, a receipt. Each of those cost
 * a model call nobody asked for.
 *
 * Three optional headers, all absent on older mail and read as `null`
 * (an old message never becomes unreadable):
 *
 *   Intent: information|request|read|result|clarification|cancel
 *   Turn: <n> of <max>      how deep in a reply chain this message is
 *   From-Route / To-Route   which registered SESSION of a role (routes.mjs)
 *
 * **Intent instead of switches.** `information` never wakes. `request`
 * and `clarification` ask for an answer and wake. `read` wakes and asks
 * the recipient to read it, without an answer. `result` closes a request
 * and never wakes; `cancel` never wakes. A missing Intent is derived, in
 * this order: `In-Reply-To` set -> `result`, otherwise `information`. So
 * a receipt or a reply never wakes anyone unless its writer said so.
 *
 * **Waking still needs permission (S4).** A waking intent is necessary,
 * never sufficient: `wakes()` asks a permission checker last
 * (`mailpermit.checker`). No checker -> no wake (fail closed).
 *
 * No model anywhere in this file — the decision is a few comparisons.
 */

export const INTENTS = Object.freeze(['information', 'request', 'read', 'result', 'clarification', 'cancel']);

/**
 * Intents that wake the recipient (each still needs permission or a
 * budget). `request`/`clarification` ask for an answer, `read` does not.
 */
const WAKING_INTENTS = Object.freeze(['request', 'read', 'clarification']);

/**
 * The turn budget: how many replies deep a chain may go before nothing
 * in it wakes anyone again. Two agents that answer every answer with a
 * new request would otherwise ping-pong until a budget is empty; at
 * turn 7 of 6 the chain stops waking, whatever the permission says.
 * Same number as lucky-mem's ZUG_MAX.
 */
export const TURN_MAX = 6;

const ROUTE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TURN_PATTERN = /^(\d{1,4}) of (\d{1,4})$/;

/** True for a route id (an opaque UUID, see routes.mjs). */
export function isRouteId(v) { return typeof v === 'string' && ROUTE_PATTERN.test(v); }

/**
 * Header lines for the optional envelope fields, in a fixed order.
 * Throws on a bad value — a typo must not silently become `information`.
 */
export function headerLines({ intent = null, turn = null, turnMax = null, fromRoute = null, toRoute = null } = {}) {
  const lines = [];
  if (intent !== null) {
    if (!INTENTS.includes(intent)) {
      throw new Error(`Intent is one of ${INTENTS.join('|')}, not: ${JSON.stringify(intent)}`);
    }
    lines.push(`Intent: ${intent}`);
  }
  if (turn !== null) {
    const max = turnMax === null ? TURN_MAX : turnMax;
    if (!Number.isInteger(turn) || turn < 1 || turn > 9999) throw new Error(`Turn is a whole number from 1, not: ${JSON.stringify(turn)}`);
    if (!Number.isInteger(max) || max < 1 || max > 9999) throw new Error(`Turn maximum is a whole number from 1, not: ${JSON.stringify(max)}`);
    lines.push(`Turn: ${turn} of ${max}`);
  }
  if (fromRoute !== null) {
    if (!isRouteId(fromRoute)) throw new Error(`From-Route is a route id, not: ${JSON.stringify(fromRoute)}`);
    lines.push(`From-Route: ${fromRoute}`);
  }
  if (toRoute !== null) {
    if (!isRouteId(toRoute)) throw new Error(`To-Route is a route id, not: ${JSON.stringify(toRoute)}`);
    lines.push(`To-Route: ${toRoute}`);
  }
  return lines;
}

/**
 * The envelope of a parsed header object (`{Field: value}`). Unknown
 * intent values read as `unknown` and wake nobody (better nothing than
 * something wrong); a malformed Turn reads as no turn.
 */
export function fromHeader(header = {}) {
  let intent;
  let intentSource;
  if (Object.hasOwn(header, 'Intent')) {
    const raw = String(header.Intent ?? '').trim().toLowerCase();
    intent = INTENTS.includes(raw) ? raw : 'unknown';
    intentSource = 'header';
  } else if (Object.hasOwn(header, 'In-Reply-To')) {
    intent = 'result';
    intentSource = 'derived';
  } else {
    intent = 'information';
    intentSource = 'default';
  }
  const t = Object.hasOwn(header, 'Turn') ? TURN_PATTERN.exec(String(header.Turn)) : null;
  const fr = header['From-Route'];
  const tr = header['To-Route'];
  return {
    intent,
    intentSource,
    turn: t ? Number(t[1]) : null,
    turnMax: t ? Number(t[2]) : null,
    fromRoute: isRouteId(fr) ? fr : null,
    toRoute: isRouteId(tr) ? tr : null,
  };
}

/**
 * The turn of a reply to `original`: one deeper, same maximum. The
 * first message of a chain carries no Turn and counts as turn 0.
 */
export function replyTurn(original) {
  const turn = (Number.isInteger(original?.turn) ? original.turn : 0) + 1;
  const turnMax = Number.isInteger(original?.turnMax) ? original.turnMax : TURN_MAX;
  return { turn, turnMax };
}

export const WAITING = 'waiting-for-permission';

/**
 * May this message wake a model? THE one rule, for the watcher's remote
 * look (`inbox.watch`), the local decision after the pull (`mem inbox
 * wake`) and the headless listing (`inbox.newFor`).
 *
 * `{ wakes, reason, detail?, permit? }` — the reason is always named,
 * the yes included. Cheap form checks first (recipient, state, intent,
 * turn), the permission LAST: it reads a file.
 *
 * `human` is a predicate on the recipient name: no machine wakes the
 * human, they read their own mail, so a message to them never waits
 * for permission (`reason: 'to-human'`).
 */
export function wakes(m, { forRole = null, permit = null, human = () => false } = {}) {
  if (forRole && m.to !== forRole) return { wakes: false, reason: 'not-for-me' };
  if (m.state && m.state !== 'open') return { wakes: false, reason: `state-${m.state}` };
  const intent = m.intent ?? 'information';
  if (!WAKING_INTENTS.includes(intent)) return { wakes: false, reason: `intent-${intent}` };
  if (human(m.to)) return { wakes: false, reason: 'to-human' };
  if (Number.isInteger(m.turn) && Number.isInteger(m.turnMax) && m.turn > m.turnMax) {
    return { wakes: false, reason: 'turn-budget-spent' };
  }
  if (typeof permit !== 'function') {
    return { wakes: false, reason: WAITING, detail: 'no permission check (fail closed)' };
  }
  let p;
  try { p = permit(m); } catch (e) {
    return { wakes: false, reason: WAITING, detail: `permission unreadable: ${e.message}` };
  }
  if (!p || p.allowed !== true) return { wakes: false, reason: WAITING, detail: p?.reason ?? null };
  return { wakes: true, reason: 'yes', permit: p };
}
