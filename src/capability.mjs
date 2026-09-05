// src/capability.mjs — scope as a boundary, not an argument.
//
// The measured hole (2026-09-05, bench/redteam.mjs scenario 2): `search()`
// filtered by project only when a caller passed `project`. Omit it and one
// project's memories came back to another. There was no scope a caller
// could not simply not ask for.
//
// **Why an object and not a required parameter.** A required `scope`
// argument catches the omission exactly once. After that `scope: 'all'`
// becomes the copy-paste default and reads like every other argument in
// the call — invisible in review, invisible in a diff. A capability is a
// VALUE the caller must be holding: reaching outside it is not an argument
// someone forgot but an object they do not have, and widening one is a
// named function call that greps.
//
// **Scopes form a lattice, not a hierarchy.** The obvious chain
// global > org > project > agent > session cannot express "shared between
// two projects", which the digest and the inbox both already need. So a
// capability admits a SET of scope nodes, each optionally with its
// descendants.
//
// **Where the guarantee ends.** This is in-process. A different process
// can construct a permissive capability, and nothing here prevents that —
// it is not a sandbox. What it prevents is the accident: the forgotten
// argument, the copied call site, the helper that quietly widened. That
// was the measured failure, and it is the one worth fixing at this layer.

/** A scope node. `global` is the root; everything else is `kind:name`. */
export const GLOBAL = 'global';

export function scopeOf(entry) {
  const p = entry?.project;
  return p ? `project:${p}` : GLOBAL;
}

/** Parse `project:diggi` into its parts. Unprefixed names mean a project. */
export function parseScope(s) {
  const str = String(s ?? '').trim();
  if (!str || str === GLOBAL) return { kind: 'global', name: null, id: GLOBAL };
  const i = str.indexOf(':');
  if (i === -1) return { kind: 'project', name: str, id: `project:${str}` };
  return { kind: str.slice(0, i), name: str.slice(i + 1), id: str };
}

/**
 * What a caller may reach.
 *
 * Frozen on purpose: a capability that can be edited after it is handed
 * over is a suggestion, not a boundary.
 */
export class Capability {
  constructor({ scopes = [], rights = ['read'], subject = null, descendants = true } = {}) {
    this.scopes = Object.freeze([...new Set(scopes.map((s) => parseScope(s).id))].sort());
    this.rights = Object.freeze([...new Set(rights)].sort());
    this.subject = subject;
    this.descendants = Boolean(descendants);
    Object.freeze(this);
  }

  /** Does this capability admit the given scope? */
  admits(scope) {
    const id = parseScope(scope).id;
    if (this.scopes.includes(id)) return true;
    // `global` with descendants is the everything-capability. Spelled out
    // rather than special-cased silently, so that reading the code tells
    // you what it means.
    if (this.descendants && this.scopes.includes(GLOBAL)) return true;
    return false;
  }

  has(right) { return this.rights.includes(right); }

  /**
   * A strictly smaller capability. Narrowing always succeeds; widening is
   * impossible by construction — there is no method for it, and `grant`
   * below is the only way to mint a broader one, from an identity.
   */
  narrow({ scopes = null, rights = null } = {}) {
    const keep = (scopes ?? this.scopes).filter((s) => this.admits(s));
    const rs = (rights ?? this.rights).filter((r) => this.has(r));
    return new Capability({
      scopes: keep, rights: rs, subject: this.subject, descendants: this.descendants,
    });
  }

  describe() {
    return `${this.subject ?? 'anonymous'} [${this.rights.join(',')}] ${this.scopes.join(' ')}`
      + (this.descendants ? ' (+descendants)' : '');
  }
}

/**
 * Mint a capability from an identity.
 *
 * This is the only broadening operation, and it is deliberately a separate
 * named function rather than a constructor default: a call to `grant` is
 * greppable, and `grant({ scopes: ['global'] })` is a sentence a reviewer
 * can object to. `new Capability({})` admits nothing at all, which is the
 * right default for something that fails closed.
 */
export function grant({ subject = null, scopes = [], rights = ['read'], descendants = true } = {}) {
  return new Capability({ subject, scopes, rights, descendants });
}

/** The everything-capability. Named so it shows up in a search for it. */
export function grantAll(subject = null) {
  return grant({ subject, scopes: [GLOBAL], rights: ['read', 'write'], descendants: true });
}

/** A capability for exactly one project, and nothing else. */
export function grantProject(project, { subject = null, rights = ['read'] } = {}) {
  return grant({ subject, scopes: [`project:${project}`], rights, descendants: false });
}
