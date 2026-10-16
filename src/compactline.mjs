// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The one-line rendering of an entry (`compactLine`) — the shared renderer
 * behind `mem find`, `mem when`, `mem component`, the hooks and the bridge.
 *
 * Lives in its own small module since 2026-10-14 (hooks-harden-cm, TB5):
 * the before-edit hook renders labels in ONE node process and must not pay
 * for the whole CLI display layer (retrieval, time search, shell) to get
 * at one function. `src/cli/display.mjs` re-exports it unchanged, so every
 * caller keeps its import.
 */

import * as procedure from './procedure.mjs';
import * as bidi from './bidi.mjs';
import { maskEntry } from './outputguard.mjs';
import * as bodyfields from './bodyfields.mjs';

/** Body fields `compactLine` renders in a form of its own; the rest comes from `bodyfields.restOfBody`. */
const OWN_FORM = Object.freeze(['title', 'choice', 'text', 'why', 'rule', 'question']);

export function compactLine(e0, { root = null } = {}) {
  // Output guard: known key shapes are masked BEFORE anything is cut. A cut
  // in the middle of a key would leave a rest no pattern recognises any more.
  // This is the shared renderer behind `mem find`, `mem when`, the hooks and
  // the bridge; one place protects all of them.
  const e = e0 && typeof e0 === 'object' ? maskEntry(e0) : e0;
  const parts = [];
  // **A procedure never comes out without its marking.**
  //
  // Its text is instruction-shaped. Without the "issued by X on Y"
  // prefix the next agent reads it as a fact and follows it, never
  // having known that somebody set it — or who. The latch lives in the
  // DISPLAY, not in the caller: there are several display paths, and a
  // guarantee each of them has to keep on its own is only as strong as
  // the sloppiest one.
  // The status is stamped by the ONE function in procedure.mjs (X3b); without
  // a root it cannot be read, and the line stays as it was.
  if (e.rule) parts.push(procedure.mark(procedure.stampStatus(root, e)));
  if (e.class) parts.push(`[${e.class}]`);
  if (e.topic) parts.push(`[${e.topic}]`);
  if (e.title) parts.push(e.title);
  // O2: every other body field from the ONE source (src/bodyfields.mjs).
  // Until 2026-09-30 this line knew neither `learning` nor `fact` nor
  // `duty`/`steps`: a learning with a title showed as its title alone.
  parts.push(...bodyfields.restOfBody(e, OWN_FORM));
  if (e.choice) parts.push(`→ ${e.choice}`);
  // mask-ok: `e` is a maskEntry copy (see the top of compactLine)
  if (e.text) parts.push(String(e.text).slice(0, 80).replace(/\s+/g, ' '));
  if (e.why) parts.push(`because ${String(e.why).slice(0, 60)}`);
  if (e.rule) parts.push(String(e.rule).slice(0, 120).replace(/\s+/g, ' '));
  if (e.question) parts.push(String(e.question).slice(0, 120).replace(/\s+/g, ' '));
  // Same reasoning as the procedure mark just above, same latch site:
  // this is THE shared renderer behind `mem find`, `mem component`
  // (which is what the PreToolUse hook reads as `h.label`), `mem when`
  // and the board — one call here closes all of them at once, where
  // fixing each caller separately would only be as strong as the one
  // someone forgot.
  return bidi.visible(parts.join(' — ')) || '(no compact text)';
}
