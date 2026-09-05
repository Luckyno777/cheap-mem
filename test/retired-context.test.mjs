import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-retctx-')); }

test('a discarded decision leaves the always-loaded block', () => {
  // The one that mattered most: `mem context` and `mem core` are what the
  // SessionStart hook prints into EVERY session. Before this, advice the
  // user had explicitly discarded kept arriving as current, while
  // `mem find` hid it correctly — one memory, two answers.
  const r = root();
  try {
    const { entry: d } = memory.logEntry(r, 'decision', {
      title: 'use vendor X for hosting', choice: 'vendor X', why: 'cheapest',
    });
    memory.logEntry(r, 'decision', { title: 'keep the build on CI', choice: 'CI', why: 'reproducible' });
    assert.match(memory.context(r, { n: 10 }), /vendor X/, 'precondition: it starts out visible');

    memory.retireEntry(r, 'decision', d.id, { state: 'discarded', why: 'vendor X shut down' });
    const ctx = memory.context(r, { n: 10 });
    assert.ok(!ctx.includes('vendor X'), 'the discarded decision is still in the context block');
    assert.match(ctx, /keep the build on CI/, 'the live decision must survive');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the tombstone does not render as an entry of its own', () => {
  // A closing line carries only `why`, so it came out as a decision
  // reading "because vendor X shut down" — a retraction shown as if it
  // were the advice.
  const r = root();
  try {
    const { entry: d } = memory.logEntry(r, 'decision', { title: 'use vendor X', choice: 'X', why: 'cheapest' });
    memory.retireEntry(r, 'decision', d.id, { state: 'discarded', why: 'vendor X shut down' });
    assert.ok(!memory.context(r, { n: 10 }).includes('vendor X shut down'),
      'the tombstone text is being rendered as an entry');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a retired learning stops being an experience the memory stands behind', () => {
  // experiences() reads entriesById, and `mem core` prints its top
  // entries as "experience (backed by the rest of the memory)". A
  // learning discarded as wrong kept its citations and kept being shown.
  const r = root();
  try {
    const { entry: l } = memory.logEntry(r, 'learning', { title: 'always use vendor X', learning: 'it is cheapest' });
    memory.logEntry(r, 'decision', { title: 'picked X for billing', origin: { derived_from: [l.id] } });
    memory.logEntry(r, 'decision', { title: 'picked X for search', origin: { derived_from: [l.id] } });
    assert.ok(memory.experiences(r).some((e) => e.id === l.id),
      'precondition: it must start out as a cited experience');

    memory.retireEntry(r, 'learning', l.id, { state: 'discarded', why: 'this advice is now wrong' });
    assert.ok(!memory.experiences(r).some((e) => e.id === l.id),
      'a discarded learning is still listed as backed experience');
    assert.ok(!memory.core(r).includes('always use vendor X'),
      'the always-load core still carries the discarded learning');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('retiring one entry does not hide its neighbours', () => {
  // The cheap way to pass the tests above is to over-filter. This is the
  // guard against that.
  const r = root();
  try {
    const { entry: a } = memory.logEntry(r, 'error', { title: 'the first outage', text: 'dns' });
    memory.logEntry(r, 'error', { title: 'the second outage', text: 'disk' });
    memory.logEntry(r, 'error', { title: 'the third outage', text: 'memory' });
    memory.retireEntry(r, 'error', a.id, { state: 'obsolete', why: 'fixed for good' });
    const ctx = memory.context(r, { n: 10 });
    assert.match(ctx, /the second outage/);
    assert.match(ctx, /the third outage/);
    assert.ok(!ctx.includes('the first outage'));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a correction still shows, and the corrected line does not', () => {
  // A correction carries `replaces_id` AND its own content, so it must
  // stay visible — it is the current truth, not a tombstone.
  const r = root();
  try {
    const { entry: old } = memory.logEntry(r, 'decision', { title: 'deploy on fridays', choice: 'friday' });
    memory.correctionEntry(r, 'decision', old.id, { title: 'deploy on tuesdays', choice: 'tuesday' });
    const ctx = memory.context(r, { n: 10 });
    assert.match(ctx, /tuesdays/, 'the correction is the current truth and must show');
    assert.ok(!ctx.includes('fridays'), 'the superseded line must not show');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
