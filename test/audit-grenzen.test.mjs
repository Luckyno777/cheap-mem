// The scope a caller asks for, in every lane that can answer.
//
// **Where this comes from.** An external audit of commit 4ed4b90
// (2026-09-17) ran counter-probes against the public modules and found
// that three independent lanes into `search()` each carried their own
// idea of which entries may come out, and that `Capability.narrow`
// widened over two steps. Every probe below is one of those, rebuilt
// against the fixtures this repo already uses.
//
// The shape is the house's oldest defect: one question — "may this
// entry be returned?" — answered in several places, and the quietest
// answer wins because nobody reads it. The automatic recall hook goes
// through `mem find`, so the divergence reached the context an agent is
// handed, not just a CLI flag.
//
// invariant: eine-regel-eine-stelle
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as caps from '../src/capability.mjs';
import * as config from '../src/config.mjs';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

/** Two entries with the SAME literal in them, in different projects. */
function welt() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-limits-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  config.writeConfig(root, config.DEFAULT_CONFIG);
  memory.logEntry(root, 'decision', {
    id: 'scopealpha', choice: 'database alpha', text: 'src/payments.mjs',
    ts: '2026-09-01T10:00:00Z',
  }, { project: 'alpha' });
  memory.logEntry(root, 'error', {
    id: 'scopebetaa', title: 'src/payments.mjs outage', ts: '2026-09-01T10:00:00Z',
  }, { project: 'beta' });
  return root;
}
const find = (root, ...argv) => JSON.parse(execFileSync(
  'node', [path.join(PKG, 'bin', 'mem'), '--root', root, 'find', ...argv, '--json'],
  { encoding: 'utf8' }));

test('POSITIVE: without filters both entries really are findable', () => {
  // Without this, every probe below would pass against a memory that
  // simply holds nothing.
  const root = welt();
  try {
    const ids = find(root, 'src/payments.mjs').hits.map((h) => h.entry.id).sort();
    assert.deepEqual(ids, ['scopealpha', 'scopebetaa'],
      'the fixture does not hold what the probes assume');
  } finally { away(root); }
});

test('the id lane answers the scope it was asked for', () => {
  // Reproduced by the audit: asking for a BETA ERROR by id while
  // restricting to alpha decisions returned it anyway. The lane checked
  // `retired` and nothing else, so project and type were requested and
  // silently ignored.
  const root = welt();
  try {
    const idx = search.buildIndex(root);
    const fremd = search.search(idx, 'scopebetaa', { project: 'alpha', type: 'decision' });
    assert.deepEqual(fremd, [], `the id lane crossed the scope: ${JSON.stringify(fremd)}`);
    // And the counter-direction, so this is not just "the lane is dead":
    // asked within its own scope the same id still answers at once.
    const eigen = search.search(idx, 'scopebetaa', { project: 'beta', type: 'error' });
    assert.equal(eigen.length, 1, 'the id lane stopped working altogether');
    assert.equal(eigen[0].entry.id, 'scopebetaa');
  } finally { away(root); }
});

test('mem find: the exact lane does not add back what the filters removed', () => {
  // The exact lane goes in FRONT, so its hits were not merely weighted
  // differently — they overruled --project and --type.
  const root = welt();
  try {
    const hits = find(root, 'src/payments.mjs', '--project', 'alpha', '--type', 'decision').hits;
    assert.deepEqual(hits.map((h) => h.entry.id), ['scopealpha'],
      `the exact lane returned out-of-scope entries: ${JSON.stringify(hits.map((h) => h.entry.id))}`);
  } finally { away(root); }
});

test('mem find: a retired entry needs --with-retired, in the exact lane too', () => {
  const root = welt();
  try {
    memory.retireEntry(root, 'decision', 'scopealpha', { project: 'alpha' });
    const ohne = find(root, 'src/payments.mjs').hits.map((h) => h.entry.id);
    assert.deepEqual(ohne, ['scopebetaa'], `a retired entry came back unasked: ${ohne}`);
    // Positive control: with the flag it IS there. Otherwise this probe
    // would also pass if retired entries had become unreachable.
    const mit = find(root, 'src/payments.mjs', '--with-retired').hits.map((h) => h.entry.id).sort();
    assert.deepEqual(mit, ['scopealpha', 'scopebetaa'], `--with-retired lost it: ${mit}`);
  } finally { away(root); }
});

test('there is exactly ONE admission check, and every lane calls it', () => {
  // A probe over behaviour above, over structure here: the three lanes
  // agreed once before and drifted apart twice (see test/paths-agree).
  // What keeps them together is that none of them filters on its own.
  const src = fs.readFileSync(path.join(PKG, 'src', 'search.mjs'), 'utf8');
  const ohneKommentare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  assert.equal((ohneKommentare.match(/export function admits\(/g) || []).length, 1,
    'admits is declared more or less than once');
  // Both lanes inside search.mjs call it.
  assert.ok((ohneKommentare.match(/admits\(doc[,)]/g) || []).length >= 3,
    'a lane in search.mjs stopped asking admits');
  // And the project/type/retired tests must not live anywhere else in
  // this file — that is how the id lane got its private copy.
  const ausserhalb = ohneKommentare.slice(ohneKommentare.indexOf('export function search('));
  assert.equal(/doc\.retired && !withRetired/.test(ausserhalb), false,
    'a lane grew its own retired check again');
  assert.equal(/doc\.project !== target/.test(
    ausserhalb.slice(ausserhalb.indexOf('const maybeId'))), false,
  'a lane grew its own project check again');
});

// --- the capability ---------------------------------------------------

test('narrowing stays narrowing, over more than one step', () => {
  // grantAll -> project:a -> global. After the first step project:b is
  // out; after the second it was back in, because `global` in a scope
  // list together with `descendants` IS the everything-capability and
  // `admits(global)` is true for anyone who may read at all.
  const eins = caps.grantAll().narrow({ scopes: ['project:a'] });
  assert.equal(eins.admits('project:b'), false, 'the first step did not narrow');
  const zwei = eins.narrow({ scopes: ['global'] });
  assert.equal(zwei.admits('project:b'), false,
    'narrowing to global widened the capability back to everything');
  // What must NOT break: global facts stay readable from a narrowed
  // capability. A project session that cannot see the person, the
  // timezone or the setup is dumber than a global one for no benefit.
  assert.equal(eins.admits('global'), true, 'a project capability lost the global facts');
  assert.equal(zwei.admits('global'), true, 'narrowing to global lost global');
  assert.equal(eins.admits('project:a'), true, 'the capability lost its own project');
});

test('narrowing is monotone for every scope, not just the one we looked at', () => {
  // The audit found the hole with one scope. A probe pinned to that one
  // scope would pass again the next time a different pair does it.
  const alle = ['global', 'project:a', 'project:b', 'project:c'];
  const schritte = [{ scopes: ['project:a'] }, { scopes: ['global'] },
    { scopes: ['project:a', 'project:b'] }, { rights: ['read'] }];
  let cap = caps.grantAll();
  for (const schritt of schritte) {
    const vorher = alle.filter((s) => cap.admits(s));
    cap = cap.narrow(schritt);
    const nachher = alle.filter((s) => cap.admits(s));
    for (const s of nachher) {
      assert.ok(vorher.includes(s),
        `narrow(${JSON.stringify(schritt)}) ADDED ${s} — was ${vorher}, now ${nachher}`);
    }
  }
});
