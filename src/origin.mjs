// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/origin.mjs — WHERE did this session run? A closed vocabulary for the
// injection journal (field `origin`; port of lucky-mem's `ort`, ceb244cb).
//
// Why: without it a journal line cannot be split into "from a cloud session"
// and "from a local one", and a rate such as the warm-server share cannot be
// read. One truth: the same signals `detectSurface()` in src/raw.mjs uses;
// that function asks here. No imports, so the journal loads this without a chain.
//
// Only the CLASS value is booked, never a hostname or identifier. `unknown`
// instead of wrong: a missing or foreign value is `unknown`.

/** Closed list. A new value is a decision and belongs in the diff. */
export const ORIGINS = Object.freeze({
  CLOUD: 'cloud',
  SSH: 'ssh',
  LOCAL: 'local',
  UNKNOWN: 'unknown',
});
const ORIGIN_VALUES = new Set(Object.values(ORIGINS));

/** Any value (also from an old line without the field) onto the list. */
export function originNormal(value) {
  return typeof value === 'string' && ORIGIN_VALUES.has(value) ? value : ORIGINS.UNKNOWN;
}

/**
 * Derive the origin from the environment: deterministic, no network.
 * Order as in `detectSurface()`: the MEM_SURFACE override (only a value of
 * the list counts, anything else is `unknown`), then cloud
 * (CLAUDE_CODE_REMOTE), then ssh (SSH_CONNECTION), otherwise `local`.
 */
export function originFrom({ env = process.env } = {}) {
  const override = env.MEM_SURFACE;
  if (override) return originNormal(override);
  if (env.CLAUDE_CODE_REMOTE) return ORIGINS.CLOUD;
  if (env.SSH_CONNECTION) return ORIGINS.SSH;
  return ORIGINS.LOCAL;
}
