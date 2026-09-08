// What actually lands in the tarball.
//
// **The class this guards against.** A module can be written, tested,
// documented and green in CI, and still not be there after
// `npm i -g cheap-mem` — because `package.json` has a `files` list and
// nothing checks it against what the code imports. The failure appears
// only on a stranger's machine, as `ERR_MODULE_NOT_FOUND`, after the
// release. Every test in this repository runs from a checkout, where
// every file is present; not one of them can see this.
//
// So the probe walks the imports from the two entry points and asks of
// each file: would it be shipped?
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

/** Everything reachable by relative import from the entry points. */
function reachable(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let text;
    try { text = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.relative(REPO, path.resolve(path.dirname(path.join(REPO, rel)), m[1]));
      queue.push(target.split(path.sep).join('/'));
    }
  }
  return [...seen];
}

/**
 * Does the `files` list ship this path?
 *
 * The leading `./` is stripped first: `bin` entries are written
 * `./bin/mem` and `files` entries `bin/`, and comparing the two raw
 * spellings reports a shipped file as missing. Two spellings of one
 * path, which is the whole reason this file exists.
 */
function shipped(rel) {
  const p = rel.replace(/^\.\//, '');
  return (PKG.files ?? []).some((pattern) => (pattern.endsWith('/')
    ? p.startsWith(pattern)
    : p === pattern));
}

/**
 * **This is the static half.** It reads `package.json` and answers in a
 * millisecond, which is what makes it worth running on every commit.
 *
 * The other half — what npm ACTUALLY puts in the tarball, including
 * whatever `.npmignore` and the always/never rules do to it — is
 * checked by `npm pack` in the release workflow, before the publish
 * step can run. A probe that reads the manifest is not a probe of the
 * artefact, and saying so is cheaper than being wrong about it.
 */

test('POSITIVE: the walk actually reaches the modules', () => {
  // A probe that resolves nothing passes forever.
  const files = reachable(['bin/mem', 'bin/mem-mcp']);
  assert.ok(files.length >= 30, `only ${files.length} files reached — the walk is broken`);
  assert.ok(files.includes('src/memory.mjs'));
  assert.ok(files.includes('src/board.mjs'), 'a newly added module is not reached');
});

test('every module the CLI imports would be in the published package', () => {
  const missing = reachable(['bin/mem', 'bin/mem-mcp']).filter((f) => !shipped(f));
  assert.deepEqual(missing, [],
    `these are imported but not in package.json "files": ${missing.join(', ')} — `
    + 'the install would fail with ERR_MODULE_NOT_FOUND on a stranger\'s machine');
});

test('every module the CLI imports exists on disk', () => {
  // The other direction: an import of a file that was renamed away.
  // Node only notices when that code path runs, which for a rarely used
  // command can be months.
  const gone = reachable(['bin/mem', 'bin/mem-mcp'])
    .filter((f) => !fs.existsSync(path.join(REPO, f)));
  assert.deepEqual(gone, [], `imported but absent: ${gone.join(', ')}`);
});

test('every path in "files" exists', () => {
  // A stale entry is harmless to npm and misleading to a reader: it
  // reads as a promise that something is shipped.
  const gone = (PKG.files ?? []).filter((p) => !fs.existsSync(path.join(REPO, p)));
  assert.deepEqual(gone, [], `"files" names paths that do not exist: ${gone.join(', ')}`);
});

test('every declared bin exists and is executable JavaScript', () => {
  for (const [name, rel] of Object.entries(PKG.bin ?? {})) {
    const p = path.join(REPO, rel);
    assert.ok(fs.existsSync(p), `bin.${name} -> ${rel}, which does not exist`);
    const first = fs.readFileSync(p, 'utf8').split('\n')[0];
    assert.match(first, /^#!.*node/, `bin.${name} has no node shebang: ${first}`);
    assert.ok(shipped(rel), `bin.${name} -> ${rel} is not in "files"`);
  }
});

test('the version is a plain semver, and the CHANGELOG knows about it', () => {
  assert.match(PKG.version, /^\d+\.\d+\.\d+$/, 'version is not plain semver');
  const changelog = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  // Either released under this number, or still gathering under
  // Unreleased. What must never happen is a version with no entry at
  // all — that is a release nobody can read the diff of.
  assert.ok(changelog.includes(`## [${PKG.version}]`)
    || changelog.includes(`## ${PKG.version}`)
    || changelog.includes('## Unreleased'),
  `CHANGELOG mentions neither ${PKG.version} nor an Unreleased section`);
});

test('no dependency is required to install it', () => {
  // The claim in the README is "npm install pulls nothing". A
  // `dependencies` block would make that false silently — peer and dev
  // are fine, a hard dependency is not.
  assert.deepEqual(PKG.dependencies ?? {}, {},
    'cheap-mem gained a runtime dependency; the README says it has none');
});
