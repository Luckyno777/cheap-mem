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

test('the test script matches how the tests actually run', () => {
  // `node --test` alone walks directories here and dies on MODULE_NOT_FOUND.
  assert.match(pkg.scripts.test, /test\/\*\.test\.mjs/);
});
