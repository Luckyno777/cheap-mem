// test/p13-memory-find-capability.test.mjs — issue #136.
//
// `memory.find()` used to decide "which drawers may this caller see" on
// its own, by hand: `projects === null ? [null, ...listProjects(root)]
// : projects`. Four callers (`mem component`, the CLI `find --literal`
// lane, MCP `mem_find --literal`, and the time-window lane behind `mem
// find "<time phrase>"`/`mem when`) built their OWN copy of "does a
// project also see global" around that hole, because the real rule
// lived in `capability.mjs` and this function never consulted it. Two
// places decided the same thing; only one of them was the lattice.
//
// `test/p13-lattice-wiring.test.mjs` and `test/scope-lattice-redteam.
// test.mjs` prove the CALLERS now mint and pass a real Capability. This
// file proves the other half: `memory.find()` ITSELF enforces the
// lattice, once, so that every caller inherits the guarantee from one
// place instead of re-deriving it. Where those two files spawn `mem`/
// `mem-mcp` as subprocesses, this file calls `memory.find` directly —
// it is the one piece with no process boundary to cross.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as capability from '../src/capability.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p13-find-cap-'));
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

const NEEDLE = 'zzzp13findcap';

/**
 * Global, alpha and beta each get one `decision` entry carrying the
 * same needle, logged in that order — so a caller with full reach and
 * no narrowing gets back exactly [global, alpha, beta] (scope order is
 * `[null, ...listProjects(root)]`, and `listProjects` sorts by name;
 * within one scope's one log file, insertion order is line order).
 * That fixed, known order is what the positive control below checks
 * against, rather than merely a matching SET.
 */
function world() {
  const root = tmp();
  const g = memory.logEntry(root, 'decision',
    { topic: 't', choice: NEEDLE, why: `${NEEDLE} global` }).entry;
  const a = memory.logEntry(root, 'decision',
    { topic: 't', choice: NEEDLE, why: `${NEEDLE} alpha` }, { project: 'alpha' }).entry;
  const b = memory.logEntry(root, 'decision',
    { topic: 't', choice: NEEDLE, why: `${NEEDLE} beta` }, { project: 'beta' }).entry;
  return { root, g, a, b };
}

// =========================================================================
// REQUIRED, LOUDLY. An optional capability that silently meant
// "everything" would be the exact hole this parameter exists to close —
// see memory.mjs's doc comment on `find`. So a caller that gets the
// shape wrong must find out immediately, not receive an answer that
// merely LOOKS like "found nothing".
// =========================================================================

test('memory.find throws when capability is missing or the wrong kind, not "found nothing"', () => {
  const { root } = world();
  try {
    assert.throws(() => memory.find(root, NEEDLE), TypeError, 'omitted entirely');
    assert.throws(() => memory.find(root, NEEDLE, undefined), TypeError, 'explicit undefined');
    assert.throws(() => memory.find(root, NEEDLE, null), TypeError, 'null is not a Capability');
    assert.throws(() => memory.find(root, NEEDLE, {}), TypeError, 'a plain object is not a Capability');
    assert.throws(() => memory.find(root, NEEDLE, { projects: null }), TypeError,
      'the OLD options shape, now in the capability slot, must not be read as one');
  } finally { away(root); }
});

test('a capability that does not carry read gets an honest empty answer, not a crash', () => {
  const { root } = world();
  try {
    const writeOnly = capability.grant({ subject: 't', scopes: [capability.GLOBAL], rights: ['write'] });
    assert.deepEqual(memory.find(root, NEEDLE, writeOnly), []);
  } finally { away(root); }
});

// =========================================================================
// POSITIVE CONTROL: a full grant sees exactly what the old, unconditional
// default saw — same hits, same order. The refactor must not have
// quietly narrowed anything for the caller that legitimately holds
// everything.
// =========================================================================

test('POSITIVE CONTROL: grantAll returns global+alpha+beta, in the pre-refactor scope order', () => {
  const { root, g, a, b } = world();
  try {
    const hits = memory.find(root, NEEDLE, capability.grantAll('t'));
    assert.deepEqual(hits.map((h) => h.id), [g.id, a.id, b.id],
      'grantAll must see every scope, in exactly the order the old unconditional '
      + '`[null, ...listProjects(root)]` produced — a full grant is where a quiet '
      + 'narrowing would be easiest to miss');
  } finally { away(root); }
});

// =========================================================================
// RED/GREEN: a capability granting only project X must not return
// entries from project Y. Sabotage is `Capability.prototype.admits`
// itself — the one predicate `memory.find`'s new scope resolution
// relies on — so this proves the enforcement lives THERE, not in some
// other check that happens to agree with it today.
// =========================================================================

test('RED/GREEN: a project-scoped capability excludes a foreign project through memory.find', () => {
  const { root, g, a, b } = world();
  try {
    const alphaOnly = capability.grantProject('alpha', { subject: 't' });

    const before = memory.find(root, NEEDLE, alphaOnly);
    assert.deepEqual(before.map((h) => h.id).sort(), [g.id, a.id].sort(),
      'sanity: an alpha-scoped capability should see global+alpha, not beta, before any sabotage');

    const original = capability.Capability.prototype.admits;
    capability.Capability.prototype.admits = function alwaysAdmit() { return true; };
    let afterIds;
    try {
      afterIds = memory.find(root, NEEDLE, alphaOnly).map((h) => h.id);
    } finally {
      capability.Capability.prototype.admits = original;
    }
    assert.ok(afterIds.includes(b.id),
      `SABOTAGE DID NOT FLIP RED: beta still did not leak through memory.find with admits() disabled `
      + `(got ids ${JSON.stringify(afterIds)})`);
    assert.ok(afterIds.includes(a.id), 'sabotage broke more than enforcement — alpha lost its own entry too');

    const restored = memory.find(root, NEEDLE, alphaOnly);
    assert.deepEqual(restored.map((h) => h.id).sort(), [g.id, a.id].sort(),
      'GREEN after restore: beta must be excluded again, admits() fully restored');
  } finally { away(root); }
});

// =========================================================================
// The other direction of the same guarantee: a project capability must
// still see `global` — the lattice ROOT every capability with read
// inherits. This is what `component.find`/the CLI+MCP literal lanes/the
// time-window lane used to hand-spell as `[null, project]`; now it
// follows from `capability.admits()` alone.
// =========================================================================

test('a project-scoped capability still sees global, the lattice root', () => {
  const { root, g, a, b } = world();
  try {
    const alphaOnly = capability.grantProject('alpha', { subject: 't' });
    const hits = memory.find(root, NEEDLE, alphaOnly).map((h) => h.id);
    assert.ok(hits.includes(g.id), 'global must be inherited, not treated as a sibling scope');
    assert.ok(hits.includes(a.id), 'alpha must still be reachable');
    assert.ok(!hits.includes(b.id), 'beta must still be excluded');
  } finally { away(root); }
});

test('grantProject(\'global\') behaves as global-only — the established idiom every scoped lane already relies on', () => {
  // No document is ever filed under a project literally named "global"
  // (`checkProjectName`/`listProjects` never produce that name), so this
  // capability's own scope list never matches a real project — only the
  // universal global-inheritance rule in `admits()` lets anything
  // through. `mem find --literal --project global`, `mem_find`, `mem
  // component --project global` and the time-window lane all rely on
  // exactly this, rather than a special case spelled out per lane.
  const { root, g } = world();
  try {
    const globalOnly = capability.grantProject('global', { subject: 't' });
    const hits = memory.find(root, NEEDLE, globalOnly);
    assert.deepEqual(hits.map((h) => h.id), [g.id]);
  } finally { away(root); }
});

// =========================================================================
// STEP 5: the `projects` option survives as a narrowing filter WITHIN
// what the capability grants — "I may see everything, show me only this
// one" — never as a way to reach past it. A name in `projects` the
// capability does not admit is INTERSECTED away, not honoured and not
// used to fall back to the full set.
// =========================================================================

test('projects narrows within a full grant — a legitimate "show me only this drawer"', () => {
  const { root, a } = world();
  try {
    const hits = memory.find(root, NEEDLE, capability.grantAll('t'), { projects: ['alpha'] });
    assert.deepEqual(hits.map((h) => h.id), [a.id]);
  } finally { away(root); }
});

test('OVER-REACH: projects naming a scope outside the capability is refused, never honoured or widened', () => {
  const { root, a, b } = world();
  try {
    const alphaOnly = capability.grantProject('alpha', { subject: 't' });

    // Asking for exactly the one project this capability does NOT hold:
    // the answer is empty, not "fall back to everything I DO hold" and
    // not an error that would itself confirm beta exists.
    const onlyForeign = memory.find(root, NEEDLE, alphaOnly, { projects: ['beta'] });
    assert.deepEqual(onlyForeign, [],
      'a projects list entirely outside the capability must come back empty, not widened to what the capability DOES admit');

    // Mixed: one name the capability holds, one it does not. The
    // forbidden one is dropped silently; the legitimate one still comes
    // through — narrowing shrinks, it does not also break the request
    // it had every right to answer.
    const mixed = memory.find(root, NEEDLE, alphaOnly, { projects: ['alpha', 'beta'] });
    assert.deepEqual(mixed.map((h) => h.id), [a.id]);
    assert.ok(!mixed.some((h) => h.id === b.id), 'beta must not ride in on the back of a legitimate alpha request');
  } finally { away(root); }
});

