// test/correction-inherits.test.mjs - `mem correction` inherits the content
// fields it does not name; `--without <field>` deletes one explicitly
// (port of lucky-mem `korrektur-erbt-lm`, 2026-10-03).
//
// Reason: a correction naming only `--topics` replaced the entry WHOLE; title,
// tags and asked-words were gone and the entry dropped out of the recall.
//
// Red proof: a FIXED base commit (never `git merge-base`, it drifts with the
// merge and turns the proof itself red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const BASE = '0cec5683212e9721fdac0813f1561e50dbb6081f';

function makeRoot() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-correction-inherits-'));
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'), JSON.stringify({
    version: 1, language: 'en', participants: { user: { role: 'the human', human: true }, session: 'an AI session' },
  }));
  return w;
}
const drop = (w) => fs.rmSync(w, { recursive: true, force: true });

function run(mem, root, argv) {
  return spawnSync(process.execPath, [mem, ...argv, '--root', root], { encoding: 'utf8' });
}
const lines = (w, type) => memory.readLog(w, type, { project: null }).entries;

function seed(w) {
  return memory.logEntry(w, 'learning', {
    title: 'A learning with a title', learning: 'The body of the learning',
    asked: ['how do I build it', 'where is it'], tags: ['build', 'family'],
    topic: 'tooling', why: 'because it was measured',
    origin: { agent: 'old-writer', derived_from: ['abc'] }, valid_from: '2026-01-01',
  }).entry;
}

test('RED PROOF: at the base commit --topic alone loses the title and tags (positive control: today it does not)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-correction-base-'));
  const w = makeRoot();
  const w2 = makeRoot();
  try {
    const tar = execFileSync('git', ['archive', BASE, 'src', 'bin', 'shared', 'package.json'], { cwd: REPO, maxBuffer: 1 << 28 });
    const x = spawnSync('tar', ['-x', '-C', tmp], { input: tar });
    assert.equal(x.status, 0, String(x.stderr));
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    const a = seed(w);
    const r = run(path.join(tmp, 'bin', 'mem'), w, ['correction', 'learning', a.id, '--topic', 'tooling-2']);
    assert.equal(r.status, 0, r.stderr);
    const n = lines(w, 'learning').find((e) => e.replaces_id === a.id);
    assert.equal(n.topic, 'tooling-2');
    assert.equal(n.title, undefined, 'at the base the title is gone - that is the defect');
    assert.equal(n.tags, undefined);
    // positive control: the same input at today's tree keeps them.
    const b = seed(w2);
    const r2 = run(path.join(REPO, 'bin', 'mem'), w2, ['correction', 'learning', b.id, '--topic', 'tooling-2']);
    assert.equal(r2.status, 0, r2.stderr);
    const n2 = lines(w2, 'learning').find((e) => e.replaces_id === b.id);
    assert.equal(n2.title, b.title);
    assert.deepEqual(n2.tags, b.tags);
  } finally { drop(tmp); drop(w); drop(w2); }
});

test('only --topic named: everything else stays, the old line is untouched, administration is the new line\'s own', () => {
  const w = makeRoot();
  try {
    const a = seed(w);
    const r = run(path.join(REPO, 'bin', 'mem'), w, ['correction', 'learning', a.id, '--topic', 'tooling-2']);
    assert.equal(r.status, 0, r.stderr);
    const all = lines(w, 'learning');
    const n = all.find((e) => e.replaces_id === a.id);
    for (const f of ['title', 'learning', 'asked', 'tags', 'why']) assert.deepEqual(n[f], a[f], `field ${f} not inherited`);
    assert.equal(n.topic, 'tooling-2');
    assert.notEqual(n.id, a.id);
    assert.equal(n.replaces_id, a.id);
    assert.equal(n.origin, undefined, 'origin is a stamp, never inherited');
    assert.equal(n.valid_from, undefined, 'valid_from belongs to the new line');
    assert.deepEqual(all.find((e) => e.id === a.id), a, 'append-only: the old line stays byte-identical');
  } finally { drop(w); }
});

test('named fields override; the authority is not inherited from the old line', () => {
  const w = makeRoot();
  try {
    const a = memory.logEntry(w, 'learning', { title: 'T old', learning: 'L old', authority: 'user' }).entry;
    const b = memory.correctionEntry(w, 'learning', a.id, { title: 'T new' }).entry;
    assert.equal(b.title, 'T new');
    assert.equal(b.learning, 'L old');
    assert.notEqual(b.authority, 'user', 'a human authority must not be inherited silently');
  } finally { drop(w); }
});

test('--without deletes exactly the named field (comma list, hyphen or underscore)', () => {
  const w = makeRoot();
  try {
    const a = seed(w);
    const r = run(path.join(REPO, 'bin', 'mem'), w, ['correction', 'learning', a.id, '--topic', 'x', '--without', 'why,tags']);
    assert.equal(r.status, 0, r.stderr);
    const n = lines(w, 'learning').find((e) => e.replaces_id === a.id);
    assert.equal(n.why, undefined);
    assert.equal(n.tags, undefined);
    assert.equal(n.without, undefined, 'the switch must not become a field');
    assert.equal(n.title, a.title);
    assert.deepEqual(n.asked, a.asked);
  } finally { drop(w); }
});

test('--without and setting the same field is an error and nothing is written', () => {
  const w = makeRoot();
  try {
    const a = seed(w);
    const r = run(path.join(REPO, 'bin', 'mem'), w, ['correction', 'learning', a.id, '--why', 'new', '--without', 'why']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /at the same time/);
    assert.equal(lines(w, 'learning').length, 1);
  } finally { drop(w); }
});

test('--without alone is enough; a bare --without is refused', () => {
  const w = makeRoot();
  try {
    const a = seed(w);
    const bare = run(path.join(REPO, 'bin', 'mem'), w, ['correction', 'learning', a.id, '--without']);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /--without needs a field/);
    const r = run(path.join(REPO, 'bin', 'mem'), w, ['correction', 'learning', a.id, '--without', 'why']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(w, 'learning').find((e) => e.replaces_id === a.id).why, undefined);
  } finally { drop(w); }
});

test('administration fields are never inherited, even when the old line carries them', () => {
  const w = makeRoot();
  try {
    const a = memory.logEntry(w, 'learning', {
      title: 'T', learning: 'L', valid_from: '2026-01-01', origin: { agent: 'old-writer' },
    }).entry;
    const { entry: b } = memory.correctionEntry(w, 'learning', a.id, { title: 'T2' }, { without: ['learning'] });
    assert.equal(b.title, 'T2');
    assert.equal(b.learning, undefined, 'without removes an inherited field');
    for (const f of ['valid_from', 'origin', 'state', 'closes_id', 'retires_id']) assert.equal(b[f], undefined, f);
    assert.equal(b.replaces_id, a.id);
    assert.notEqual(b.agent, 'old-writer');
  } finally { drop(w); }
});

test('a closing correction (tombstone) inherits no content', () => {
  const w = makeRoot();
  try {
    const a = memory.logEntry(w, 'duty', { title: 'A duty', duty: 'do it' }).entry;
    const b = memory.correctionEntry(w, 'duty', a.id, { state: 'discarded', why: 'no longer needed' }).entry;
    assert.equal(b.title, undefined);
    assert.equal(b.duty, undefined);
    assert.equal(b.state, 'discarded');
  } finally { drop(w); }
});

test('an encrypted predecessor: nothing inherited, one clear warning', async () => {
  const w = makeRoot();
  try {
    const a = memory.logEntry(w, 'learning', { title: 'Secret title', learning: 'secret body text', shred: true }).entry;
    assert.ok(a.body_enc, 'precondition: the entry is encrypted');
    const warnings = [];
    const h = (x) => { if (x.code === 'CM_CORRECTION_NO_INHERIT_ENCRYPTED') warnings.push(x); };
    process.on('warning', h);
    const { entry: b } = memory.correctionEntry(w, 'learning', a.id, { title: 'Only a title' });
    await new Promise((ok) => setImmediate(ok));
    process.off('warning', h);
    // Since the shared write path (correction-write-path.test.mjs) the named
    // title is encrypted too: nothing inherited, nothing in the clear.
    assert.ok(b.body_enc);
    assert.equal(b.title, undefined);
    assert.equal(b.learning, undefined);
    assert.equal(warnings.length, 1);
  } finally { drop(w); }
});
