// Entry schema version (2026-09-20): before this change, nothing in
// `src/` stamped or read a `v` field on an entry — confirmed by grep.
// At a projected 5 million append-only lines over 5-10 years, a
// migration cannot know which line was written under which rules
// without one, and the file cannot be rewritten to add it after the
// fact: append-only means the field is stamped going forward and the
// PAST is read by adapter, never edited.
//
// Three properties, each with its own test below:
//   1. absent `v` means v=0 -- "written before versioning", a KNOWN
//      fact, not the same thing as `unknown`.
//   2. a reader adapter per version, enforced by a guard rather than a
//      comment -- a version with no adapter must fail to even import.
//   3. the field is cheap -- measured on a realistic entry, not assumed.
//
// The "no adapter" and "sabotage" tests run against a SANDBOXED copy of
// memory.mjs and its dependency closure in a temp directory, never the
// real `src/memory.mjs` -- this suite must never leave the checked-out
// source mutated, and must never touch git to restore it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';

const SRC = new URL('../src/', import.meta.url).pathname;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-ver-'));
}

// memory.mjs's whole dependency closure (checked by grepping every
// `^import` in each file): freshness/authority/bidi have none of their
// own, config.mjs imports agents.mjs, agents.mjs imports only node
// builtins. All five live flat in src/, so copying them flat keeps
// every relative `./x.mjs` import resolving unchanged.
const DEPS = ['freshness.mjs', 'authority.mjs', 'bidi.mjs', 'config.mjs', 'agents.mjs'];

/**
 * A private, disposable copy of memory.mjs (with `patch` applied to its
 * source text) plus everything it imports, in its own temp directory.
 * Dynamic-imported by a fresh file:// URL each time, so every sandbox
 * gets its own module instance -- no import-cache collisions between
 * tests. Returns the imported module, or throws whatever importing it
 * threw (including a synchronous throw at module-evaluation time, which
 * is exactly what the version guard produces).
 */
async function sandboxImport(patch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-sandbox-'));
  try {
    for (const dep of DEPS) {
      fs.copyFileSync(path.join(SRC, dep), path.join(dir, dep));
    }
    const original = fs.readFileSync(path.join(SRC, 'memory.mjs'), 'utf8');
    const patched = patch(original);
    assert.notEqual(patched, original, 'the patch did not change anything -- test is not exercising what it claims to');
    fs.writeFileSync(path.join(dir, 'memory.mjs'), patched, 'utf8');
    return await import(pathToFileURL(path.join(dir, 'memory.mjs')).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('POSITIVE CONTROL: a freshly written entry carries the field, and the harness can see it', () => {
  const root = tmpRoot();
  const { entry } = memory.logEntry(root, 'decision', { topic: 't', choice: 'x', why: 'y' });
  assert.equal(entry.v, memory.ENTRY_VERSION);
  const { entries } = memory.readLog(root, 'decision');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].v, memory.ENTRY_VERSION, 'the field written to disk is the field read back');
});

test('the version is stamped by the code, not by the caller', () => {
  // A caller handing logEntry a `v` of its own must not be able to make
  // an entry claim a schema version the running code did not actually
  // write it under -- that is precisely the fact a later migration has
  // to trust.
  const root = tmpRoot();
  const { entry } = memory.logEntry(root, 'decision', {
    topic: 't', choice: 'x', why: 'y', v: 999,
  });
  assert.equal(entry.v, memory.ENTRY_VERSION, 'a caller-supplied v leaked through the one door');
});

test('THE GUARANTEE: a fixture holding one line of every version that has ever existed is read correctly', () => {
  // Exactly two versions have ever existed in this repo's history: v=0
  // (no field -- everything before this change) and v=1 (this change).
  // Adding a version later means adding ONE more line here, plus an
  // adapter in src/memory.mjs -- that is the whole point of building the
  // fixture this way rather than hand-picking a couple of examples.
  const fixture = [
    { id: 'aaaaaaaaaaaa', ts: '2026-01-01T00:00:00Z', type: 'decision', topic: 'old', choice: 'x', why: 'pre-versioning line, no v field at all' },
    { id: 'bbbbbbbbbbbb', ts: '2026-09-20T00:00:00Z', v: 1, type: 'decision', topic: 'new', choice: 'y', why: 'written under this change' },
  ];
  for (const raw of fixture) {
    const adapted = memory.adaptEntry(raw);
    assert.equal(typeof adapted.v, 'number', `version did not resolve to a number for ${JSON.stringify(raw)}`);
    assert.ok(adapted.v === 0 || adapted.v === 1);
    // The adapter must not have dropped anything the entry actually holds.
    assert.equal(adapted.topic, raw.topic);
    assert.equal(adapted.choice, raw.choice);
  }
  assert.equal(memory.adaptEntry(fixture[0]).v, 0, 'the pre-versioning line must read as v=0');
  assert.equal(memory.adaptEntry(fixture[1]).v, 1, 'the versioned line must read as v=1');
});

test('ABSENT IS NOT UNKNOWN: no v field reads as v=0, an unparseable v reads as unknown', () => {
  // The two facts this house insists on keeping apart.
  assert.equal(memory.entryVersionOf({ id: 'x', ts: 't', topic: 'no field at all' }), 0);
  assert.equal(memory.entryVersionOf({ id: 'x', v: 1 }), 1);
  assert.equal(memory.entryVersionOf({ id: 'x', v: 0 }), 0);

  // Unparseable shapes -- corruption, a hand-edit, a future format this
  // build has never seen -- must NOT be silently rounded down to 0.
  for (const bad of ['1', 1.5, -1, NaN, null, true, {}, [], 'v1']) {
    assert.equal(memory.entryVersionOf({ id: 'x', v: bad }), memory.V_UNKNOWN,
      `v: ${JSON.stringify(bad)} was folded into a known version instead of staying unknown`);
  }

  // adaptEntry must carry the same distinction through, not paper over it.
  assert.equal(memory.adaptEntry({ id: 'x', ts: 't' }).v, 0);
  assert.equal(memory.adaptEntry({ id: 'x', v: 'garbage' }).v, memory.V_UNKNOWN);
});

test('NO ADAPTER, NO VERSION: bumping ENTRY_VERSION without a reader fails loudly, at import', async () => {
  // The realistic mistake: a future change bumps ENTRY_VERSION to 2 and
  // forgets to add adapter `2`. This must not produce a reader that is
  // subtly wrong later -- it must stop the module from loading at all.
  let threw = null;
  try {
    await sandboxImport((src) => {
      const out = src.replace('export const ENTRY_VERSION = 1;', 'export const ENTRY_VERSION = 2;');
      assert.notEqual(out, src, 'ENTRY_VERSION line not found -- test is stale against the source');
      return out;
    });
  } catch (e) { threw = e; }
  assert.ok(threw, 'introducing version 2 with no adapter for it must throw, not import cleanly');
  assert.match(String(threw.message ?? threw), /no reader adapter|has no adapter/i,
    `wrong failure reason: ${threw}`);
});

test('a version WITH its adapter added at the same time imports and reads cleanly', async () => {
  // The counterpart to the test above: proves the guard fires on the
  // MISSING adapter specifically, not on touching ENTRY_VERSION at all.
  const mod = await sandboxImport((src) => {
    let out = src.replace('export const ENTRY_VERSION = 1;', 'export const ENTRY_VERSION = 2;');
    out = out.replace(
      '  [1, (entry) => ({ ...entry })],\n]);',
      '  [1, (entry) => ({ ...entry })],\n  [2, (entry) => ({ ...entry })],\n]);',
    );
    assert.notEqual(out, src);
    return out;
  });
  assert.equal(mod.ENTRY_VERSION, 2);
  assert.equal(mod.adaptEntry({ id: 'x', v: 2 }).v, 2);
});

test('SABOTAGE: removing one adapter turns the fixture red; restoring it turns the fixture green', async () => {
  // Runs against a sandboxed COPY -- never the real src/memory.mjs, and
  // never git. "Restore" here means importing a second, unmodified
  // sandbox copy, not undoing a mutation in place.
  const runFixtureThrough = (mod) => {
    // adaptEntry throws synchronously for a version with no adapter --
    // exercising it against a v=0 line is enough to prove the removal
    // took effect, since v=0 is exactly the adapter removed below.
    return mod.adaptEntry({ id: 'aaaaaaaaaaaa', ts: '2026-01-01T00:00:00Z' });
  };

  // RED: adapter 0 removed by hand from the sandboxed source text.
  const sabotagedMod = await sandboxImport((src) => {
    const out = src.replace(
      "  [0, (entry) => ({ ...entry, v: 0 })],\n",
      '',
    );
    assert.notEqual(out, src, 'adapter-0 line not found -- test is stale against the source');
    return out;
  });
  assert.throws(() => runFixtureThrough(sabotagedMod), /no reader adapter|has no adapter/i,
    'removing the v=0 adapter must make reading a v=0 line fail, not silently succeed');

  // GREEN: an unmodified sandbox (the "restore" -- a fresh copy of the
  // real source, not a repaired mutation) reads the same line fine.
  const restoredMod = await sandboxImport((src) => `${src}\n// sandbox marker, forces a distinct copy\n`);
  assert.doesNotThrow(() => runFixtureThrough(restoredMod));
  assert.equal(runFixtureThrough(restoredMod).v, 0);
});

test('COST: measured on a realistic entry, the field is well under 1% of the line', () => {
  const root = tmpRoot();
  // A realistic entry, sized against the brief's own measurement of the
  // real corpus (p50 979 B, mean 1030 B) -- not a short synthetic line,
  // where a fixed ~6 B overhead would look artificially expensive. The
  // `why` text below is the length an actual reasoning entry in this
  // house's style runs to; see e.g. the `agentDefault` doc comment in
  // src/memory.mjs for the same register.
  const why = 'The bridge stamped `agent` on every entry it wrote, but the CLI '
    + 'never did, so three quarters of the corpus carried no origin at all -- '
    + '855 of 1081 entries in the reference deployment, measured 2026-09-08. '
    + 'Rather than defaulting to a session id that would look like real '
    + 'provenance, the write path now falls back to `human:<user>` only when '
    + 'nothing more specific was given, keeping the human and machine sets '
    + 'disjoint so later tooling can tell them apart without guessing. Old '
    + 'entries are deliberately NOT backfilled: stamping them now would be '
    + 'inventing origin at scale, and the corpus is meant to heal forward, not '
    + 'to be rewritten to look better than it was. Caught by the existing '
    + 'agents test, not by reading the code.';
  const { entry, path: p } = memory.logEntry(root, 'decision', {
    topic: 'agent-default-fallback',
    choice: 'fall back to human:<user>, never to an invented session id',
    why,
    tags: ['provenance', 'agent-board', 'authority'],
  });
  const lineWithV = fs.readFileSync(p, 'utf8').trim();
  const bytesWithV = Buffer.byteLength(lineWithV, 'utf8');
  // Sanity: this fixture is meant to sit in the same size class as the
  // real corpus the brief measured, not near-empty and not enormous.
  assert.ok(bytesWithV > 800 && bytesWithV < 1300,
    `fixture line is ${bytesWithV} B -- adjust it back toward the ~979-1030 B the brief measured`);

  // The same entry with the version field removed, to isolate its cost
  // on THIS realistic line rather than a made-up one.
  const { v: _v, ...withoutV } = entry;
  const bytesWithoutV = Buffer.byteLength(JSON.stringify(withoutV), 'utf8');

  const cost = bytesWithV - bytesWithoutV;
  const pct = (cost / bytesWithV) * 100;
  console.log(`entry-version cost: +${cost} B on a ${bytesWithV} B realistic-sized line (${pct.toFixed(2)}%)`);

  assert.ok(cost > 0 && cost <= 10, `expected a small fixed cost (~6 B for '"v":1,'), got ${cost} B`);
  assert.ok(pct < 1, `field costs ${pct.toFixed(2)}% of the line, over the 1% budget`);
});

test('the guard is real code, not only a comment -- removing the import-time call is itself detectable', () => {
  // Cheap, targeted check that the enforcement described above actually
  // exists in the source as code (distinct from the SABOTAGE test above,
  // which proves the guard's EFFECT). Mirrors the pattern the size-cap
  // suite uses for the same reason: assert.match on the real source.
  const src = fs.readFileSync(new URL('../src/memory.mjs', import.meta.url), 'utf8');
  assert.match(src, /assertVersionHasReader\(ENTRY_VERSION\)/,
    'the import-time guard call is missing from src/memory.mjs');
  assert.match(src, /function assertVersionHasReader/,
    'the guard function itself is missing from src/memory.mjs');
});

test('sandbox mechanism sanity: two sandboxed imports of the same unmodified source are independent module instances', async () => {
  const a = await sandboxImport((src) => `${src}\n// a\n`);
  const b = await sandboxImport((src) => `${src}\n// b\n`);
  assert.notEqual(a, b);
  assert.equal(a.ENTRY_VERSION, b.ENTRY_VERSION);
});
