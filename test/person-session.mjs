// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A password session for a probe: the dashboard's owner-writing routes (/setting, /inbox/reply,
// /inbox/state, the two verdict routes, the humanOnly task kinds) need one (B6/B7, 2026-10-11).
// Written the way the server writes it (src/login.mjs), so the probe goes through the real check.
import * as login from '../src/login.mjs';

/** Sets a password for `root` and returns the cookie header value of a fresh session. */
export function personCookie(root, env = process.env) {
  const dir = login.dirFor(root, env);
  if (!login.isSet(dir)) login.setPassword(dir, 'a-proper-long-password');
  return `${login.COOKIE}=${login.newSession(dir)}`;
}
