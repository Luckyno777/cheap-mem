// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The headline names an entry; it is not the entry's beginning.
//
// Counterpart of lucky-mem's decision "Lesbare Schlagzeilen in Suche und Netz"
// (branches schlagzeile-lm and schlagzeile-wahl-lm). The old rule took up to
// two filled fields from [class, title, topic, choice, ...] and joined them
// with " — ": an error read "<class> — <title>", a learning "<title> — <start
// of the text>". The new rule: exactly ONE naming field (`title`; else rule,
// question, fact; a decision its choice, else its topic); without one, the
// first whole sentence of the content, markdown removed, longer than 90
// characters cut at a word boundary with "…".
//
// Red proof: the same entries against viewer.mjs as it was at the FIXED old
// commit 0bf3ae5b (origin/main before the rule). Everything is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as viewer from '../src/viewer.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as pass from '../src/dashboard-pass.mjs';
import * as head from '../src/dashboard-head.mjs';
import * as memory from '../src/memory.mjs';
import { oldModuleCopy } from './helpers/old-source-copy.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_STATE = '0bf3ae5b6317411fa93badcfcc2b20ee50dcc250';
const NOW = new Date('2026-10-13T08:00:00Z');

/** A github-token-shaped plant, built at run time (no key shape in this source). */
const plant = () => ['gh', 'p_'].join('') + 'Q'.repeat(10) + 'z9'.repeat(10) + 'ab';

const CASES = {
  titleAndText: [{ title: 'Counter ran twice', text: 'The counter started two times. Measured on test day.' }, 'Counter ran twice'],
  classIsNoHeadline: [{ class: 'assumption-over-measurement', title: 'Counter ran twice' }, 'Counter ran twice'],
  titleAndTopic: [{ title: 'Test before rebuild', topic: 'probe-rebuild', text: 'Hold every ability against it.' }, 'Test before rebuild'],
  onlyText: [{ text: 'Short and clear. A second sentence.' }, 'Short and clear.'],
  markdown: [{ text: '`code` and **bold** in the first sentence here. Rest.' }, 'code and bold in the first sentence here.'],
  paragraphBreak: [{ text: 'First paragraph without a full stop\n\nSecond paragraph.' }, 'First paragraph without a full stop'],
  eg: [{ text: 'e.g. the counter is read twice here. More text follows.' }, 'e.g. the counter is read twice here.'],
  list: [{ text: '- first item is the one that counts here\n- second item' }, 'first item is the one that counts here'],
  fact: [{ fact: 'The probe service runs on port 4000', valid_from: '2026-10-10' }, 'The probe service runs on port 4000'],
  question: [{ question: 'How many probes does a rebuild need?', text: 'Open since test day.' }, 'How many probes does a rebuild need?'],
  decisionWithTitle: [{ title: 'Probe title of a decision', topic: 'probe-topic', choice: 'The title stays bold.' }, 'Probe title of a decision'],
  decisionNoTitle: [{ topic: 'probe-headlines', choice: '**We** build `one` place for the rule. Nothing more.', why: 'One truth.' }, 'We build one place for the rule.'],
};
const LONG = 'A probe thought without a title that is longer than ninety characters and so has to be cut at a word boundary. Second sentence.';
const LONG_WANT = 'A probe thought without a title that is longer than ninety characters and so has to be…';

test('each case reads as exactly one naming field or the first sentence', () => {
  for (const [name, [entry, want]] of Object.entries(CASES)) {
    assert.equal(viewer.headline(entry), want, name);
  }
});

test('a long first sentence is cut at 90 characters on a word boundary with an ellipsis', () => {
  const h = viewer.headline({ text: LONG });
  assert.equal(h, LONG_WANT);
  assert.ok(h.length <= viewer.HEADLINE_MAX, `${h.length} characters`);
  assert.ok(h.endsWith('…'));
});

test('"e.g." at the start does not tear the sentence (no cut inside the first twelve characters)', () => {
  assert.equal(viewer.headline({ text: 'e.g. foo bar baz. Second.' }), 'e.g. foo bar baz.');
  assert.equal(viewer.firstSentence('No. 3 is the one we mean. More.'), 'No. 3 is the one we mean.');
});

test('a decision without a title is named by its choice, or by its topic when it has no choice; type from the caller', () => {
  assert.equal(viewer.headline({ topic: 'only-topic', why: 'Fell without a choice. Second.' }, { type: 'decision' }), 'only-topic');
  assert.equal(viewer.headline({ topic: 'only-topic', why: 'Fell without a choice.' }), 'Fell without a choice.',
    'without the type the entry is no decision: the first sentence stands, the topic does not name it');
  assert.equal(viewer.headline({ topic: 'a', choice: 'Take the narrow way. Because.' }, { type: 'decision' }), 'Take the narrow way.');
});

test('a list as text reads as its first item, never as JSON', () => {
  const h = viewer.headline({ id: 'w1', steps: ['first step', 'second step'] });
  assert.equal(h, 'first step');
  const u = viewer.headline({ id: 'o1', odd: { a: [1, 2] }, other: ['x', 'y'], flag: true });
  assert.doesNotMatch(u, /[{}[\]"]/, 'no JSON cloud');
  assert.equal(viewer.headline({ id: 'e1', ts: 'x' }), '(empty entry)');
});

test('output guard: the key is masked first, then the line is cut', () => {
  const key = plant();
  const h = viewer.headline({ title: `t ${key}`, text: 'y' });
  assert.ok(h.includes('[REDACTED:github-token]') && !h.includes(key));
  const g = viewer.headline({ text: `The key is ${key} and it must not show. Rest.` });
  assert.ok(!g.includes(key) && g.includes('[REDACTED:github-token]'));
});

test('a procedure keeps its mark: name first, then who issued it', () => {
  const rule = { title: 'Always measure first', rule: 'Measure first, then claim. Second sentence.', issued_by: 'lucky', ts: '2026-09-28T09:00:00Z' };
  assert.equal(viewer.headline(rule), 'Always measure first — Procedure, issued by lucky on 2026-09-28');
  const noTitle = { rule: 'Measure first, then claim. Second sentence.', issued_by: 'lucky', ts: '2026-09-28T09:00:00Z' };
  assert.equal(viewer.headline(noTitle), 'Measure first, then claim. — Procedure, issued by lucky on 2026-09-28');
  const longRule = { rule: `${'Measure everything before you claim anything about it '.repeat(5)}end.`, issued_by: 'lucky', ts: '2026-09-28T09:00:00Z' };
  const name = viewer.headline(longRule).split(' — ')[0];
  assert.ok(name.length <= 160 && name.endsWith('…'), 'a rule names itself by its first sentence, at most 160');
  assert.match(viewer.headline(longRule), /— Procedure, issued by lucky/);
});

test('a locked entry stays locked: the word, the clear title at most, never a field from inside', () => {
  const env = { id: 'k1', ts: '2026-10-10T10:00:00Z', title: 'Probe vault title', body_enc: { v: 1, ct: 'AAAA' }, text: 'Hidden content. Second.' };
  assert.equal(viewer.headline(env), 'Probe vault title [locked]');
  assert.equal(viewer.headline({ id: 'k2', body_enc: { v: 1 }, text: 'Hidden.' }), '[locked]');
  assert.doesNotMatch(viewer.headline({ id: 'k3', body_enc: { v: 1, ct: 'AAAA' } }), /[{}]|AAAA/);
});

test('every caller: viewer rows, the dashboard rows and the entry card carry the new line (type handed through)', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-headline-rule-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  memory.logEntry(root, 'error', { class: 'assumption', title: 'Counter ran twice', text: 'Two starts. Measured.' }, { now: NOW });
  memory.logEntry(root, 'learning', { title: 'Test before rebuild', text: 'Hold every ability against it.' }, { now: NOW });
  const dec = memory.logEntry(root, 'decision', { topic: 'probe-headlines', choice: 'Only the title stays bold. The rest is detail.', why: 'Readable.' }, { now: NOW }).entry;
  const dec2 = memory.logEntry(root, 'decision', { topic: 'probe-only-topic', why: 'No choice.' }, { now: NOW }).entry;
  const secret = memory.logEntry(root, 'learning', { title: 'Vault title', text: 'Vault content. Second.', shred: true }, { now: NOW }).entry;
  const rows = viewer.collect(root);
  const by = (f) => rows.find(f)?.headline;
  assert.equal(by((r) => r.type === 'error'), 'Counter ran twice');
  assert.equal(by((r) => r.id === dec.id), 'Only the title stays bold.');
  assert.equal(by((r) => r.id === dec2.id), 'probe-only-topic', 'the viewer knows the drawer: topic names the choice-less decision');
  // The compact pass (the main build of the dashboard) reads raw lines and hands the drawer through.
  const compact = pass.atlasSearch(root).rows.map((x) => x.headline);
  // The light head (large stores) names the same way.
  const light = head.lightHead(root, { reason: 'probe', types: [], route: '/r' }).entries.map((x) => x.title);
  // The full build (dashboard.collect) hands the drawer through as well.
  const full = dashboard.collect(root).entries.map((x) => x.headline);
  for (const [name, list] of Object.entries({ compact, light, full })) {
    assert.ok(list.includes('Counter ran twice'), `${name}: title only`);
    assert.ok(list.includes('Test before rebuild'), `${name}: title only (learning)`);
    assert.ok(list.includes('Only the title stays bold.'), `${name}: first sentence of the choice`);
    assert.ok(list.includes('probe-only-topic'), `${name}: the drawer is known, the topic names the choice-less decision`);
    assert.ok(!list.some((h) => / — /.test(h)), `${name}: no two-field join`);
    assert.ok(!list.some((h) => /Vault content/.test(h)), `${name}: a locked entry shows no content`);
  }
  const card = dashboard.getEntryFast(root, dec2.id);
  assert.equal(card.entry.headline, 'probe-only-topic', 'the entry card hands the drawer through');
  const lock = dashboard.getEntryFast(root, secret.id);
  assert.doesNotMatch(JSON.stringify(lock.entry?.headline ?? ''), /Vault content/);
});

test('RED on the fixed old commit: class first, text start appended, markdown left standing', async (t) => {
  let source;
  try {
    source = execFileSync('git', ['-C', REPO, 'show', `${OLD_STATE}:src/viewer.mjs`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip(`commit ${OLD_STATE} not reachable (shallow clone?) — red proof unknown, not green`);
    return;
  }
  const copy = oldModuleCopy(path.join(REPO, 'src'), 'viewer.mjs', source);
  t.after(() => fs.rmSync(copy.dir, { recursive: true, force: true }));
  const old = await import(pathToFileURL(copy.file).href);
  // Positive control: the old code runs and gives a plain title the same line.
  assert.equal(old.headline({ title: 'Only a title' }), 'Only a title');
  // Red: for every case where the rule matters the old line differs from the new one.
  for (const name of ['titleAndText', 'classIsNoHeadline', 'titleAndTopic', 'markdown', 'decisionWithTitle', 'decisionNoTitle', 'question']) {
    const [entry, want] = CASES[name];
    assert.notEqual(old.headline(entry), want, `${name}: the old state already gives the new line, so the case measures nothing`);
    assert.equal(viewer.headline(entry), want, `${name}: green now`);
  }
  assert.equal(old.headline(CASES.classIsNoHeadline[0]), 'assumption-over-measurement — Counter ran twice');
  assert.match(old.headline(CASES.titleAndText[0]), / — The counter started/);
  assert.notEqual(old.headline({ text: LONG }), LONG_WANT, 'old: the whole text, no cut');
  assert.match(old.headline({ text: 'x', steps: ['a'] }), / — |x/);
  assert.match(old.headline({ id: 'o1', odd: { a: [1, 2] } }), /\{"a":\[1,2\]\}/, 'old: JSON cloud');
});
