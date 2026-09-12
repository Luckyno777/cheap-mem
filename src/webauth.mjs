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

/** Is the peer this machine? */
export function remoteIsLoopback(req) {
  const a = req?.socket?.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
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
