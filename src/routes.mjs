// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * routes — WHICH session of a role a message is for.
 *
 * Ported from lucky-mem (src/routen.mjs, Block S1). An inbox address is
 * a ROLE (`session`, `librarian`, ...), and several sessions can play
 * the same role at once. A reply used to land on the role, and whichever
 * session of that role looked first took it — often not the one that
 * asked.
 *
 * Four identities, kept apart:
 *   role         `From:`/`To:` in a message — unchanged, nothing renamed.
 *   route        a registered target conversation, an opaque UUID
 *                (`routeId`), with a `generation` per role and provider.
 *   fingerprint  what the provider knows the session as — for Claude Code
 *                the sha256 FINGERPRINT of the session id, never the raw
 *                id (a raw session id in a pushed file is a leak).
 *   run          a single attempt — not recorded here.
 *
 * **How a session gets a route ("way 1").** A person tells a session to
 * pick up its mail; on pickup (`mem inbox new|show`) the session
 * registers a route for its role if it has none. From then on its
 * messages carry `From-Route`, and a reply to them carries `To-Route` —
 * set by the write path from the original message, never typed by hand.
 * A headless run (the watcher's handler) registers nothing: a one-shot
 * session is not a route anyone could answer.
 *
 * **Append-only** in `inbox/routes.jsonl`. Nothing personal is stored:
 * the role name, the provider name, a fingerprint and a generated id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendLine } from './append.mjs';
import { isRouteId } from './envelope.mjs';

export const FILE = path.join('inbox', 'routes.jsonl');
const ROLE = /^[A-Za-z0-9._-]{1,64}$/;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,31}){1,3}$/;

/** Absolute path of the route register under a memory root. */
export function registerPath(root) { return path.join(root, FILE); }

/**
 * The fingerprint of a provider id: sha256, 16 hex characters. Enough
 * that two sessions never collide, and no value from the environment.
 */
export function fingerprint(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

/** All routes, oldest first; broken lines counted, never swallowed. */
export function all(root) {
  const p = registerPath(root);
  if (!fs.existsSync(p)) return { routes: [], broken: [] };
  const routes = [];
  const broken = [];
  const seen = new Set();
  fs.readFileSync(p, 'utf8').split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      const z = JSON.parse(raw);
      if (!z || z.kind !== 'route' || !isRouteId(z.routeId) || !Number.isFinite(Date.parse(z.ts))) {
        throw new Error('fields missing or unreadable');
      }
      if (!seen.has(z.routeId)) { seen.add(z.routeId); routes.push(z); }
    } catch (e) { broken.push({ line: i + 1, reason: e.message }); }
  });
  routes.sort((a, b) => a.ts.localeCompare(b.ts));
  return { routes, broken };
}

/** The route with this id, or null. */
export function find(root, routeId) {
  if (!isRouteId(routeId)) return null;
  return all(root).routes.find((r) => r.routeId === routeId) ?? null;
}

/**
 * Register a route. `fingerprint` must already be a fingerprint (or
 * null) — this function never takes a raw provider id.
 */
export function register(root, {
  role, provider, fingerprint: fp = null, alias = null, registeredBy = null, now = new Date(),
} = {}) {
  if (typeof role !== 'string' || !ROLE.test(role)) throw new Error(`role is a role name, not: ${JSON.stringify(role)}`);
  if (typeof provider !== 'string' || !PROVIDER.test(provider)) {
    throw new Error(`provider is a short name, not: ${JSON.stringify(provider)}`);
  }
  if (fp !== null && !/^[0-9a-f]{16}$/.test(String(fp))) {
    throw new Error('fingerprint is a 16-hex fingerprint (routes.fingerprint), never the raw id');
  }
  const { routes } = all(root);
  const generation = routes.filter((r) => r.role === role && r.provider === provider).length + 1;
  const a = alias ?? `${provider}/${role.toLowerCase()}/${String(generation).padStart(2, '0')}`;
  if (!ALIAS.test(a)) throw new Error(`alias has the form a/b[/c], not: ${JSON.stringify(a)}`);
  if (routes.some((r) => r.alias === a)) throw new Error(`alias '${a}' is taken`);
  const line = {
    kind: 'route', routeId: randomUUID(), ts: new Date(now).toISOString(),
    role, alias: a, provider, fingerprint: fp, generation,
    registeredBy: typeof registeredBy === 'string' && registeredBy ? registeredBy : null,
  };
  fs.mkdirSync(path.dirname(registerPath(root)), { recursive: true });
  appendLine(registerPath(root), `${JSON.stringify(line)}\n`);
  return line;
}

/** This process's provider identity, if it has one — fingerprint only leaves this function. */
export function ownIdentity(env = process.env) {
  const sid = String(env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (sid) return { provider: 'claude', fingerprint: fingerprint(sid) };
  return null;
}

/** The newest route of `role` for this process's identity, or null. */
export function ownRoute(root, { role, env = process.env } = {}) {
  const k = ownIdentity(env);
  if (!k || !role) return null;
  const hits = all(root).routes.filter((r) => r.role === role
    && r.provider === k.provider && r.fingerprint === k.fingerprint);
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * "Way 1": register this session's route on pickup, if it has none.
 * Nothing happens without a provider identity or in a headless run.
 * `{ route, fresh }` or `{ route: null, reason }`. Never throws: a
 * pickup must not fail over a registration.
 */
export function registerOnPickup(root, { role, env = process.env, now = new Date() } = {}) {
  try {
    if (env.MEM_HEADLESS) return { route: null, reason: 'headless' };
    const k = ownIdentity(env);
    if (!k) return { route: null, reason: 'no-identity' };
    const there = ownRoute(root, { role, env });
    if (there) return { route: there, fresh: false };
    const route = register(root, {
      role, provider: k.provider, fingerprint: k.fingerprint, registeredBy: `pickup:${role}`, now,
    });
    return { route, fresh: true };
  } catch (e) {
    return { route: null, reason: `error: ${e.message}` };
  }
}

/**
 * Is message `m` for ANOTHER session of the same role than the one
 * holding `mine`? Only a known route of the same role counts as
 * "another session": an unknown To-Route is not a reason to hide mail.
 */
export function forAnotherSession(root, m, mine) {
  if (!mine || !m?.toRoute || m.toRoute === mine.routeId) return false;
  const r = find(root, m.toRoute);
  return Boolean(r && r.role === mine.role);
}
