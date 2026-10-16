// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * workflowpointer — the small part of the workflow detection that the final selection of an answer needs
 * (src/answerbudget.mjs), kept apart so the hook that composes an answer does not load the whole detection
 * (the memory, the component table, the tokenizer) for it: reading a card's id and title back out of its
 * text, the pointer form of a card or a tie list, and taking back the "card shown" mark.
 *
 * The card text is made in `src/workflowdetect.mjs` (`cardText`); its closing line carries the id. The round
 * trip is pinned by `test/answer-budget-cm.test.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';

const SHOW_ID = /mem workflow show ([A-Za-z0-9_.-]+) loads it again\)\s*$/;

/** The marks directory of the workflow cards shown in a session. */
export function marksDir(root, env = process.env) {
  return env?.MEM_WORKFLOW_MARKS || path.join(root, '.mem', 'workflow-marks');
}

/** The mark file of a workflow in a session. */
export function markFile(root, session, id, env = process.env) {
  const safe = `${session || 'none'}__${id}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(marksDir(root, env), `${safe}.json`);
}

/** Is `text` a full card (and not a pointer or a tie list)? */
export function isCard(text) {
  return SHOW_ID.test(String(text ?? ''));
}

/**
 * The pointer form of a hook's workflow block: a card becomes its title, id and the command that loads it; a
 * tie list becomes one line. `null` when nothing sensible can be made of the text (a pointer is already short).
 * The title is line 2 of the card, the id is in its closing line.
 */
export function pointerForm(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const tie = /^(\d+) workflows match equally/.exec(t);
  if (tie) return `${tie[1]} workflows match this message equally well; titles: mem workflow list`;
  const m = SHOW_ID.exec(t);
  if (!m) return null;
  const title = (t.split('\n')[1] ?? '').replace(/\s+/g, ' ').trim();
  const short = title.length > 80 ? `${title.slice(0, 79)}…` : title;
  return `Workflow${short ? ` '${short}'` : ''} (${m[1]}) matches; its card did not fit this block. Full card: mem workflow show ${m[1]}`;
}

/**
 * Take back the "card shown" mark of the card in `text`: the final selection turned it into a pointer or left it
 * out, so the session has NOT seen the card, and the next message must offer it again. Nothing for a text that
 * is no card. Fail-quiet (a mark that cannot be removed only means the pointer comes next time).
 */
export function forgetMark(root, text, { session = null, env = process.env } = {}) {
  const m = SHOW_ID.exec(String(text ?? '').trim());
  if (!m || !root) return false;
  try {
    fs.rmSync(markFile(root, session, m[1], env), { force: true });
    return true;
  } catch { return false; }
}
