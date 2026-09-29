// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Where does the sibling house's clone live — if it sits beside us at all?
 *
 * Returns the root path or `null`. `null` means "not here", not "does
 * not exist": the cross-house check then stays quiet instead of raising
 * a warning that would fire without cause on every CI machine. A
 * warning that keeps coming for no reason teaches people to skip the
 * output.
 *
 * No configuration: a path you have to enter is a path nobody enters.
 *
 * **Dependency-free on purpose (agent/parity-to-src, 2026-09-29).** This
 * module imports only `node:fs` and `node:path` — nothing under `src/`
 * or `bench/`. `src/parity.mjs` needs this lookup and must never import
 * `src/doctor.mjs` (that is exactly the cycle
 * doctor -> bench/parity -> doctor that made an installed `mem doctor`
 * crash with ERR_MODULE_NOT_FOUND, since `bench/` ships in no package).
 * Keeping `siblingClone` here, with no imports of its own, is what lets
 * both `doctor.mjs` and `parity.mjs` use it without either importing
 * the other.
 */
import fs from 'node:fs';
import path from 'node:path';

export function siblingClone(root, given = null) {
  const places = given ? [given] : [
    path.join(path.dirname(root), 'lucky-mem'),
    '/home/user/lucky-mem',
    '/work/lucky-mem',
  ];
  return places.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}
