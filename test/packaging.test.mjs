import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

test('nothing heavy is installed just to search a memory', () => {
  // Measured 2026-09-05: the MCP SDK pulls 28 MB across 91 packages (an
  // HTTP stack this stdio server never uses) and the sqlite pair another
  // 14 MB of native build. Together they made a 194 kB tool a 43 MB
  // install. Core cheap-mem — capture, search, digest — needs neither, so
  // neither may sit anywhere npm installs by default.
  assert.deepEqual(pkg.dependencies ?? {}, {},
    'a hard dependency was added; every install now pays for it');
  assert.deepEqual(pkg.optionalDependencies ?? {}, {},
    'optionalDependencies are INSTALLED unless the build fails — that is not opt-in');
  for (const name of ['@modelcontextprotocol/sdk', 'better-sqlite3', 'sqlite-vec']) {
    assert.ok(pkg.peerDependencies?.[name], `${name} must stay a peer`);
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true,
      `${name} must be an OPTIONAL peer, else npm installs it anyway`);
  }
});

/**
 * **The named exception to "zero dependencies" (owner decision
 * 2026-09-28, docs/dashboard-port-2026-09-28.md §6.1).**
 *
 * The dashboard — the one UI, identical to the sibling house's — needs
 * three.js (its 3D energy-core network) and the DM Sans font. Pulling
 * either from a CDN would make every page load a request to a third
 * party; adding them as npm dependencies would make every install pay
 * for a UI many never open. So they are VENDORED: copied into `assets/`,
 * shipped as files, loaded only from this server. `dependencies` above
 * stays empty.
 *
 * An exception is only an exception while it is NAMED. This list is the
 * name: every third-party file under `assets/`, with its licence file
 * and the reason. A file under `assets/` that is neither here nor
 * cheap-mem's own dashboard code fails the test below — a third vendored
 * library cannot slip in as "just another asset".
 */
export const VENDORED = Object.freeze([
  {
    path: 'assets/three/three-r180.min.js', license: 'assets/three/LICENSE', spdx: 'MIT',
    reason: 'three.js r180 — the dashboard\'s 3D energy-core network (WebGL), identical to the sibling house',
  },
  {
    path: 'assets/fonts/dm-sans-latin.woff2', license: 'assets/fonts/OFL.txt', spdx: 'OFL-1.1',
    reason: 'DM Sans (latin) — the dashboard\'s typeface, served locally instead of from Google Fonts',
  },
  {
    path: 'assets/fonts/dm-sans-latin-ext.woff2', license: 'assets/fonts/OFL.txt', spdx: 'OFL-1.1',
    reason: 'DM Sans (latin-ext) — same typeface, extended Latin subset',
  },
]);

/** cheap-mem's own files under assets/ — code and licence texts, not libraries. */
const OWN_ASSETS = Object.freeze([
  'assets/dashboard/dashboard.js', 'assets/dashboard/dashboard.css',
  'assets/three/LICENSE', 'assets/fonts/OFL.txt',
]);

test('vendored files are the NAMED exception: each exists, carries its licence, and is in NOTICE', () => {
  const notice = fs.readFileSync(path.join(PKG_ROOT, 'NOTICE'), 'utf8');
  for (const v of VENDORED) {
    assert.ok(fs.existsSync(path.join(PKG_ROOT, v.path)), `${v.path} is named but missing`);
    assert.ok(fs.existsSync(path.join(PKG_ROOT, v.license)), `${v.path}: licence ${v.license} is missing`);
    assert.ok(notice.includes(path.basename(v.path)), `${v.path} is vendored but NOTICE does not name it`);
    assert.ok(v.reason && v.spdx, `${v.path}: an exception without a reason is not named`);
  }
  // The npm dependency list is untouched by the exception.
  assert.deepEqual(pkg.dependencies ?? {}, {});
  // And the files ship: an asset the server reads at runtime but npm
  // leaves out is the ERR-at-a-stranger's-machine class again.
  assert.ok(pkg.files.includes('assets/'), 'assets/ is not in package.json files');
});

test('nothing under assets/ is third-party without being named in VENDORED', () => {
  const walk = (dir) => fs.readdirSync(path.join(PKG_ROOT, dir), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
  const named = new Set([...VENDORED.map((v) => v.path), ...OWN_ASSETS]);
  const stray = walk('assets').filter((f) => !named.has(f));
  assert.deepEqual(stray, [], `unnamed files under assets/: ${stray.join(', ')}`);
});

test('POSITIVE: the unnamed-asset probe really fires on a stray file', () => {
  const named = new Set([...VENDORED.map((v) => v.path), ...OWN_ASSETS]);
  assert.equal(named.has('assets/lodash/lodash.min.js'), false,
    'a made-up third library would be treated as named — the probe sees nothing');
});

test('npx cheap-mem finds a bin under that name', () => {
  // `npx <package>` runs the bin named after the package. Without this
  // alias the most obvious first command a reader types does nothing.
  assert.equal(pkg.bin['cheap-mem'], './bin/mem');
  for (const [name, rel] of Object.entries(pkg.bin)) {
    const p = path.join(PKG_ROOT, rel);
    assert.ok(fs.existsSync(p), `bin ${name} points at a missing file`);
    assert.match(fs.readFileSync(p, 'utf8').slice(0, 40), /^#!/,
      `bin ${name} has no shebang and will not run when installed`);
  }
});

test('the published files are the ones that run, and every one exists', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length,
    'without a files field npm publishes the whole working tree');
  for (const f of pkg.files) {
    if (f.startsWith('!')) continue;   // an exclusion is not a path — see package-contents
    assert.ok(fs.existsSync(path.join(PKG_ROOT, f.replace(/\/$/, ''))),
      `files lists ${f}, which is not in the repo`);
  }
  for (const dev of ['test/', 'bench/']) {
    assert.ok(!pkg.files.includes(dev), `${dev} does not belong in the tarball`);
  }
});

test('the MCP server says what to install instead of throwing MODULE_NOT_FOUND', () => {
  // A raw import failure inside an MCP client is invisible: the client
  // reports only that the server would not start. The one place the SDK
  // is loaded must catch that and name the fix.
  const src = fs.readFileSync(path.join(PKG_ROOT, 'bin', 'mem-mcp'), 'utf8');
  assert.ok(!/^import .*@modelcontextprotocol/m.test(src),
    'a static import of an optional peer crashes before any message can print');
  assert.match(src, /await import\('@modelcontextprotocol\/sdk/);
  assert.match(src, /npm install .*@modelcontextprotocol\/sdk/,
    'the failure must name the command that fixes it');
});

test('the test script runs on every supported Node, not just this one', () => {
  // The quoted glob `node --test "test/*.test.mjs"` is expanded by neither
  // the shell (it is quoted) nor by Node before 21. On Node 20 it is a
  // literal path that does not exist, so `npm test` exits 1 having run
  // nothing — which is how CI stayed red on four jobs while this machine
  // reported 392 passing.
  //
  // A directory argument is no better: `node --test test` resolves it as a
  // MODULE and dies on MODULE_NOT_FOUND. Bare `node --test` scans the
  // working directory and is the one form that works everywhere, PowerShell
  // included. The comment this replaces claimed the opposite, and pinned
  // the broken form in place.
  assert.equal(pkg.scripts.test.trim(), 'node --test');
});

test('files the code READS at runtime are in the tarball', () => {
  // HOUSE-RULES.md is read by bin/mem-mcp at every initialize and
  // served as MCP `instructions`. It was NOT in `files` when it was
  // added: from git everything worked, from `npm i -g cheap-mem` the
  // server would have come up with no instructions and no sign of
  // trouble — the same class of defect the rules themselves warn about.
  //
  // The check is a list, because there is no way to derive it: it is
  // the non-code files the code opens by name.
  const readAtRuntime = ['HOUSE-RULES.md'];
  for (const f of readAtRuntime) {
    assert.ok(fs.existsSync(path.join(PKG_ROOT, f)), `${f} is missing from the repo`);
    const shipped = pkg.files.some((e) => e === f || (e.endsWith('/') && f.startsWith(e)));
    assert.ok(shipped, `${f} is read at runtime but not in package.json files`);
  }
});
