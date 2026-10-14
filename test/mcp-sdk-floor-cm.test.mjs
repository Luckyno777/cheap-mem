// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A8 / F14 (counter-check of the sibling's service security round): the MCP SDK is an OPTIONAL peer, so what a user
// installs is not what `package-lock.json` pins - `npm ci` pins only the development tree. The peer range said
// `^1.0.0`: a user (or an installer line without a version) could pair `mem-mcp --http` with any 1.x, back to
// releases that predate the streamable HTTP transport and `enableJsonResponse` this bridge is built on. The version
// the suite is measured with is the lock's.
//
// What is pinned here, in ONE place (package.json):
//   - the lower bound of the PEER range is not below the version the suite runs against (the devDependency / lock);
//   - the dev range and the peer range have the same lower bound (one truth, not two);
//   - the lock's root entry mirrors package.json for both ranges (`npm ci` refuses a lock that disagrees);
//   - the lock resolves the SDK to a version inside both ranges;
//   - an SDK that is installed in this tree is inside the peer range;
//   - every line that tells a user how to install the SDK carries the range.
// The input limit of the bridge does not depend on the SDK version (see test/service-door-cm.test.mjs, A8/F14).
//
// Red on the base (e6c1dc7): the peer range is `^1.0.0`, and the install lines name no version.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = '@modelcontextprotocol/sdk';
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

/** `^1.30.0` / `>=1.30.0 <2` / `1.30.0` -> [1, 30, 0]; anything else is a failure of the probe, never a guess. */
function lowerBound(range) {
  const m = /^(?:\^|~|>=\s*)?(\d+)\.(\d+)\.(\d+)(?:\s+<\s*\d+(?:\.\d+){0,2})?$/.exec(String(range).trim());
  assert.ok(m, `cannot read a lower bound from the range ${JSON.stringify(range)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const parseVersion = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v)); assert.ok(m, `not a version: ${v}`); return [Number(m[1]), Number(m[2]), Number(m[3])]; };
/** Is `v` inside a caret range with lower bound `lo` (same major, at least lo)? */
const inCaret = (v, lo) => v[0] === lo[0] && cmp(v, lo) >= 0;

test('A8/F14: the peer range of the SDK is not wider than the version the suite is measured with', () => {
  const peer = pkg.peerDependencies?.[SDK];
  const dev = pkg.devDependencies?.[SDK];
  assert.ok(peer && dev, 'both ranges must exist');
  assert.match(peer, /^\^\d+\.\d+\.\d+$/, 'a caret range: same major, a stated floor');
  assert.deepEqual(lowerBound(peer), lowerBound(dev), `peer ${peer} and dev ${dev} must share one lower bound`);
  assert.equal(pkg.peerDependenciesMeta?.[SDK]?.optional, true, 'and it stays optional (the core runs without it)');
  const locked = lock.packages?.[`node_modules/${SDK}`]?.version;
  assert.ok(locked, 'the lock resolves the SDK');
  assert.ok(inCaret(parseVersion(locked), lowerBound(peer)), `lock ${locked} must satisfy peer ${peer}`);
  assert.ok(inCaret(parseVersion(locked), lowerBound(dev)), `lock ${locked} must satisfy dev ${dev}`);
  assert.ok(cmp(lowerBound(peer), parseVersion(locked)) <= 0, 'the floor is not above what the suite runs on');
  // Positive control of the reader itself: it tells ^1.0.0 from ^1.30.0.
  assert.ok(cmp(lowerBound('^1.0.0'), lowerBound('^1.30.0')) < 0);
});

test('A8/F14: the lock mirrors package.json for the SDK (npm ci refuses a lock that disagrees)', () => {
  const root = lock.packages?.[''];
  assert.ok(root, 'lock root entry');
  assert.equal(root.peerDependencies?.[SDK], pkg.peerDependencies[SDK]);
  assert.equal(root.devDependencies?.[SDK], pkg.devDependencies[SDK]);
});

test('A8/F14: an SDK installed in this tree is inside the peer range (three states: absent, installed and inside, installed and outside)', (t) => {
  let installed = null;
  try { installed = JSON.parse(read('node_modules', ...SDK.split('/'), 'package.json')).version; } catch (e) {
    if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) throw e; // unreadable is not absent
  }
  if (installed === null) {
    t.diagnostic('the SDK is not installed in this tree: the installed-version check has nothing to read (the range checks above ran)');
    return;
  }
  assert.ok(inCaret(parseVersion(installed), lowerBound(pkg.peerDependencies[SDK])),
    `installed ${installed} is outside the peer range ${pkg.peerDependencies[SDK]}`);
});

test('A8/F14: every line that tells a user to install the SDK names the range (quoted: ^ is an escape in cmd.exe)', () => {
  const range = pkg.peerDependencies[SDK];
  const wanted = `"${SDK}@${range}"`;
  const files = ['bin/mem-mcp', 'src/cli/commands/setup.mjs', 'docs/mcp-setup.md', 'README.md'];
  for (const f of files) {
    const lines = read(f).split('\n').filter((l) => /npm (?:install|i)\b[^\n]*@modelcontextprotocol\/sdk/.test(l));
    assert.ok(lines.length >= 1, `${f}: no install line found - has the text moved?`);
    for (const l of lines) assert.ok(l.includes(wanted), `${f}: ${l.trim()} - names no range (${wanted})`);
  }
});
