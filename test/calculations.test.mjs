/**
 * Tests for bench/calculations.mjs — the latch against second calculations.
 *
 * **Why this is checked.** On 2026-09-18 the sister house found the same
 * calculation in three places on one day, and on the same day this house
 * turned out to walk every drawer twice: `checkDrawers` counted its own
 * unparsable lines four hundred lines below `checkIntegrity`, which calls
 * `scanIntegrity` for the very same walk. Nobody found that by reading;
 * the tool did, on its first run.
 *
 * **What is really at stake.** A pattern that no longer matches anything
 * finds nothing and reports quiet — the same silent no-op the invariant
 * tool had about itself, with "Covered 16 of 16" standing above six
 * markers that pointed nowhere. So the probes below check not only that a
 * duplicate is found, but that an orphaned anchor and an empty catalogue
 * come out as FINDINGS rather than as a pass.
 *
 * The house is handed in, not measured: a probe hanging off the real
 * `src/` goes red the next time something is renamed, with nothing
 * actually broken.
 */

// invariant: eine-regel-eine-stelle
// invariant: nicht-messbar-ist-nicht-null

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as c from '../bench/calculations.mjs';

const huts = [];
function hut(files, catalogueLines) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-calc-'));
  huts.push(w);
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(w, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
  }
  if (catalogueLines) {
    fs.mkdirSync(path.join(w, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(w, c.CATALOGUE),
      `${catalogueLines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  }
  return w;
}
after(() => { for (const w of huts) fs.rmSync(w, { recursive: true, force: true }); });

const ENTRY = {
  id: 'probe', kind: 'calculation', question: 'How big?',
  owner: 'src/owner.mjs', pattern: 'statSync\\(',
};

test('a second calculation in another file is found', () => {
  const w = hut({
    'src/owner.mjs': 'export const a = statSync(x);\n',
    'src/other.mjs': 'const b = statSync(y);\n',
  }, [ENTRY]);
  const r = c.check(w);
  assert.equal(r.measurable, true);
  const [hit] = r.results;
  assert.equal(hit.anchorHolds, true);
  assert.deepEqual(hit.seconds.map((s) => s.file), ['src/other.mjs']);
  assert.equal(hit.seconds[0].line, 1);
});

test('the owner itself is not a second calculation', () => {
  const w = hut({ 'src/owner.mjs': 'const a = statSync(x);\nconst b = statSync(y);\n' }, [ENTRY]);
  const [h] = c.check(w).results;
  assert.equal(h.anchorHolds, true);
  assert.deepEqual(h.seconds, []);
});

test('POSITIVE CONTROL: with no duplicate it stays quiet', () => {
  // Without this probe the previous ones would also pass a tool that
  // flags everything.
  const w = hut({
    'src/owner.mjs': 'const a = statSync(x);\n',
    'src/other.mjs': 'const b = readFileSync(y);\n',
  }, [ENTRY]);
  const [h] = c.check(w).results;
  assert.deepEqual(h.seconds, []);
});

test('an anchor that no longer fires in its owner is a finding', () => {
  // The expensive case: function renamed, pattern points nowhere, and
  // "nothing found" means nothing at all from then on.
  const w = hut({
    'src/owner.mjs': 'const a = free(x);\n',
    'src/other.mjs': 'const b = readFileSync(y);\n',
  }, [ENTRY]);
  const [h] = c.check(w).results;
  assert.equal(h.anchorHolds, false);
});

test('comments do not count — reasoning is not a calculation', () => {
  const w = hut({
    'src/owner.mjs': 'const a = statSync(x);\n',
    'src/other.mjs': '// this used to be statSync(y)\n * also statSync(z)\n# and statSync(q)\n',
  }, [ENTRY]);
  const [h] = c.check(w).results;
  assert.deepEqual(h.seconds, []);
});

test('`except` exempts a known second site', () => {
  const w = hut({
    'src/owner.mjs': 'const a = statSync(x);\n',
    'src/allowed.mjs': 'const b = statSync(y);\n',
  }, [{ ...ENTRY, except: ['src/allowed.mjs'] }]);
  const [h] = c.check(w).results;
  assert.deepEqual(h.seconds, []);
});

test('discarded entries are kept but not checked', () => {
  const w = hut({
    'src/owner.mjs': 'const a = statSync(x);\n',
    'src/other.mjs': 'const b = statSync(y);\n',
  }, [ENTRY, { ...ENTRY, id: 'old', kind: 'discarded' }]);
  const r = c.check(w);
  assert.equal(r.results.length, 1);
  assert.equal(r.discarded, 1);
});

test('a broken catalogue line is counted, not swallowed', () => {
  const w = hut({ 'src/owner.mjs': 'const a = statSync(x);\n' }, [ENTRY]);
  fs.appendFileSync(path.join(w, c.CATALOGUE), '{not json\n{"id":"no-pattern"}\n', 'utf8');
  assert.equal(c.check(w).broken, 2);
});

test('NOT MEASURABLE: a missing catalogue is not a pass', () => {
  const w = hut({ 'src/owner.mjs': 'x\n' }, null);
  assert.equal(c.check(w).measurable, false);
});

test('NOT MEASURABLE: an empty catalogue is not a pass', () => {
  const w = hut({ 'src/owner.mjs': 'x\n' }, []);
  const r = c.check(w);
  assert.equal(r.measurable, false);
  assert.match(r.why, /not a pass/);
});

test('an unusable pattern says so instead of quietly finding nothing', () => {
  const w = hut({ 'src/owner.mjs': 'x\n' }, [{ ...ENTRY, pattern: '([' }]);
  const [h] = c.check(w).results;
  assert.match(h.error, /unusable pattern/);
});

test('test/ is not searched — a probe may rebuild a calculation', () => {
  const w = hut({
    'src/owner.mjs': 'const a = statSync(x);\n',
    'test/probe.test.mjs': 'const b = statSync(y);\n',
  }, [ENTRY]);
  const [h] = c.check(w).results;
  assert.deepEqual(h.seconds, []);
});

test('the real house holds: every calculation lives in exactly one place', () => {
  // The actual latch. If this goes red, a second calculation has
  // appeared — or an anchor is pointing into empty space.
  // fileURLToPath, not URL.pathname. Measured on the windows-latest
  // runner on 2026-09-19 (run 230, 4 red): the pathname is
  // "/D:/a/cheap-mem/cheap-mem/" with a leading slash, and path.resolve
  // then glues the current drive in front of it, so this test looked for
  //   D:\D:\a\cheap-mem\cheap-mem\shared\calculations.jsonl
  // and reported the catalogue missing — about a file that was there.
  //
  // test/init.test.mjs learned exactly this on an earlier Windows run
  // and wrote it into its own comment. The lesson stayed in that one
  // file; test/windows-paths.test.mjs now holds it for the whole tree.
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const r = c.check(root);
  assert.equal(r.measurable, true, r.why);
  assert.equal(r.broken, 0);
  for (const h of r.results) {
    assert.ok(!h.error, `${h.id}: ${h.error}`);
    assert.equal(h.anchorHolds, true, `${h.id}: anchor points into empty space`);
    assert.deepEqual(h.seconds, [], `${h.id}: second calculation`);
  }
});
