// K1: a late done counts (E3) but is marked, never silent.
// Red proof (rule 12): at the pinned start commit the mark is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as inbox from '../src/inbox.mjs';
import * as c from '../src/claim.mjs';
import { tempDir } from './temp-dir.mjs';

const START_COMMIT = 'f9ece14f3a727e54f240ddc832b1919d3427647d';
const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };
const T0 = new Date('2026-09-30T10:00:00.000Z');
const min = (n) => new Date(T0.getTime() + n * 60_000);

function message(t) {
  const root = tempDir('cheap-mem-claim-late-', t);
  const w = inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 's', text: 'B.', now: T0 });
  return { root, name: w.name };
}

test('red proof: the start commit has no late mark', (t) => {
  let src;
  try { src = execFileSync('git', ['show', `${START_COMMIT}:src/claim.mjs`], { encoding: 'utf8', stdio: 'pipe' }); }
  catch { t.skip('start commit not in this clone — unknown, not green'); return; }
  assert.ok(!/late/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no late in the code at the start commit');
});

test('late done: still counts, and is marked', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'lib', minutes: 10, now: T0 });
  const r = c.done(root, name, { by: 'lib', claimId: a.id, now: min(20) });
  assert.equal(r.valid, true);
  assert.equal(r.status, c.STATUS.DONE);
  assert.equal(r.late, true);
  assert.equal(r.done.late, true);
  const st = c.status(root, name, { now: min(30) });
  assert.equal(st.status, 'done');
  assert.equal(st.late, true);
  assert.equal(c.check(root, name, a.id, { now: min(30) }).late, true);
});

test('late done after someone else took over: stays invalid', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'lib', minutes: 10, now: T0 });
  c.claim(root, name, { by: 'session', minutes: 10, now: min(15) });
  const r = c.done(root, name, { by: 'lib', claimId: a.id, now: min(20) });
  assert.equal(r.valid, false);
  assert.equal(r.late, false);
  assert.notEqual(r.status, c.STATUS.DONE);
});

test('done in time: no mark', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'lib', minutes: 10, now: T0 });
  const r = c.done(root, name, { by: 'lib', claimId: a.id, now: min(5) });
  assert.equal(r.valid, true);
  assert.equal(r.late, false);
  assert.equal(c.status(root, name, { now: min(30) }).late, false);
});

test('CLI: claims shows LATE', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
  const { root, name } = message(t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' }).status, 0);
  const a = c.claim(root, name, { by: 'lib', minutes: 10, now: T0 });
  c.done(root, name, { by: 'lib', claimId: a.id, now: min(20) });
  const s = spawnSync(process.execPath, [MEM, 'inbox', 'claims', name, '--root', root], { encoding: 'utf8' });
  assert.match(s.stdout, /LATE/, s.stderr);
});
