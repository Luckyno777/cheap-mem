// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * yesno — the ONE reading of a yes / no value for the switches that take one (H11, card-rule-doctor-cm).
 *
 * A LEAF, no imports. `yes`, `true`, `1` are yes; `no`, `false`, `0` are no (case and blanks do not matter). Anything else is
 * NOT a guess: `null`, and the caller decides what an unrecognised value means (the card rule says so once per process and
 * stays in stage 1). The same words as the sibling house's `jaNeinWert`, in English.
 *
 * Older switches read their own list (`on` / `off`, a table of `0` / `no` / `false`); they are left as they are. A new yes / no
 * switch reads here.
 */

// invariant: eine-regel-eine-stelle

const YES = Object.freeze(['yes', 'true', '1']);
const NO = Object.freeze(['no', 'false', '0']);

/** `true` for yes / true / 1, `false` for no / false / 0, `null` for everything else. */
export function yesNoValue(value) {
  const w = String(value ?? '').trim().toLowerCase();
  if (YES.includes(w)) return true;
  if (NO.includes(w)) return false;
  return null;
}
