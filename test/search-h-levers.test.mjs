// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Block H search levers, ported from lucky-mem (src/suchhebel.mjs,
// src/einblendschwelle.mjs there): src/searchlevers.mjs and
// src/questionsplit.mjs here, one switch `MEM_SEARCH_LEVERS`.
//
// Each lever has a probe that is red on the tree before the port (the
// switch did not exist, so the old behaviour shows) and a positive
// control that shows the probe can see anything at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as raw from '../src/raw.mjs';
import * as injection from '../src/injection.mjs';
import * as recallhook from '../src/recallhook.mjs';
import { tempDir } from './temp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');
const T = new Date('2026-09-01T00:00:00Z');

/** A small memory: one rare-word entry, six notes that share four
 * common words, two "How we deploy" decisions, and unrelated filler. */
function fixture(t) {
  const root = tempDir('cm-h-levers-', t);
  execFileSync(process.execPath, [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  memory.logEntry(root, 'error', { id: 'ekubelet001', class: 'outage', title: 'Kubelet restart loop took the node down', text: 'a bad liveness probe' }, { now: T });
  // Two notes of the same shape: a question that matches only "how"
  // scores them exactly alike — a flat field, the decoy case.
  memory.logEntry(root, 'decision', { id: 'ddeploy0001', title: 'How we deploy: blue green', choice: 'blue' }, { now: T });
  memory.logEntry(root, 'decision', { id: 'ddeploy0002', title: 'How we deploy: staged canary', choice: 'canary' }, { now: T });
  for (let i = 0; i < 6; i += 1) {
    memory.logEntry(root, 'learning', { id: `lcommon${String(i).padStart(4, '0')}`, title: `Note ${i} on the pipeline: staging rollout per cluster`, learning: 'routine' }, { now: T });
  }
  for (let i = 0; i < 34; i += 1) {
    memory.logEntry(root, 'learning', { id: `lfill${String(i).padStart(6, '0')}`, title: `Filler ${i} about lunch menus`, learning: 'nothing' }, { now: T });
  }
  return root;
}

function find(root, query, { levers, extra = [] } = {}) {
  const env = { ...process.env };
  delete env.CHEAP_MEM_ROOT;
  if (levers === undefined) delete env.MEM_SEARCH_LEVERS;
  else env.MEM_SEARCH_LEVERS = levers;
  return JSON.parse(execFileSync(process.execPath,
    [MEM, '--root', root, 'find', query, '--json', '--top', '3', ...extra], { encoding: 'utf8', env }));
}
const ids = (r) => r.hits.map((h) => h.entry?.id);

// --- H3: threshold by score gap -------------------------------------------

test('H3 rule: a flat field stays silent, a clear leader or a strong hit passes', async () => {
  const lv = await import('../src/searchlevers.mjs');
  const flat = [{ score: 8.6 }, { score: 8.3 }, { score: 7.8 }];
  assert.equal(flat.filter((h) => lv.passes(h, flat, { bar: 5 })).length, 0);
  assert.equal(lv.answerHolds(flat, { bar: 5 }), false);
  // Positive controls: the same field with the switch off is the old
  // comparison (all three over the bar), and a clear lead / a strong hit pass.
  assert.equal(flat.filter((h) => lv.passes(h, flat, { bar: 5, on: false })).length, 3);
  const lead = [{ score: 9.0 }, { score: 6.0 }];
  assert.deepEqual(lead.map((h) => lv.passes(h, lead, { bar: 5 })), [true, false]);
  const strong = [{ score: 11 }, { score: 10.9 }];
  assert.deepEqual(strong.map((h) => lv.passes(h, strong, { bar: 5 })), [true, true]);
  const exact = [{ score: 0.2, exact: ['path'] }, { score: 8.6 }, { score: 8.3 }];
  assert.equal(lv.passes(exact[0], exact, { bar: 5 }), true, 'the exact lane goes past the bar');
  // A tie at the top is no lead.
  const tie = [{ score: 9 }, { score: 9 }];
  assert.equal(lv.answerHolds(tie, { bar: 5 }), false);
  // ...unless the tied entries each carry the whole question.
  assert.equal(lv.answerHolds(tie.map((h) => ({ ...h, covered: 1 })), { bar: 5 }), true);
  assert.equal(lv.answerHolds(tie.map((h) => ({ ...h, covered: 0.5 })), { bar: 5 }), false);
  // An occasion without a row keeps the old comparison.
  assert.equal(lv.passes(flat[0], flat, { occasion: 'question', bar: 5 }), true);
});

test('H3 find bar: in units of one rare word, so it means the same at every memory size', async () => {
  const lv = await import('../src/searchlevers.mjs');
  assert.equal(lv.findBar(lv.FIND_BAR_REFERENCE_N), lv.FIND_BAR);
  assert.ok(lv.findBar(1000) < lv.FIND_BAR && lv.findBar(100000) > lv.FIND_BAR);
  // The measured case: at 1k notes "the website went dark ..." scores 4.4
  // with a clear lead (3.1 behind) — under a fixed 5.0 it fell silent.
  const smallField = [{ score: 4.4 }, { score: 3.1 }];
  assert.equal(lv.answerHolds(smallField, { bar: lv.FIND_BAR }), false, 'control: the fixed bar withholds it');
  assert.equal(lv.answerHolds(smallField, { bar: lv.findBar(1000) }), true);
  assert.equal(lv.findBar(undefined), lv.FIND_BAR, 'unknown size: the fixed bar');
});

test('H3 in mem find: a weak flat answer is withheld and said so; --weak and the switch bring it back', (t) => {
  const root = fixture(t);
  const q = 'how tall is mount kilimanjaro';
  const gated = find(root, q);
  assert.deepEqual(ids(gated), [], 'the two "How we deploy" notes match only "how": not an answer');
  assert.equal(gated.withheld, 2);
  assert.deepEqual(ids(find(root, q, { extra: ['--weak'] })).sort(), ['ddeploy0001', 'ddeploy0002']);
  assert.deepEqual(ids(find(root, q, { levers: 'off' })).sort(), ['ddeploy0001', 'ddeploy0002'],
    'switched off, mem find answers as before');
  // Positive control: a real question still gets its answer, no field added.
  const real = find(root, 'kubelet restart');
  assert.deepEqual(ids(real), ['ekubelet001']);
  assert.equal(real.withheld, undefined);
  // The text output says it withheld something, not "Nothing for".
  const env = { ...process.env };
  delete env.CHEAP_MEM_ROOT;
  delete env.MEM_SEARCH_LEVERS;
  const text = execFileSync(process.execPath, [MEM, '--root', root, 'find', q], { encoding: 'utf8', env });
  assert.match(text, /Nothing confident for .*2 weak matches withheld/);
});

test('H3 in the recall hook: an answer mem find withheld is booked as too weak, not as empty', (t) => {
  const root = tempDir('cm-h3-hook-', t);
  const env = { MEM_RH_MIN: '5', MEM_RH_SESSION: 'sess-h3' };
  // What `mem find --json` hands the hook when the gate withheld two hits.
  assert.equal(recallhook.recall(root, JSON.stringify({ hits: [], withheld: 2 }), env).out, null);
  recallhook.recall(root, JSON.stringify({ hits: [], withheld: 2 }), env).book();
  // Control: a truly empty answer is still "empty".
  recallhook.recall(root, JSON.stringify({ hits: [] }), env).book();
  const reasons = injection.read(root).lines.map((z) => z.reason);
  assert.deepEqual(reasons, [injection.REASON.TOO_WEAK, injection.REASON.EMPTY]);
});

test('H3 keeps a field of WHOLE answers: entries that each carry every typed word are shown', (t) => {
  // The gap rule alone withheld this (three versions of one decision tie
  // as flat as two irrelevant matches); coverage tells them apart.
  const root = fixture(t);
  // Thirty of them, so the shared words are common and the scores low:
  // under twice the bar, and all tied.
  const ways = Array.from({ length: 30 }, (_, i) => `way${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
  for (const [i, v] of ways.entries()) {
    memory.logEntry(root, 'decision', { id: `dpay${String(i).padStart(7, '0')}`, title: `Payment method: ${v}`, choice: v }, { now: T });
  }
  const r = find(root, 'payment method');
  assert.equal(r.hits.length, 3, JSON.stringify(r).slice(0, 300));
  assert.equal(r.withheld, undefined);
  assert.ok(r.hits.every((h) => h.covered === undefined), 'the gate input does not leak into the answer');
  // Control: by score alone (no coverage) this field would be withheld.
  return import('../src/searchlevers.mjs').then((lv) => {
    const weak = find(root, 'payment method', { extra: ['--weak'] });
    assert.equal(lv.answerHolds(weak.hits.map((h) => ({ score: h.score })), { bar: lv.findBar(43 + ways.length) }), false,
      `scores ${weak.hits.map((h) => h.score.toFixed(2)).join(' ')}`);
  });
});

// --- H1: split the question -----------------------------------------------

test('H1 splitQuestion: core words, unknown words, by-catch; null for everyday words only', async (t) => {
  const root = fixture(t);
  const { loadIndex, tokenize } = await import('../src/search.mjs');
  const qs = await import('../src/questionsplit.mjs');
  const index = loadIndex(root);
  const z = qs.splitQuestion('why did the kubelet keep restarting on the staging cluster', index);
  assert.equal(z.core[0], 'kubelet', JSON.stringify(z));
  // Common in this memory (six notes and more) -> by-catch; filler too.
  for (const w of ['staging', 'cluster', 'why', 'the']) assert.ok(z.bycatch.includes(w), `${w}: ${JSON.stringify(z)}`);
  assert.ok(z.unknown.includes('keep'), 'a word the memory does not carry is kept, but not as a core word');
  const b = qs.buildQuery('kubelet pipeline staging rollout cluster', index);
  assert.equal(b.query, 'kubelet');
  assert.equal(b.extraTerms.get(tokenize('pipeline')[0]), qs.BYCATCH_WEIGHT);
  // Only common words: not like this — the caller keeps the old question.
  assert.equal(qs.buildQuery('the pipeline staging rollout', index), null);
  assert.equal(qs.buildQuery('anything', null), null);
});

test('H1 in mem find: the rare word wins over notes that merely share the common words', (t) => {
  const root = fixture(t);
  const q = 'kubelet pipeline staging rollout cluster';
  // Before: coverage counts every typed word alike, so six notes carrying
  // the four common words outrank the one note carrying the rare word.
  assert.ok(!ids(find(root, q, { levers: 'off' })).includes('ekubelet001'), 'control: the old path misses it');
  assert.equal(ids(find(root, q, { levers: 'h1' }))[0], 'ekubelet001');
});

// --- H2: context signals reorder ------------------------------------------

test('H2: the file the session just edited moves its hit up; no signal, no change', async (t) => {
  const lv = await import('../src/searchlevers.mjs');
  const dir = tempDir('cm-h2-', t);
  const tr = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tr, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/payments.mjs' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'TypeError: idempotency key missing in checkout' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const sig = lv.contextSignals({ cwd: '/home/u/alpha', transcript: tr });
  assert.deepEqual(sig.files, ['payments.mjs']);
  assert.ok(sig.errorWords.includes('idempotency'), sig.errorWords.join(' '));
  const hits = [
    { score: 10, project: null, entry: { id: 'a', title: 'Cache sizing' } },
    { score: 9.5, project: 'alpha', entry: { id: 'b', title: 'Retry in src/payments.mjs needs an idempotency key' } },
    { score: 1, exact: ['path'], entry: { id: 'c', title: 'exact' } },
  ];
  assert.deepEqual(lv.rerank(hits, sig).map((h) => h.entry.id), ['b', 'a', 'c']);
  assert.deepEqual(lv.rerank(hits, null).map((h) => h.entry.id), ['a', 'b', 'c'], 'no signal: bit-identical order');
  assert.equal(lv.rerank(hits, sig).length, 3, 'context never adds a hit');
  // Through the hook: the same reorder reaches the injected lines.
  const json = JSON.stringify({ hits: hits.slice(0, 2).map((h, i) => ({ ...h, source: 'global/decisions.jsonl', line: i + 1 })) });
  const env = { MEM_RH_MIN: '5', MEM_SEARCH_LEVERS: 'h2', MEM_RH_CWD: '/home/u/alpha', MEM_RH_TRANSCRIPT: tr };
  const lines = recallhook.recall(null, json, env).out.hookSpecificOutput.additionalContext.split('\n');
  assert.match(lines[1], /payments\.mjs/, lines.join('\n'));
  const plain = recallhook.recall(null, json, { MEM_RH_MIN: '5', MEM_SEARCH_LEVERS: 'off' })
    .out.hookSpecificOutput.additionalContext.split('\n');
  assert.match(plain[1], /Cache sizing/, 'control: without the lever the order is the score order');
});

// --- H5: show short, load long -----------------------------------------------

test('H5: short lines, up to five, inside the byte budget, and the header says how to load', async () => {
  const lv = await import('../src/searchlevers.mjs');
  const long = 'a sentence that goes on and on, '.repeat(20);
  const hits = Array.from({ length: 7 }, (_, i) => ({
    score: 50 - i, source: 'global/learnings.jsonl', line: i + 1,
    entry: { id: `l${i}xxxxxx`, title: `Learning ${i}`, learning: long },
  }));
  const json = JSON.stringify({ hits });
  const r = recallhook.recall(null, json, { MEM_RH_MIN: '5', MEM_SEARCH_LEVERS: 'h5' });
  const text = r.out.hookSpecificOutput.additionalContext;
  const lines = text.split('\n');
  assert.ok(lines[0].includes(lv.H5_HEADER_NOTE.trim()), lines[0]);
  assert.ok(lines.length - 1 <= lv.H5_MAX && lines.length - 1 >= lv.H5_MIN, `${lines.length - 1} lines`);
  for (const l of lines.slice(1)) assert.ok(l.length <= lv.H5_CHARS + 2, `${l.length}: ${l}`);
  assert.ok(Buffer.byteLength(lines.slice(1).join('\n')) <= lv.H5_BUDGET_BYTES + 1);
  // Control: without the lever, no note in the header.
  const plain = recallhook.recall(null, json, { MEM_RH_MIN: '5', MEM_SEARCH_LEVERS: 'off' });
  assert.ok(!plain.out.hookSpecificOutput.additionalContext.includes(lv.H5_HEADER_NOTE.trim()));
});

test('H5 reloadBalance: a shown entry loaded by id later in the same session counts once', async () => {
  const lv = await import('../src/searchlevers.mjs');
  const journal = [
    { ts: '2026-09-27T10:00:00Z', occasion: 'question', reason: null, session: 's1', sources: ['global/decisions.jsonl:1', 'global/errors.jsonl:2'] },
    { ts: '2026-09-27T10:00:00Z', occasion: 'question', reason: 'too-weak', session: 's2', sources: [] },
  ];
  const t0 = Date.parse('2026-09-27T10:00:00Z');
  const lines = new Map([['s1', [
    { t: t0 + 60_000, z: { ids: ['d1'] } },
    { t: t0 + 90_000, z: { ids: ['d1', 'other'] } },
    { t: t0 + 3_600_000, z: { ids: ['e2'] } },
  ]]]);
  const place = new Map([['d1', 'global/decisions.jsonl:1'], ['e2', 'global/errors.jsonl:2']]);
  const r = lv.reloadBalance(journal, lines, place, { isToolMention: (z) => z.ids });
  assert.deepEqual(r, { shownTurns: 1, shownEntries: 2, withCapture: 1, reloaded: 1 });
});

// --- H4: learn from shown misses --------------------------------------------

test('H4: a SHOWN miss teaches only with --shown / the h4 lever; long questions and ids never', async (t) => {
  const al = await import('../src/askedlearn.mjs');
  const root = tempDir('cm-h4-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ version: 1, language: 'en', participants: { user: 'u' } }));
  memory.logEntry(root, 'decision', { id: 'dpostgres01', title: 'Chose PostgreSQL over MongoDB for the billing service', why: 'transactions matter for money' }, { now: T });
  memory.logEntry(root, 'decision', { id: 'dredis00001', title: 'Added Redis as a cache in front of the catalog', why: 'reads dominate' }, { now: T });
  for (let i = 0; i < 60; i += 1) {
    memory.logEntry(root, 'learning', { id: `lfill${String(i).padStart(6, '0')}`, title: `filler note ${i} about deploys`, learning: 'nothing' }, { now: T });
  }
  const t0 = Date.parse('2026-09-27T10:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const session = (s, question, at) => {
    const tr = path.join(root, `${s}.jsonl`);
    fs.writeFileSync(tr, [
      { type: 'user', sessionId: s, timestamp: iso(at), promptId: 'p1', message: { role: 'user', content: question } },
      { type: 'assistant', sessionId: s, timestamp: iso(at + 60_000), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'mem show dpostgres01' } }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.equal(raw.capture(root, tr, { minBytes: 0 }).status, 'captured');
    // The recall hook SHOWED something — the Redis note, not the one fetched.
    injection.book(root, { ts: iso(at).replace(/\.\d{3}Z$/, 'Z'), session: s, occasion: injection.OCCASION.QUESTION, reason: null, sources: ['global/decisions.jsonl:2'] });
  };
  session('s1', '¿por qué elegimos postgres para la facturación? 0123456789abcdef', t0);
  session('s2', `${'please read this long pasted message from the other session '.repeat(5)} facturación`, t0 + 7_200_000);
  const before = al.cases(root);
  assert.equal(before.counts.misses, 0, 'control: without --shown a shown turn is no miss (old behaviour)');
  const r = al.cases(root, { includeShown: true });
  assert.equal(r.counts.misses, 2);
  assert.equal(r.counts.longQuestion, 1, 'the pasted long message is skipped');
  assert.equal(r.cases.length, 1, al.asText(r));
  const c = r.cases[0];
  assert.equal(c.entry.id, 'dpostgres01');
  assert.equal(c.learned, al.LEARNED.SHOWN);
  assert.ok(c.words.includes('facturación'), c.words.join(' '));
  assert.ok(!c.words.includes('0123456789abcdef'), 'a hex id is never a question word');
  assert.equal(al.evidence(c).learned, 'H4-shown');
  // The lever switches it on through the CLI, without --shown.
  const env = { ...process.env, MEM_SEARCH_LEVERS: 'h4' };
  delete env.CHEAP_MEM_ROOT;
  const out = JSON.parse(execFileSync(process.execPath, [MEM, '--root', root, 'asked-learn', '--json'], { encoding: 'utf8', env }));
  assert.equal(out.cases.length, 1);
});

// --- the visible switch --------------------------------------------------------

test('mem search-levers: the state and where it comes from', (t) => {
  const root = fixture(t);
  const run = (levers) => {
    const env = { ...process.env };
    delete env.CHEAP_MEM_ROOT;
    if (levers === undefined) delete env.MEM_SEARCH_LEVERS; else env.MEM_SEARCH_LEVERS = levers;
    return JSON.parse(execFileSync(process.execPath, [MEM, '--root', root, 'search-levers', '--json'], { encoding: 'utf8', env }));
  };
  const d = run();
  assert.equal(d.source, 'default');
  assert.deepEqual(d.levers, { h1: false, h2: false, h3: true, h4: false, h5: false });
  const all = run('all');
  assert.equal(all.source, 'env');
  assert.ok(Object.values(all.levers).every(Boolean));
  assert.ok(Object.values(run('off').levers).every((v) => v === false));
  assert.deepEqual(d.reloads, { shownTurns: 0, shownEntries: 0, withCapture: 0, reloaded: 0 });
});
