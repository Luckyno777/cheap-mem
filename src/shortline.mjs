// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * shortline — the one-line summary the MCP server prints for an entry
 * (`mem_component`, `mem_links`, `mem_experiences`, `mem_topics`,
 * `mem_facts`). Moved out of `bin/mem-mcp` on 2026-09-30 (O2): the
 * server starts on import, so no probe could hold this line to the ONE
 * body-field source (`src/bodyfields.mjs`). Behaviour otherwise as it was
 * there, plus the body fields it never knew.
 */
import * as procedure from './procedure.mjs';
import * as bidi from './bidi.mjs';
import * as bodyfields from './bodyfields.mjs';
import { maskEntry } from './outputguard.mjs';

/** Body fields `shortLine` renders in a form of its own; the rest comes from `bodyfields.restOfBody`. */
const SHORT_LINE_OWN_FORM = Object.freeze(['title', 'choice', 'text', 'why', 'rule', 'question']);

export function shortLine(e0) {
  // Output guard: key shapes are masked before the line is cut (src/outputguard.mjs).
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
  if (e.rule) parts.push(procedure.mark(e));
  if (e.class) parts.push(`[${e.class}]`);
  if (e.topic) parts.push(`[${e.topic}]`);
  if (e.title) parts.push(e.title);
  // O2: every other body field from the ONE source (src/bodyfields.mjs),
  // the same loop as display.compactLine. Until 2026-09-30 this line knew
  // neither `learning` nor `fact` nor `duty`/`steps` nor `why`.
  parts.push(...bodyfields.restOfBody(e, SHORT_LINE_OWN_FORM));
  if (e.choice) parts.push(`→ ${e.choice}`);
  if (e.text) parts.push(String(e.text).slice(0, 80).replace(/\s+/g, ' '));
  if (e.why) parts.push(`because ${String(e.why).slice(0, 60)}`);
  if (e.rule) parts.push(String(e.rule).slice(0, 120).replace(/\s+/g, ' '));
  if (e.question) parts.push(String(e.question).slice(0, 120).replace(/\s+/g, ' '));
  // Same latch as display.compactLine, and for the same reason: this is
  // the summary line behind mem_component, mem_links, mem_experiences,
  // mem_topics and mem_facts. Before this it carried the identical
  // docblock to compactLine's but never actually called bidi.visible() —
  // every caller here was also saved by textResult()'s own call, but a
  // second latch at the point the summary is actually BUILT means a
  // future caller that returns shortLine()'s result some other way (not
  // through textResult) is still covered, not merely lucky.
  return bidi.visible(parts.join(' — ')) || '(no summary)';
}
