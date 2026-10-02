// test/backlinks-wired.test.mjs — D1b: the single-entry lookup
// `dashboard.getEntryFast()` merges in the backlink index
// (`backlinks.backlinks()`, E1.4). Mirrors lucky-mem's
// test/rueckverweis-anschluss.test.mjs.
//
// Four fields:
//   measure    foreign-drawer backlinks the single-entry lookup does NOT
//              show (derived_from from another drawer/project)
//   baseline   all of them (before D1b getEntryFast() does not search
//              for them, and every answer carries `graphNote` instead)
//   target     0 on a fresh index
//   abort      the answer disagrees with the full pass
//              (dashboard.collect())
//
// Counter-probe: on the state before D1b, (a), (b) and (c) are red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as bl from '../src/backlinks.mjs';
import * as dashboard from '../src/dashboard.mjs';

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backlinks-wired-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'backlinks-wired', participants: ['someone'], language: 'en' }));
  memory.projectInit(r, 'demo'); // logEntry no longer creates a project
  return r;
}
function gone(r) { fs.rmSync(r, { recursive: true, force: true }); }

// An error in global/errors.jsonl that two FOREIGN-drawer entries derive
// from (one of them in a foreign PROJECT too), plus one hand-drawn link;
// and a learning cited by a foreign-project thought (for the per-type
// `cited` rule).
function corpus(r) {
  const target = memory.logEntry(r, 'error', { title: 'crack', text: 'the cause' }).entry;
  const lesson = memory.logEntry(r, 'learning',
    { title: 'see the crack early', origin: { derived_from: [target.id] } }).entry;
  const thought = memory.logEntry(r, 'thought',
    { text: 'a thought about the crack', origin: { derived_from: [target.id, lesson.id] } },
    { project: 'demo' }).entry;
  const event = memory.logEntry(r, 'event', { title: 'belt stop', text: 'x' }).entry;
  memory.logEntry(r, 'link', { from: event.id, to: target.id, kind: 'causes', why: 'measured' });
  return { target, lesson, thought, event };
}

function fullPass(r, id) {
  const full = dashboard.collect(r, {});
  const e = full.entries.find((x) => x.id === id);
  assert.ok(e, `dashboard.collect() does not carry '${id}' — fixture is broken`);
  return e;
}

test('(a) the single-entry lookup shows foreign-drawer and foreign-project backlinks', () => {
  const r = world();
  try {
    const { target, lesson, thought, event } = corpus(r);
    bl.update(r);
    const fast = dashboard.getEntryFast(r, target.id);
    assert.equal(fast.state, 'ok', fast.reason);
    assert.deepEqual(fast.entry.backlinks.map((l) => l.id).sort(),
      [event.id, lesson.id, thought.id].sort(),
      'foreign-drawer derived_from edges are missing from the single-entry lookup');
  } finally { gone(r); }
});

test('(b) all of them: the answer equals the full pass (cited of a learning too)', () => {
  const r = world();
  try {
    const { target, lesson, thought, event } = corpus(r);
    bl.update(r);
    for (const id of [target.id, lesson.id, thought.id, event.id]) {
      const fast = dashboard.getEntryFast(r, id);
      assert.equal(fast.state, 'ok', `id '${id}': ${fast.reason}`);
      assert.deepEqual(fast.entry, fullPass(r, id),
        `id '${id}': the single-entry lookup disagrees with the full pass (abort condition)`);
    }
  } finally { gone(r); }
});

test('(c) measure: 0 missing backlinks on a fresh index, and no graphNote any more', () => {
  const r = world();
  try {
    const { target } = corpus(r);
    bl.update(r);
    const full = fullPass(r, target.id).backlinks.map((l) => `${l.kind}:${l.id}`);
    const fast = dashboard.getEntryFast(r, target.id);
    const got = new Set(fast.entry.backlinks.map((l) => `${l.kind}:${l.id}`));
    const missing = full.filter((k) => !got.has(k));
    assert.equal(missing.length, 0, `missing backlinks: ${missing.join(', ')}`);
    assert.ok(!Object.hasOwn(fast, 'graphNote'), 'graphNote is still in the answer');
  } finally { gone(r); }
});

test('(d) no index or a stale one: warning with a reason, never a silent ok', () => {
  const r = world();
  try {
    const { target } = corpus(r);
    const none = dashboard.getEntryFast(r, target.id);
    assert.equal(none.state, 'warning');
    assert.match(none.reason, /backlink/i);
    // The locally visible edges (the 'link' drawer) are still there.
    assert.ok(none.entry.backlinks.length >= 1);

    bl.update(r);
    const wait = Date.now(); while (Date.now() - wait < 20) { /* move mtime on */ }
    memory.logEntry(r, 'thought', { text: 'new', origin: { derived_from: [target.id] } });
    const stale = dashboard.getEntryFast(r, target.id);
    assert.equal(stale.state, 'warning');
    assert.match(stale.reason, /stale/);

    bl.update(r);
    assert.equal(dashboard.getEntryFast(r, target.id).state, 'ok');
  } finally { gone(r); }
});
