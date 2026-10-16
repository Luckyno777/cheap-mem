// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * recallconfig - ONE resolved configuration per recall question (abruf-stamm-cm, step 1; port of the sibling
 * house's `abrufKonfig`).
 *
 * **The finding.** `mem find` read its switches from the process environment at six different places
 * (`MEM_SEARCH_LEVERS` for h1 and h3 - twice, `MEM_RETRIEVE_REQUEST_FRAME`, `MEM_RETRIEVE_TIE`, `MEM_TZ`) and
 * the index load read two more (`MEM_REWRITES`, `CHEAP_MEM_STATE_SIGNAL_WORDS`). On the direct path that is the
 * environment of the asking hook, so nobody noticed. On the WARM path (M10, `src/recallserver.mjs`) the same
 * handler runs inside the long-lived server process: the environment of the SERVICE decided, not the one of
 * the session that asked. A session with `MEM_SEARCH_LEVERS=off` or `MEM_RETRIEVE_TIE=0.01` got the other
 * answer as soon as a server ran, and nothing said so (the journal only books `path: server`).
 *
 * **The rule now.** The handler resolves once, at its entry, from an environment it is GIVEN (the process
 * environment on the direct path, the slice the client sent on the warm path), and everything below reads the
 * resolved object. `forwardedEnv` (src/recallserver-place.mjs, built-ins only, so the client stays light) is the
 * list of names that travel; the server takes nothing else from a request.
 */
import * as levers from './searchlevers.mjs';
import { requestFrameOn } from './requestframe.mjs';
import { tieSpread } from './tiecut.mjs';
import { forwardedEnv } from './recallserver-place.mjs';

/**
 * @param {object} [env] where the switches are read: the process environment, or the slice a client sent
 * @returns {Readonly<{ env: object, levers: Set<string>, requestFrame: boolean, tie: number, zone: string|undefined }>}
 *   `env` is the slice itself (what the index load re-reads for its two attachments); the rest is resolved.
 */
export function resolve(env = process.env) {
  const slice = forwardedEnv(env);
  return Object.freeze({
    env: Object.freeze(slice),
    levers: levers.leverState(slice).on,
    requestFrame: requestFrameOn(slice),
    tie: tieSpread(slice),
    zone: slice.MEM_TZ || undefined,
  });
}
