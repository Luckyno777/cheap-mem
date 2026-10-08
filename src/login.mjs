// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// login.mjs — a password in front of the dashboard (parity with the
// sibling's `src/login.mjs`, 2026-09-28).
//
// **What the owner asked for:** a small login — a black page, one
// password set on the first visit, changeable in the settings the usual
// way: the current password, and the new one twice.
//
// **Where it sits.** BEHIND the existing door (`CHEAP_MEM_SERVE_TOKEN`,
// invisible principle: no token, a bare 404) and IN FRONT of all content.
// It replaces no latch; it adds one.
//
// **First setup — who may set the first password?** "Whoever comes
// first" would be an open flank. Two proofs of ownership are accepted:
//   1. the SETUP CODE the server (or `mem serve setup-code`) creates and
//      keeps ONLY on this machine (file, mode 600); the log says WHERE it
//      is, never the code itself;
//   2. the existing bearer `CHEAP_MEM_SERVE_TOKEN` in the `Authorization`
//      header (tools, tests — a browser never sends it on its own).
// **Loopback is deliberately NOT a proof.** Behind a tunnel whose client
// runs on the same machine (cloudflared, a reverse proxy on localhost),
// EVERY request arrives from 127.0.0.1. "Local = owner" would mean
// "anyone behind the tunnel = owner".
//
// **Storage.** Only a scrypt hash with its own salt, compared with
// `timingSafeEqual`; never plain text, never in a response, never in the
// log. Machine-local and gitignored under `.pipeline/` of the root, mode
// 600, written atomically.
//
// **Sessions.** A random 32-byte token in the cookie `mem_session`
// (HttpOnly, SameSite=Strict, Path=/, Secure behind https/a tunnel); the
// server keeps only its SHA-256. 30 days, sliding (extended at most once
// a day so not every request writes). A password change ends every other
// session; signing out ends this one.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { writeAtomic } from './atomicwrite.mjs';
import * as posixmode from './posixmode.mjs';

export const PATHS = Object.freeze({
  page: '/login',
  setup: '/login/setup',
  logout: '/login/logout',
  change: '/login/password',
});
export const ALL_PATHS = Object.freeze(Object.values(PATHS));

export const COOKIE = 'mem_session';
export const MIN_LENGTH = 10;
export const MAX_LENGTH = 1024;
export const LIFETIME_MS = 30 * 24 * 3600 * 1000;
const EXTEND_AFTER_MS = 24 * 3600 * 1000;
/** Every refused sign-in waits at least this long — the first one too. */
export const DELAY_MS = 400;
/** From this many failures per source the lock starts (exponential). */
export const LOCK_FROM = 3;
export const LOCK_MAX_MS = 15 * 60 * 1000;
/** Across all sources: this many failures lock everyone out for a while. */
export const GLOBAL_LOCK_FROM = 20;
const FORGET_AFTER_MS = 15 * 60 * 1000;

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, length: 64 });

// --- Switch and place ---------------------------------------------------

/** Default: ON. Only `CHEAP_MEM_SERVE_LOGIN=off` (tests, local only) turns it off. */
export function enabled(env = process.env) {
  return String(env.CHEAP_MEM_SERVE_LOGIN ?? '').trim().toLowerCase() !== 'off';
}

/** The machine-local state directory: `.pipeline/` of the root (gitignored). */
export function dirFor(root, env = process.env) {
  return env.CHEAP_MEM_SERVE_LOGIN_DIR
    ? path.resolve(env.CHEAP_MEM_SERVE_LOGIN_DIR)
    : path.join(root, '.pipeline');
}

export function files(dir) {
  return {
    hash: path.join(dir, 'serve-password.json'),
    sessions: path.join(dir, 'serve-sessions.json'),
    code: path.join(dir, 'serve-setup-code'),
  };
}

/**
 * Do the secret files in `dir` have the mode they were written with (0600)?
 * `{ hash, sessions, code }`, each 'private', 'open', 'missing' or
 * 'not-checkable' (Windows: POSIX modes mean nothing there, see posixmode.mjs).
 */
export function modeReport(dir, { platform = process.platform } = {}) {
  const f = files(dir);
  return {
    hash: posixmode.fileState(f.hash, platform),
    sessions: posixmode.fileState(f.sessions, platform),
    code: posixmode.fileState(f.code, platform),
  };
}

/** One line for the user about those modes, or null. */
export function modeNote(dir, opts) {
  return posixmode.note(Object.values(modeReport(dir, opts)), 'the password files');
}

function writePrivate(file, body) {
  writeAtomic(file, body, { mode: 0o600 });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function remove(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// --- The password -------------------------------------------------------

export function hash(secret, salt = randomBytes(16)) {
  const { N, r, p, length } = SCRYPT;
  const h = scryptSync(String(secret), salt, length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return { method: 'scrypt', N, r, p, salt: salt.toString('base64'), hash: h.toString('base64') };
}

export function matches(secret, stored) {
  if (!stored || stored.method !== 'scrypt') return false;
  const salt = Buffer.from(String(stored.salt), 'base64');
  const want = Buffer.from(String(stored.hash), 'base64');
  if (!salt.length || !want.length) return false;
  const got = scryptSync(String(secret), salt, want.length, {
    N: stored.N, r: stored.r, p: stored.p, maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(got, want);
}

export function readHash(dir) {
  const d = readJson(files(dir).hash);
  return d && d.method === 'scrypt' ? d : null;
}

export function isSet(dir) {
  return readHash(dir) !== null;
}

/** One check for a new password, the same for setup and change. */
export function checkNew(next, repeat) {
  const n = String(next ?? '');
  if (n.length < MIN_LENGTH) return `The new password needs at least ${MIN_LENGTH} characters.`;
  if (n.length > MAX_LENGTH) return `The new password may have at most ${MAX_LENGTH} characters.`;
  if (n !== String(repeat ?? '')) return 'The two entries of the new password do not match.';
  return null;
}

/** Sets the password and ends ALL sessions (new generation). */
export function setPassword(dir, next, now = Date.now()) {
  const old = readHash(dir);
  const row = { ...hash(next), set: new Date(now).toISOString(), generation: (old?.generation ?? 0) + 1 };
  writePrivate(files(dir).hash, JSON.stringify(row, null, 2) + '\n');
  writeSessions(dir, {});
}

/** The way out (`mem serve reset-password`): hash, sessions and old code gone. */
export function reset(dir) {
  const f = files(dir);
  const was = remove(f.hash);
  remove(f.sessions);
  remove(f.code); // an old code may have been seen already
  return was;
}

// --- The setup code -----------------------------------------------------

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  const b = randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export function normaliseCode(c) {
  return String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function readSetupCode(dir) {
  try { return fs.readFileSync(files(dir).code, 'utf8').trim() || null; } catch { return null; }
}

/**
 * Creates a code when no password is set and none is lying there. Never
 * returns the code to a caller that could pass it on — only the path and
 * whether it is new. Only the CLI reads the code from disk.
 */
export function ensureSetupCode(dir) {
  const file = files(dir).code;
  if (isSet(dir)) return { needed: false, file };
  if (readSetupCode(dir)) return { needed: true, fresh: false, file };
  writePrivate(file, newCode() + '\n');
  return { needed: true, fresh: true, file };
}

export function codeMatches(dir, given) {
  const want = readSetupCode(dir);
  if (!want) return false;
  const a = createHash('sha256').update(normaliseCode(want)).digest();
  const b = createHash('sha256').update(normaliseCode(given)).digest();
  return timingSafeEqual(a, b) && normaliseCode(given).length > 0;
}

// --- Sessions -----------------------------------------------------------

const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');

function readSessions(dir) {
  const d = readJson(files(dir).sessions);
  return d && typeof d.sessions === 'object' && d.sessions ? d.sessions : {};
}

function writeSessions(dir, sessions, now = Date.now()) {
  const live = Object.fromEntries(Object.entries(sessions).filter(([, s]) => s && s.expires > now));
  writePrivate(files(dir).sessions, JSON.stringify({ sessions: live }) + '\n');
}

export function newSession(dir, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  const s = readSessions(dir);
  s[tokenHash(token)] = { created: now, expires: now + LIFETIME_MS };
  writeSessions(dir, s, now);
  return token;
}

/** { valid, extended } — extended at most once a day. */
export function checkSession(dir, token, now = Date.now()) {
  if (!token || !isSet(dir)) return { valid: false };
  const s = readSessions(dir);
  const e = s[tokenHash(token)];
  if (!e || !(e.expires > now)) return { valid: false };
  if (e.expires - now < LIFETIME_MS - EXTEND_AFTER_MS) {
    e.expires = now + LIFETIME_MS;
    writeSessions(dir, s, now);
    return { valid: true, extended: true };
  }
  return { valid: true, extended: false };
}

export function endSession(dir, token) {
  if (!token) return;
  const s = readSessions(dir);
  const k = tokenHash(token);
  if (!(k in s)) return;
  delete s[k];
  writeSessions(dir, s);
}

// --- Failed attempts ----------------------------------------------------

/**
 * A lock per source, exponential: from the LOCK_FROM-th failure 1 s, 2 s,
 * 4 s … up to LOCK_MAX_MS. Plus a counter across all sources, because
 * behind a tunnel the source comes from a header only the tunnel sets —
 * whoever reached loopback directly could change it. In memory: a
 * restart resets the counters, never the password.
 */
export function newLimiter({ now = () => Date.now() } = {}) {
  const state = new Map();
  const entry = (k) => {
    const e = state.get(k);
    if (e && now() - e.last > Math.max(FORGET_AFTER_MS, e.until - e.last)) { state.delete(k); return null; }
    return e ?? null;
  };
  const lockMs = (n, from) => (n < from ? 0 : Math.min(LOCK_MAX_MS, 1000 * 2 ** (n - from)));
  return {
    /** How long this source still has to wait (0 = may try). */
    wait(source) {
      const t = now();
      return Math.max(0, ...['s:' + source, 'global'].map((k) => (entry(k)?.until ?? 0) - t));
    },
    failure(source) {
      const t = now();
      const out = {};
      for (const [k, from] of [['s:' + source, LOCK_FROM], ['global', GLOBAL_LOCK_FROM]]) {
        const e = entry(k) ?? { n: 0, until: 0, last: t };
        e.n += 1; e.last = t; e.until = t + lockMs(e.n, from);
        state.set(k, e);
        out[k === 'global' ? 'global' : 'source'] = e.n;
      }
      return { attempts: out.source, global: out.global, lockMs: this.wait(source) };
    },
    success(source) { state.delete('s:' + source); },
  };
}

// --- Request helpers ----------------------------------------------------

export function cookieFrom(req, name = COOKIE) {
  const c = String(req?.headers?.cookie ?? '');
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(c);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; } // broken %-sequence: fail closed
}

function isLoopbackAddress(a) {
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** The source for the lock: behind the tunnel, the one Cloudflare names. */
export function sourceOf(req) {
  const a = req?.socket?.remoteAddress ?? '';
  const cf = String(req?.headers?.['cf-connecting-ip'] ?? '').trim();
  return isLoopbackAddress(a) && cf ? cf : (a || 'unknown');
}

/** Secure flag: on https (also behind a tunnel) and on every non-local host. */
export function secureConnection(req) {
  if (req?.socket?.encrypted) return true;
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').toLowerCase();
  if (proto.split(',')[0].trim() === 'https') return true;
  if (/"scheme"\s*:\s*"https"/.test(String(req?.headers?.['cf-visitor'] ?? ''))) return true;
  const host = String(req?.headers?.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '');
}

export function cookieHeader(req, token, maxAgeS = LIFETIME_MS / 1000) {
  return `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; Max-Age=${Math.floor(maxAgeS)}; HttpOnly; SameSite=Strict`
    + (secureConnection(req) ? '; Secure' : '');
}

function readBody(req, cap = 8192) {
  return new Promise((resolve) => {
    let n = 0; const parts = []; let tooMuch = false;
    req.on('data', (c) => { n += c.length; if (n > cap) { tooMuch = true; } else parts.push(c); });
    req.on('end', () => {
      if (tooMuch) return resolve(null);
      const text = Buffer.concat(parts).toString('utf8');
      const type = String(req.headers['content-type'] ?? '');
      if (/json/.test(type)) { try { const j = JSON.parse(text); return resolve(j && typeof j === 'object' ? j : {}); } catch { return resolve({}); } }
      resolve(Object.fromEntries(new URLSearchParams(text)));
    });
    req.on('error', () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- The page -----------------------------------------------------------

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * The sign-in page: black, DM Sans, the dashboard's accent green, one
 * field, one button. NO script — a plain form that works without JS
 * (CSP `script-src 'self'` untouched). Only the one `<style>` block the
 * CSP already allows for the `@font-face` rules.
 */
export function pageHtml({ mode = 'signin', error = '', fontCss = '', mark = '', codeAt = '', notice = '' } = {}) {
  const setup = mode === 'setup';
  const field = (name, label, extra = '') => `<label>${h(label)}<input type="password" name="${name}" required ${extra}></label>`;
  const form = setup
    ? `<form method="post" action="${PATHS.setup}" autocomplete="off">
<p class="text">No password is set yet. Set it now — once, you need the <b>setup code</b>, which lives only on the machine:</p>
<p class="code-at"><code>mem serve setup-code</code>${codeAt ? `<br><span>File: <code>${h(codeAt)}</code></span>` : ''}</p>
<label>Setup code<input type="text" name="code" required autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX"></label>
${field('password', `New password (at least ${MIN_LENGTH} characters)`, `minlength="${MIN_LENGTH}" autocomplete="new-password" autofocus`)}
${field('password2', 'Repeat the new password', `minlength="${MIN_LENGTH}" autocomplete="new-password"`)}
<button type="submit">Set password</button>
</form>`
    : `<form method="post" action="${PATHS.page}">
${field('password', 'Password', 'autocomplete="current-password" autofocus')}
<button type="submit">Sign in</button>
</form>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000000"><meta name="robots" content="noindex"><title>cheap-mem · Sign in</title>
<style>
${fontCss}
:root{--text:#eef2e9;--muted:#a7b8ae;--accent:#bfef95;--line:#2b3d3f;--bad:#ff9a8a;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#000;color:var(--text);font-family:'DM Sans',-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
main{width:100%;max-width:380px}
.mark{width:44px;height:44px;display:block;margin:0 0 22px}
h1{font-size:22px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
.sub{color:var(--muted);font-size:14px;margin:0 0 26px}
.text{color:var(--muted);font-size:14px;line-height:1.5;margin:0 0 12px}
.code-at{font-size:13px;color:var(--muted);margin:0 0 20px;line-height:1.6}
.code-at span{font-size:12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent);font-size:12.5px;word-break:break-all}
form{display:flex;flex-direction:column;gap:14px}
label{display:flex;flex-direction:column;gap:7px;font-size:13px;color:var(--muted)}
input{font:inherit;font-size:16px;color:var(--text);background:#0b0f0e;border:1px solid var(--line);border-radius:10px;padding:12px 14px;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(191,239,149,.18)}
button{font:inherit;font-weight:600;font-size:15px;color:#08130a;background:var(--accent);border:0;border-radius:10px;padding:12px 16px;cursor:pointer;margin-top:6px}
button:hover{filter:brightness(1.06)}
button:focus-visible{outline:2px solid var(--text);outline-offset:2px}
.error{color:var(--bad);font-size:14px;margin:0 0 16px;padding:10px 12px;border:1px solid rgba(255,154,138,.35);border-radius:10px;background:rgba(255,154,138,.06)}
.notice{color:var(--muted);font-size:14px;margin:0 0 16px}
footer{margin-top:28px;font-size:12px;color:#5d6d66}
</style>
</head><body><main>
${mark}
<h1>${setup ? 'Set password' : 'Sign in'}</h1>
<p class="sub">cheap-mem · Dashboard</p>
${error ? `<p class="error" role="alert">${h(error)}</p>` : ''}${notice ? `<p class="notice" role="status">${h(notice)}</p>` : ''}
${form}
<footer>For the owner of this memory only.</footer>
</main></body></html>`;
}

/** After a cross-site navigation (identity-provider round trip) the
 *  browser does not send a SameSite=Strict cookie. Reloading from our own
 *  page is same-site — then it comes along. No script. */
function bouncePage() {
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0">'
    + '<title>cheap-mem</title><body style="background:#000"></body>';
}

// --- The gate -----------------------------------------------------------

/**
 * The one entry for the server. Returns `true` when the request was
 * answered here (a login route, or a refusal), else `false` — then the
 * server serves it as before.
 *
 * @param ctx.dir        state directory (dirFor)
 * @param ctx.token      CHEAP_MEM_SERVE_TOKEN ('' = none)
 * @param ctx.bearer     bearer from the request
 * @param ctx.pagePaths  paths that are an HTML page (→ redirect instead of 401)
 * @param ctx.hostOk     (host) => bool — the existing Host check
 * @param ctx.originOk   (req) => bool — the existing Origin check
 * @param ctx.head       shared security headers
 * @param ctx.csp        content security policy
 * @param ctx.limiter    newLimiter()
 * @param ctx.page       { fontCss, mark }
 * @param ctx.log        (line) => void
 * @param ctx.equal      (a, b) => bool, constant time
 */
export function gate(req, res, url, ctx) {
  const p = url.pathname;
  const bearerOk = Boolean(ctx.token && ctx.bearer && ctx.equal(ctx.token, ctx.bearer));
  const sessionToken = cookieFrom(req);
  const session = checkSession(ctx.dir, sessionToken);
  if (session.extended) res.setHeader('set-cookie', cookieHeader(req, sessionToken));
  const signedIn = session.valid || bearerOk;

  if (ALL_PATHS.includes(p)) {
    handleLoginRoute(req, res, url, ctx, { signedIn, sessionToken, bearerOk }).catch((e) => {
      ctx.log(`serve: ${p} threw: ${e?.message || e}`);
      if (!res.headersSent) sendJson(res, ctx, 500, { state: 'error', reason: 'login-broken' });
    });
    return true;
  }
  if (signedIn) return false;

  const isPage = ctx.pagePaths.includes(p) && (req.method === 'GET' || req.method === 'HEAD');
  if (isPage) {
    const crossSite = String(req.headers['sec-fetch-site'] ?? '') === 'cross-site';
    if (crossSite && sessionToken === '') {
      res.writeHead(200, { ...ctx.head, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ctx.csp })
        .end(bouncePage());
      return true;
    }
    res.writeHead(303, { ...ctx.head, location: PATHS.page }).end();
    return true;
  }
  res.writeHead(401, { ...ctx.head, 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify({ state: 'error', reason: 'login-required', login: PATHS.page }));
  return true;
}

function sendPage(res, ctx, code, opts) {
  const mode = isSet(ctx.dir) ? 'signin' : 'setup';
  let codeAt = '';
  if (mode === 'setup') {
    const e = ensureSetupCode(ctx.dir);
    if (e.fresh) ctx.log(`serve: no password set. The setup code is in ${e.file} (mem serve setup-code)`);
    codeAt = path.relative(ctx.root ?? path.dirname(ctx.dir), e.file).split(path.sep).join('/') || e.file;
  }
  // `same-origin`, not the house's `no-referrer`: under `no-referrer` a
  // browser sends `Origin: null` on a form POST, and the Origin check would
  // refuse our own sign-in form (the sibling met exactly that on 2026-09-26).
  res.writeHead(code, { ...ctx.head, 'referrer-policy': 'same-origin', 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ctx.csp })
    .end(pageHtml({ mode, codeAt, ...ctx.page, ...opts }));
}

function sendJson(res, ctx, code, obj, extra = {}) {
  res.writeHead(code, { ...ctx.head, 'content-type': 'application/json; charset=utf-8', ...extra })
    .end(JSON.stringify(obj));
}

function wantsJson(req) {
  return /application\/json/.test(String(req.headers.accept ?? ''))
    || /application\/json/.test(String(req.headers['content-type'] ?? ''));
}

async function handleLoginRoute(req, res, url, ctx, where) {
  const p = url.pathname;
  const source = sourceOf(req);

  if (p === PATHS.page && (req.method === 'GET' || req.method === 'HEAD')) {
    if (where.signedIn && isSet(ctx.dir)) { res.writeHead(303, { ...ctx.head, location: '/' }).end(); return; }
    sendPage(res, ctx, 200, { notice: url.searchParams.get('signedout') === '1' ? 'Signed out.' : '' });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...ctx.head, allow: 'POST', 'content-type': 'text/plain; charset=utf-8' }).end('POST only');
    return;
  }
  // Writing routes: Host first, then Origin — except with a valid bearer
  // (no browser sends one on its own, so no CSRF path).
  if (!ctx.hostOk(req.headers.host)) { sendJson(res, ctx, 403, { state: 'error', reason: 'foreign-host' }); return; }
  if (!where.bearerOk && !ctx.originOk(req)) {
    ctx.log(`serve: ${p} refused (foreign or missing origin)`);
    sendJson(res, ctx, 403, { state: 'error', reason: 'foreign-origin', text: 'The request did not come from this page.' });
    return;
  }
  const body = await readBody(req);
  if (body === null) { sendJson(res, ctx, 413, { state: 'error', reason: 'too-large' }); return; }

  if (p === PATHS.logout) {
    endSession(ctx.dir, where.sessionToken);
    const heads = { 'set-cookie': cookieHeader(req, '', 0), 'clear-site-data': '"cache"' };
    if (wantsJson(req)) sendJson(res, ctx, 200, { state: 'ok', signedOut: true, next: PATHS.page + '?signedout=1' }, heads);
    else res.writeHead(303, { ...ctx.head, ...heads, location: PATHS.page + '?signedout=1' }).end();
    return;
  }

  const lockedFor = ctx.limiter.wait(source);
  const refuse = async (code, text, counts = true) => {
    if (counts) {
      const f = ctx.limiter.failure(source);
      ctx.log(`serve: ${p} failed attempt (source=${source}, attempts=${f.attempts}, global=${f.global}, lock=${Math.ceil(f.lockMs / 1000)}s)`);
      await sleep(DELAY_MS);
    }
    if (wantsJson(req) || p === PATHS.change) sendJson(res, ctx, code, { state: 'error', reason: text });
    else sendPage(res, ctx, code, { error: text });
  };
  if (lockedFor > 0) {
    res.setHeader('retry-after', String(Math.ceil(lockedFor / 1000)));
    await sleep(DELAY_MS);
    await refuse(429, `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 1000)} s.`, false);
    return;
  }

  if (p === PATHS.page) {
    if (!isSet(ctx.dir)) { await refuse(409, 'No password is set yet.', false); return; }
    const given = String(body.password ?? '');
    if (!given || given.length > MAX_LENGTH || !matches(given, readHash(ctx.dir))) { await refuse(401, 'The password is wrong.'); return; }
    ctx.limiter.success(source);
    const token = newSession(ctx.dir);
    ctx.log(`serve: signed in (source=${source})`);
    const heads = { 'set-cookie': cookieHeader(req, token) };
    if (wantsJson(req)) sendJson(res, ctx, 200, { state: 'ok' }, heads);
    else res.writeHead(303, { ...ctx.head, ...heads, location: '/' }).end();
    return;
  }

  if (p === PATHS.setup) {
    if (isSet(ctx.dir)) { await refuse(409, 'The password is already set. Change it in the settings.', false); return; }
    // Proof: bearer OR setup code. Loopback does not count (tunnel).
    if (!where.bearerOk && !codeMatches(ctx.dir, body.code)) {
      await refuse(403, 'The setup code is wrong. It is on the machine: mem serve setup-code');
      return;
    }
    const flaw = checkNew(body.password, body.password2);
    if (flaw) { await refuse(400, flaw, false); return; }
    setPassword(ctx.dir, String(body.password));
    remove(files(ctx.dir).code);
    ctx.limiter.success(source);
    const token = newSession(ctx.dir);
    ctx.log(`serve: password set up (source=${source}, proof=${where.bearerOk ? 'bearer' : 'code'})`);
    const heads = { 'set-cookie': cookieHeader(req, token) };
    if (wantsJson(req)) sendJson(res, ctx, 201, { state: 'ok', setUp: true }, heads);
    else res.writeHead(303, { ...ctx.head, ...heads, location: '/' }).end();
    return;
  }

  if (p === PATHS.change) {
    if (!where.signedIn || !isSet(ctx.dir)) {
      sendJson(res, ctx, 401, { state: 'error', reason: 'login-required', login: PATHS.page });
      return;
    }
    const current = String(body.current ?? '');
    if (!current || current.length > MAX_LENGTH || !matches(current, readHash(ctx.dir))) { await refuse(403, 'The current password is wrong.'); return; }
    const flaw = checkNew(body.next, body.next2);
    if (flaw) { await refuse(400, flaw, false); return; }
    if (String(body.next) === current) { await refuse(400, 'The new password is the same as the current one.', false); return; }
    setPassword(ctx.dir, String(body.next));
    ctx.limiter.success(source);
    // Every session is gone now — this one gets a new one at once.
    const token = newSession(ctx.dir);
    ctx.log(`serve: password changed, every other session ended (source=${source})`);
    sendJson(res, ctx, 200, { state: 'ok', changed: true }, { 'set-cookie': cookieHeader(req, token) });
    return;
  }
  sendJson(res, ctx, 404, { state: 'error', reason: 'unknown' });
}
