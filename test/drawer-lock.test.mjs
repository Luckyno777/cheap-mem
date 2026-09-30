// archiveOldest rewrites a drawer: read, decide, replace. An append that
// lands inside that window was overwritten (reproduced 2026-09-30) —
// `resolveEntry` found it neither live nor archived. Archive and append
// now share the drawer lock.
//
// Second finding: archiving only the line that RETIRES a claim made its
// target read as "active" again. Retiring lines (retires_id, closes_id,
// replaces_id) now stay in the live drawer.
//
// Red proof against the pinned pre-lock commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NEW_SRC, PRE_LOCK_COMMIT, mkTmp, url, oldSrc, runChild, waitForChild } from './filelock-fixtures.mjs';

async function load(src) {
  const memory = await import(url(src, 'memory.mjs'));
  const sa = await import(url(src, 'shardarchive.mjs'));
  const state = await import(url(src, 'state.mjs'));
  return { memory, sa, state };
}
const fresh = () => { const root = mkTmp('dl-'); process.env.CHEAP_MEM_ARCHIVE = path.join(root, 'arch'); return root; };

async function appendInWindow(src) {
  const { memory, sa } = await load(src);
  const root = fresh();
  for (let i = 0; i < 4; i++) memory.logEntry(root, 'decision', { text: `e${i}` });
  const file = memory.logPath(root, 'decision', null);
  const marks = mkTmp('dlm-'); const started = path.join(marks, 's'); const done = path.join(marks, 'd');
  let child = null; let reads = 0;
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...a) {
    const r = real.call(fs, p, ...a);
    // The read inside archiveOldest (the second one: readLog, then the raw read).
    if (p === file && ++reads === 2) {
      fs.readFileSync = real;
      child = runChild(`
        import fs from 'node:fs';
        const memory = await import(${JSON.stringify(url(src, 'memory.mjs'))});
        fs.writeFileSync(${JSON.stringify(started)}, '1');
        memory.logEntry(${JSON.stringify(root)}, 'decision', { text: 'late' });
        fs.writeFileSync(${JSON.stringify(done)}, '1');`, { CHEAP_MEM_ARCHIVE: process.env.CHEAP_MEM_ARCHIVE });
      waitForChild(started, done);
    }
    return r;
  };
  let res;
  try { res = sa.archiveOldest(root, 'decision', { count: 2 }); } finally { fs.readFileSync = real; }
  const c = await child.done;
  assert.equal(c.code, 0, c.out);
  const live = real.call(fs, file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const late = live.find((e) => e.text === 'late');
  return { archived: res.archived, liveTexts: live.map((e) => e.text), lateFound: Boolean(late) };
}

test('an append landing inside archiveOldest is not lost', async () => {
  const r = await appendInWindow(NEW_SRC);
  assert.equal(r.archived, 2);
  assert.deepEqual(r.liveTexts, ['e2', 'e3', 'late']);
});

async function retireCase(src) {
  const { memory, sa, state } = await load(src);
  const root = fresh();
  memory.logEntry(root, 'duty', { text: 'target' });
  const zid = memory.readLog(root, 'duty').entries.at(-1).id;
  memory.logEntry(root, 'decision', { retires_id: zid, state: 'done', text: 'finished' });
  const retirer = memory.readLog(root, 'decision').entries.at(-1).id;
  for (const t of ['plain1', 'plain2', 'plain3']) memory.logEntry(root, 'decision', { text: t });
  const before = state.statusOf(state.deriveState(root), zid);
  const res = sa.archiveOldest(root, 'decision', { count: 2 });
  const after = state.statusOf(state.deriveState(root), zid);
  const liveTexts = memory.readLog(root, 'decision').entries.map((e) => e.text);
  return { before, after, res, liveTexts, retirerLive: liveTexts.includes('finished'), retirer };
}

test('after archiving, a retired target stays retired; ordinary old lines still move (positive control)', async () => {
  const r = await retireCase(NEW_SRC);
  assert.equal(r.before, 'done');
  assert.equal(r.after, 'done', 'target must stay retired');
  assert.ok(r.retirerLive, 'the retiring line stays in the live drawer');
  // Positive control: the ordinary lines behind the retiring one DO get archived.
  assert.equal(r.res.archived, 2);
  assert.deepEqual(r.liveTexts, ['finished', 'plain3']);
});

test('a drawer holding only retiring lines archives nothing and says why', async () => {
  const { memory, sa } = await load(NEW_SRC);
  const root = fresh();
  memory.logEntry(root, 'duty', { text: 'target' });
  const zid = memory.readLog(root, 'duty').entries.at(-1).id;
  memory.logEntry(root, 'decision', { retires_id: zid, state: 'done', text: 'finished' });
  const res = sa.archiveOldest(root, 'decision', { count: 5 });
  assert.equal(res.archived, 0);
  assert.match(res.reason, /retiring/);
});

test(`red proof: the pre-lock commit ${PRE_LOCK_COMMIT.slice(0, 7)} loses the late append and un-retires the target`, async (t) => {
  const old = oldSrc();
  if (!old) return t.skip(`commit ${PRE_LOCK_COMMIT} not in this clone — red proof not measurable here`);
  const a = await appendInWindow(old);
  assert.equal(a.lateFound, false, 'old code must lose the late append');
  const b = await retireCase(old);
  assert.equal(b.before, 'done');
  assert.equal(b.after, 'active', 'old code must revive the target');
});
