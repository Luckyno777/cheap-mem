// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * startblock — the alarm and the day line of the session start, from ONE reading of the memory.
 *
 * **Why (startblock-cm, 2026-10-18).** The session-start hook asked the memory three times in a row, each in a process of its
 * own: `mem context`, `mem doctor --alarm` and `mem today --line`. The last two both ran the whole doctor (`checkAll`) - the day's
 * "operations" part IS the doctor's result - and `--alarm` then read every drawer once more to move the rollback mark. Measured
 * on a warm 5 000-entry memory, in passes over the entry logs: 0.55 + 2.01 + 1.09 = 3.65; on a cold one (no index yet) the alarm
 * alone took 15.6 s at 20 000 entries and hit its 8 s cap, so the red line it exists for was missing without a word.
 *
 * **What it is.** The same two answers, computed once: the doctor runs ONCE (the result `mem doctor --alarm` would have used, with
 * the mark ticked as before), the day result is derived from it (`doctor.dayResultFrom` names the two findings that are read
 * the way `mem today` saw them), and everything runs inside one drawer memo. The text is exactly what the hook printed from the
 * two commands: the alarm block, a blank line, the day line. Nothing here decides anything new.
 *
 * **Three states stay three.** No config: the alarm part still answers (the doctor never needed one), the day part is left out
 * (`mem today` demanded a config and printed nothing). A part that throws is left out, the other one stays.
 */
import * as doctor from './doctor.mjs';
import * as today from './today.mjs';
import * as cfg from './config.mjs';

/** The heading the hook has always printed above the alarm lines. */
export const ALARM_HEADING = '=== DOWN RIGHT NOW (mem doctor --alarm) ===';

/**
 * `{ alarm: string[], line: string|null, text: string }`. `text` is `''` when nothing is red and nothing is notable;
 * otherwise the alarm block (heading + lines), a blank line when both parts exist, and the day line - what the hook prints.
 */
export function startBlock(root, { env = process.env, now = new Date() } = {}) {
  let alarm = [];
  let line = null;
  doctor.withRunMemo(() => {
    let result = null;
    try {
      // As `mem doctor --alarm` runs it: no probe, a measured verdict read back, then the mark ticked.
      result = doctor.checkAll(root, { full: false, record: true });
      doctor.tickEpoch(root, result);
      alarm = doctor.alarm(result);
    } catch { /* the alarm part is left out; the day part below may still answer */ }
    try {
      cfg.readConfig(root); // `mem today` stopped here without a config
      const day = result ? doctor.dayResultFrom(root, result) : null;
      line = today.today(root, { env, now, doctorResult: day }).line ?? null;
    } catch { /* the day part is left out */ }
  });
  const parts = [];
  if (alarm.length) parts.push([ALARM_HEADING, ...alarm].join('\n'));
  if (line) parts.push(line);
  return { alarm, line, text: parts.join('\n\n') };
}
