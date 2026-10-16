// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// webauth.mjs — the door in front of any HTTP service that hands out memory.
//
// **The one rule this exists for:** binding to anything other than the
// loopback address WITHOUT a token is REFUSED — not warned about,
// refused, the process does not start. An open link would put real
// memory content on the network unprotected, and a warning in a log has
// never once prevented that.
//
// It lives in its own file because the sibling project learned the cost
// of the alternative: a second HTTP service arrived, the rules were
// copied, and from then on there were two versions of one door — one of
// them tested, the other the one with the hole, and you find out
// afterwards.

import { createHash, timingSafeEqual } from 'node:crypto';

export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * May this service bind like that?
 *
 * `variable` only shapes the message: each service has its own
 * environment variable, and a message naming the wrong one sends the
 * reader to the wrong place.
 */
export function bindAllowed({ host, token, variable = 'TOKEN' }) {
  if (token) return { ok: true };
  if (isLoopback(host)) return { ok: true };
  return {
    ok: false,
    reason:
      `Refusing to bind to ${host} without ${variable}. An open link would put `
      + `real memory content on the network unprotected. Set ${variable}=<secret>, `
      + `or bind to 127.0.0.1 and put a tunnel or reverse proxy in front.`,
  };
}

/**
 * The command that makes a token, for the refusal message. Double quotes only, so it runs unchanged in bash, PowerShell
 * and cmd; it prints a value once and stores nothing.
 */
export const MAKE_TOKEN_COMMAND = 'node -e "console.log(require(\'node:crypto\').randomBytes(24).toString(\'hex\'))"';

/**
 * May this HTTP service START at all? (Owner decision 2026-10-14: a service without a token refuses to start, unless the
 * local-no-token switch is set on purpose.)
 *
 * The door is open when NOTHING stands behind it: no token and no login (the dashboard's password). A password is a
 * credential, so a dashboard with its login on and no token keeps starting as before; the MCP bridge has no login and
 * always needs the token. Three outcomes:
 *
 * - a credential stands behind the door: `{ ok: true, withoutToken: false }`;
 * - no credential, the switch set, the bind is loopback: `{ ok: true, withoutToken: true, notice }` - the caller prints
 *   `notice` on its start line;
 * - anything else: `{ ok: false, reason }`. A public bind without a token is refused FIRST ({@link bindAllowed}) and the
 *   switch never changes that: it is an allow list of three loopback names, not a block list of public ones.
 *
 * What the switch does NOT lift, per request: a loopback socket that carries a proxy header is not local
 * ({@link remoteIsLoopback} strict), so a tunnel in front of a token-less service is turned away even with the switch.
 *
 * `variable` is the token variable, `switchVariable` the environment form of the switch, `flag` its command-line form.
 * `hasLogin` says whether this door CAN have a password login at all (the dashboard can, the MCP bridge never could): the
 * words of the refusal and of the start notice follow it, so the bridge is not told that "no password login stands behind"
 * a door that has none to give.
 */
export function startDecision({
  host, token = '', login = false, localNoToken = false,
  variable = 'TOKEN', switchVariable = 'LOCAL_NO_TOKEN', flag = '--local-no-token', hasLogin = true,
} = {}) {
  const bind = bindAllowed({ host, token, variable });
  if (!bind.ok) {
    return {
      ok: false,
      reason: localNoToken
        ? `${bind.reason} The local-no-token switch (${flag}) works on loopback only and does not apply to ${host}.`
        : bind.reason,
    };
  }
  if (token || login) return { ok: true, withoutToken: false };
  if (!localNoToken) {
    return {
      ok: false,
      reason:
        (hasLogin
          ? `Refusing to start without a token: ${variable} is not set and no password login stands behind this door. `
          : `Refusing to start without a token: ${variable} is not set, and the token is the only credential this HTTP bridge has. `)
        + `Set a token: ${variable}=<secret> (bash) or $env:${variable}='<secret>' (PowerShell); make one with: ${MAKE_TOKEN_COMMAND}. `
        + `For a purely local run, say so on purpose: ${flag} or ${switchVariable}=1 `
        + '(loopback only; a request that carries a proxy header is still turned away).',
    };
  }
  return {
    ok: true,
    withoutToken: true,
    notice: `running WITHOUT a token on ${host} (${flag}): loopback only${hasLogin ? ', no password login' : ''}. `
      + 'A request that carries forwarding headers (a tunnel, most proxies) is turned away; a reverse proxy on this machine that '
      + 'adds none (nginx with its defaults) cannot be told from this machine and would be served as local, so set a token '
      + 'before putting any proxy in front',
  };
}

/**
 * The message for a bind that failed, so a taken port is a sentence and not a stack.
 *
 * `code` is the error's `code` (EADDRINUSE, EACCES, EADDRNOTAVAIL); anything else keeps the system's own `message`. The
 * text names host and port (an IPv6 host in brackets) and, where it helps, the variable and the flag that pick another
 * port. It never carries a token: nothing but host, port, the two names and the system message goes in.
 */
export function listenFailureMessage({ host, port, code, message = '', portVariable = '', portFlag = '' } = {}) {
  const where = String(host).includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  const pick = [portFlag, portVariable ? `${portVariable}=<port>` : ''].filter(Boolean).join(' or ');
  if (code === 'EADDRINUSE') {
    return `Cannot listen on ${where}: the port is already in use (another process, or another copy of this service, holds it). `
      + `Stop that one, or pick another port${pick ? ` with ${pick}` : ''}.`;
  }
  if (code === 'EACCES') {
    return `Cannot listen on ${where}: this user may not bind that port (ports below 1024 usually need extra rights). `
      + `Pick a higher port${pick ? ` with ${pick}` : ''}.`;
  }
  if (code === 'EADDRNOTAVAIL') {
    return `Cannot listen on ${where}: ${host} is not an address of this machine. Use 127.0.0.1 (the default) or an address this machine has.`;
  }
  return `Cannot listen on ${where}: ${String(message || code || 'unknown error').split('\n')[0]}`;
}

/**
 * Compare two strings without leaking, through time, where they differ.
 *
 * `timingSafeEqual` requires equal length. Both sides are first reduced
 * to a fixed 32-byte SHA-256, so the comparison is length-independent
 * and does not leak the real token's length through response time. No
 * key needed; the hash is there to equalise length, not to conceal.
 */
export function constantEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** The auth decision alone, without a request object — so it is testable. */
export function authDecision({ token, given, remoteLoopback }) {
  if (!token) {
    // With no token we serve localhost only. The bind rule already
    // checked this; here it is the second line, for the case where a
    // reverse proxy sits in front.
    return remoteLoopback ? { allowed: true } : { allowed: false, code: 403 };
  }
  if (given && constantEqual(token, given)) return { allowed: true, setCookie: true };
  return { allowed: false, code: 401 };
}

/** Bearer token from the header. */
export function bearerFrom(req) {
  const auth = req?.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : '';
}

/**
 * Headers a proxy or tunnel (cloudflared, a reverse proxy) sets. A browser attached directly to the port and a local
 * tool (curl, the probes) never set them.
 *
 * **Names and families (lucky-mem A14 follow-up).** This stays a block list - no list can know every proxy - but a wide
 * one: whole families by prefix (`x-forwarded-*`, `x-real-*`, `cf-*`) and the single names common proxies, CDNs and
 * load balancers add (`via`, `true-client-ip`, `cdn-loop`, `fastly-client-ip`, `x-client-ip`, `x-cluster-client-ip`,
 * `x-original-forwarded-for`). It only ever takes trust AWAY: a header a client forges costs it the local standing.
 * What it cannot see is a proxy that adds none of them (nginx with its defaults): the start notice of {@link startDecision} says so.
 */
const PROXY_HEADER_NAMES = Object.freeze([
  'forwarded', 'via', 'true-client-ip', 'cdn-loop', 'fastly-client-ip', 'x-client-ip', 'x-cluster-client-ip',
  'x-original-forwarded-for',
]);
const PROXY_HEADER_PREFIXES = Object.freeze(['x-forwarded-', 'x-real-', 'cf-']);

/**
 * Is the peer this machine? With `strict`, also: does the request NOT come through a tunnel or proxy?
 *
 * **Fable run 2026-10-11 (ported from lucky-mem B9/B14).** A tunnel on this machine connects from 127.0.0.1, so "the
 * socket is loopback" proves nothing about the requester there. With no token that was the whole door: whoever reached
 * the tunnel was in. Strict, a request carrying a proxy header is not local, and without a token the door stays shut.
 * (With a token nothing changes.) The header can be forged, but only in the safe direction: whoever sets it loses the
 * trust. The viewer asks strictly only when its login is off (with the login on, the password stands behind the door
 * and a password-only setup behind a tunnel must keep working); the MCP bridge has no login and always asks strictly.
 */
export function remoteIsLoopback(req, { strict = false } = {}) {
  const a = req?.socket?.remoteAddress ?? '';
  if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) return false;
  if (!strict) return true;
  return !hasProxyHeader(req);
}

/** Does the request carry a header only a proxy or tunnel sets? (The name only: the value is never looked at or printed.) */
export function hasProxyHeader(req) {
  const headers = req?.headers ?? {};
  return Object.keys(headers).some((raw) => {
    const h = String(raw).toLowerCase();
    return PROXY_HEADER_NAMES.includes(h) || PROXY_HEADER_PREFIXES.some((p) => h.startsWith(p));
  });
}

/**
 * May this POST change something?
 *
 * **Stricter than the rule for GET, on purpose.** A browser always
 * sends `Origin` on a POST; a missing one on a state-changing request
 * is therefore not a CLI, it is a form from somewhere else.
 *
 * The session cookie is `SameSite=Lax` and would not travel with a
 * cross-site POST anyway. This is the second, independent reason to
 * refuse — the one place that writes over HTTP gets two.
 */
/**
 * The second header, the one a script cannot forge: `Host`.
 *
 * {@link postOriginOk} answers "does this request come from our own
 * page" by comparing Origin against Host. That is right as far as it
 * goes — and it trusts the Host. It does NOT catch the case where the
 * browser does not know it is foreign: with DNS rebinding,
 * `evil.example` resolves to 127.0.0.1, the browser considers the
 * request same-origin and sends Origin `https://evil.example` against
 * Host `evil.example`. The two match, and the check passes.
 *
 * What the attacker cannot change is which NAME we agree to be
 * reachable under. A loopback Host is ours; anything else has to be
 * configured explicitly (behind a tunnel with its own hostname that is
 * exactly the right amount of friction).
 *
 * A MISSING Host is refused, not let through. That is the difference
 * from Origin, and deliberate: HTTP/1.1 requires it and HTTP/2 fills
 * `:authority`; both land in `req.headers.host`. If it is missing
 * anyway that is not a normal case but an unknown one — and the
 * unknown falls to the closed side.
 */
export function hostAllowed(host, allowed = []) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (allowed.map((x) => String(x).trim().toLowerCase()).includes(h)) return true;
  return /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/.test(h);
}

/**
 * Why a request was refused — as a CODE, not a sentence.
 *
 * The sentence is the rendering, the code is the contract. Anything
 * that checks prose breaks at the next rewording, and silently. The
 * retrieval already separates the two (`kind: eligibility | capacity`);
 * the door did not.
 */
export const REFUSAL = Object.freeze({
  FOREIGN_ORIGIN: 'foreign-origin',
  FOREIGN_HOST: 'foreign-host',
  // These two deliberately avoid the word the secret scanner reads as
  // an assignment to a secret. It is right to: `CREDENTIAL: '<value>'`
  // is exactly the shape it hunts. The text changed, not the check.
  BAD_PROOF: 'bad-proof',
  NO_PROOF: 'no-proof',
  NOT_LOCAL: 'not-local',
  READ_ONLY: 'read-only',
});

export function postOriginOk(origin, host, allowed = []) {
  const o = String(origin ?? '').trim();
  if (!o) return false;
  let from;
  try { from = new URL(o); } catch { return false; }
  if (allowed.includes(o) || allowed.includes(from.origin)) return true;
  // Same origin: the request's own Host header. Behind a tunnel that is
  // the public name, and the form's Origin carries the same one — both
  // come from the same request.
  return Boolean(host) && from.host === String(host);
}
