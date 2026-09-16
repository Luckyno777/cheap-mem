// An optional peer that the SUITE needs is not optional for the suite.
//
// **The finding (2026-09-16).** CI on this repository had failed on
// EVERY run for days — 153 of them, every platform, node 20 and 22
// alike — while `npm test` was green on a developer machine. 41
// failures across three files, all of which spawn the MCP server.
//
// The cause: `@modelcontextprotocol/sdk` is declared as an OPTIONAL
// peer dependency. That is the right declaration for the product —
// capture, search and digest all work without it, and the server says
// so when it is missing. But npm never installs an optional peer by
// itself. It was present on the developer machine because somebody had
// installed it by hand, once, and absent everywhere else.
//
// So the suite was green exactly where someone had done that, and red
// everywhere else, and the difference was invisible: the tests threw
// away the server's stderr and reported "Cannot read properties of
// null" instead of the message the server actually printed.
//
// The repair is one line in devDependencies. This test is the part that
// keeps it: a peer the tests need has to be installed by a plain
// `npm ci`, or the suite only proves something about one laptop.
// Covers an assurance from shared/invariants.jsonl.
// invariant: optionaler-peer-im-test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

/** Every optional peer, and which of them the test suite depends on. */
function peersNeededByTests() {
  const optional = Object.keys(pkg.peerDependenciesMeta ?? {})
    .filter((n) => pkg.peerDependenciesMeta[n]?.optional);
  const testText = fs.readdirSync(path.join(REPO, 'test'))
    .filter((n) => n.endsWith('.mjs') || n.endsWith('.sh'))
    .map((n) => fs.readFileSync(path.join(REPO, 'test', n), 'utf8'))
    .join('\n');
  // A test that only NAMES a peer (the packaging test lists them all on
  // purpose) does not need it installed. Needing it means the suite
  // actually runs something that loads it — here: the MCP server.
  const needed = new Set();
  if (/bin['"/\\\],\s]*mem-mcp|MCP\b/.test(testText)) needed.add('@modelcontextprotocol/sdk');
  return { optional, needed: [...needed] };
}

test('POSITIVE: the manifest still declares optional peers at all', () => {
  // Without this, renaming the field would make the guard below pass by
  // finding nothing — the failure mode this whole suite keeps meeting.
  const { optional } = peersNeededByTests();
  assert.ok(optional.length >= 2,
    `only ${optional.length} optional peers found — has peerDependenciesMeta moved?`);
  assert.ok(optional.includes('@modelcontextprotocol/sdk'));
});

test('an optional peer the tests need is also a devDependency', () => {
  const { needed } = peersNeededByTests();
  const dev = pkg.devDependencies ?? {};
  assert.ok(needed.length, 'the probe found no test that needs a peer — it is checking nothing');
  const missing = needed.filter((n) => !dev[n]);
  assert.deepEqual(missing, [],
    'these peers are optional for USERS and mandatory for the SUITE. Without them in '
    + 'devDependencies a plain `npm ci` leaves them out, and the tests that need them '
    + 'pass only where someone installed them by hand. That is what kept CI red for days.');
});

test('the lockfile carries it, so `npm ci` really installs it', () => {
  // devDependencies without a lockfile entry is a promise npm ci does
  // not keep — and npm ci is exactly what CI runs.
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  const { needed } = peersNeededByTests();
  for (const n of needed) {
    const entry = lock.packages?.[`node_modules/${n}`];
    assert.ok(entry, `${n} is in devDependencies but not in the lockfile`);
    assert.ok(entry.dev === true || entry.peer === true,
      `${n} is in the lockfile but not marked as a dev/peer install`);
  }
});

test('the peer stays OPTIONAL for users', () => {
  // The counter-check. Making it a hard dependency would fix CI and
  // break the product's own promise: the server prints "everything
  // else works without it" when it is absent, and that has to stay
  // true.
  assert.equal(pkg.peerDependenciesMeta?.['@modelcontextprotocol/sdk']?.optional, true,
    'the MCP SDK must stay an optional peer — capture, search and digest work without it');
  assert.ok(!(pkg.dependencies ?? {})['@modelcontextprotocol/sdk'],
    'it must not become a hard runtime dependency');
});
