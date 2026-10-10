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

/**
 * The directory that holds the MAIN checkout when `root` is a linked git
 * worktree, else `null`. A linked worktree has a `.git` FILE reading
 * `gitdir: <main>/.git/worktrees/<name>`; the main checkout is two levels
 * above that `worktrees/<name>` directory's parent. Read with `node:fs`
 * only (this module stays dependency-free).
 */
function mainCheckoutOf(root) {
  try {
    const text = fs.readFileSync(path.join(root, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return null;
    const gitdir = path.resolve(root, m[1]);
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const at = gitdir.lastIndexOf(marker);
    return at > 0 ? gitdir.slice(0, at) : null;
  } catch { return null; }
}

/**
 * Candidates, in order: beside `root`; and, when `root` is a linked
 * worktree, beside the MAIN checkout it was made from. No fixed machine
 * path: a path that only exists on one person's machine (the cloud box,
 * the VM) has no business in code that ships to strangers — on a
 * stranger's machine it would at best be dead, at worst point at
 * somebody else's directory (test/fixed-paths-ratchet.test.mjs).
 */
export function siblingClone(root, given = null) {
  const main = mainCheckoutOf(root);
  const places = given ? [given] : [
    path.join(path.dirname(root), 'lucky-mem'),
    ...(main ? [path.join(path.dirname(main), 'lucky-mem')] : []),
  ];
  return places.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}
