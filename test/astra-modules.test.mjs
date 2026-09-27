// The structure latch for the astra module split (dashboard block
// D2-D8).
//
// **Why this exists.** The whole point of splitting `astra.mjs` into
// one module per view is that several agents can each extend one view
// without landing in the same file. That promise holds only as long as
// two things stay true going forward, not just on the day of the split:
//   1. `astra.mjs` itself defines no view — it only imports and wires
//      them, so nobody who touches a view is editing the facade file.
//   2. Each view function is defined in exactly one module — nobody
//      accidentally forked a second copy while extending one.
// Both are cheap to check and easy to lose silently the next time
// someone is in a hurry, which is exactly what a latch is for.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as astra from '../src/astra.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASTRA_FILE = path.join(REPO, 'src', 'astra.mjs');
const ASTRA_DIR = path.join(REPO, 'src', 'astra');

// The seven views this desk has today, by function name. Adding an
// eighth view means adding it here too — a probe that silently stops
// covering a new view is worse than one that never covered it.
const VIEW_FNS = ['deskView', 'knowledgeView', 'spaceView', 'projectsView',
  'agentsView', 'netView', 'setView'];

function moduleFiles() {
  return fs.readdirSync(ASTRA_DIR).filter((n) => n.endsWith('.mjs'))
    .map((n) => path.join(ASTRA_DIR, n));
}

/** How many FILES declare `function <name>(` — a definition, not a call. */
function declaringFiles(name) {
  const pattern = new RegExp(`\\bfunction ${name}\\(`);
  const files = [ASTRA_FILE, ...moduleFiles()];
  return files.filter((f) => pattern.test(fs.readFileSync(f, 'utf8')));
}

test('POSITIVE: the probe finds a view function where it lives', () => {
  // Without this, "zero files declare it" would pass for every view,
  // including the day someone deletes one by accident.
  for (const name of VIEW_FNS) {
    assert.equal(declaringFiles(name).length, 1,
      `expected exactly one file to declare ${name}, found: ${
        declaringFiles(name).map((f) => path.relative(REPO, f)).join(', ') || '(none)'}`);
  }
});

test('LATCH: astra.mjs declares no view function', () => {
  const src = fs.readFileSync(ASTRA_FILE, 'utf8');
  const found = VIEW_FNS.filter((name) => new RegExp(`\\bfunction ${name}\\(`).test(src));
  assert.deepEqual(found, [],
    `astra.mjs still declares: ${found.join(', ')} — a view landed back in the facade`);
});

test('every view lives in its own module under src/astra/', () => {
  for (const name of VIEW_FNS) {
    const owners = declaringFiles(name).filter((f) => f !== ASTRA_FILE);
    assert.equal(owners.length, 1, `${name}: expected one module, found ${owners.length}`);
    assert.ok(owners[0].startsWith(ASTRA_DIR + path.sep),
      `${name} is declared outside src/astra/: ${path.relative(REPO, owners[0])}`);
  }
});

test('no two views share a module (one view per file)', () => {
  // The other half of "one module per view": a file that declares TWO
  // of the seven would let one agent's edit collide with another's
  // exactly the way this split exists to prevent.
  const owner = new Map(); // file -> [names it declares]
  for (const name of VIEW_FNS) {
    for (const f of declaringFiles(name)) {
      if (f === ASTRA_FILE) continue;
      if (!owner.has(f)) owner.set(f, []);
      owner.get(f).push(name);
    }
  }
  const crowded = [...owner.entries()].filter(([, names]) => names.length > 1);
  assert.deepEqual(crowded, [],
    `a module declares more than one view: ${
      crowded.map(([f, names]) => `${path.relative(REPO, f)}: ${names.join(', ')}`).join('; ')}`);
});

test('the facade keeps the same exports and the same callable shape', () => {
  // The refactor promises callers nothing changes. This is the cheap
  // half of that promise — the exported NAMES; behaviour (byte-identical
  // HTML and data for a fixed fixture) is covered by the probe recorded
  // in docs/dashboard-astra-split.md, run against a detached worktree
  // of the pre-split commit rather than as a committed test file.
  assert.deepEqual(Object.keys(astra).sort(), ['LIST_MAX', 'VIEWS', 'build', 'renderHtml'].sort());
  assert.equal(typeof astra.build, 'function');
  assert.equal(typeof astra.renderHtml, 'function');
  assert.equal(astra.LIST_MAX, 400);
  assert.deepEqual([...astra.VIEWS],
    ['desk', 'knowledge', 'space', 'projects', 'agents', 'net', 'set']);
});
