// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Mask BEFORE cut (cm error 2tjgr4psniuh, counterpart lm 1dz47h8aei08).
//
// A key that crosses a cut boundary leaves a stump below its pattern's minimum length (github-token: 30),
// and the stump is no longer recognised by anything that masks AFTER the cut. Every site that shortens
// entry text must mask first. This file feeds each site a bait that straddles ITS boundary:
//   - the HEAD case: the first `keep` characters of the key lie before the cut (the stump stays);
//   - the WINDOW case: the window starts INSIDE the key (the tail without its prefix stays).
// Seven pattern families (github, jwt, anthropic, openai, aws, slack, password=). The bait is assembled at
// run time (test/helpers/mask-before-cut-bait.mjs); no key shape stands in this source.
//
// Red proof against a FIXED old commit (never a moving merge-base): the same cases run against the files
// of acff04e exported into a scratch directory; every case must LEAK there. Positive control: the bait
// is only a bait if `maskText(bait.slice(0, cut))` leaks and `maskText(bait).slice(0, cut)` does not.
// Sibling-house note: the counterpart in lucky-mem is built on its own branch.
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportCommit } from './helpers/export-commit.mjs';
import { KIND_NAMES, bait, baitTail, leaks } from './helpers/mask-before-cut-bait.mjs';
import http from 'node:http';
import zlib from 'node:zlib';
import { maskText, cutMasked, windowMasked } from '../src/outputguard.mjs';
import { guardResponse, maskBody } from '../src/servemask.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The state before the fix (cheap-mem acff04e). Pinned, never a merge-base. */
const OLD_STATE = 'acff04e377dcc729e6f390c94338570c0dedf58d';

// ------------------------------------------------------------------------------ the two trees

let oldTree = null;
function oldDir() {
  if (oldTree) return oldTree;
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-mbc-old-'));
  exportCommit(REPO, OLD_STATE, ['src', 'bin', 'package.json', 'shared'], dir);
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules')); } catch { /* none */ }
  oldTree = dir;
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  return dir;
}
const treeOf = (which) => (which === 'old' ? oldDir() : REPO);
const imp = (tree, rel) => import(pathToFileURL(path.join(tree, rel)).href);

// ------------------------------------------------------------------------------ fixtures

const templates = new Map();
const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
/** A fresh initialised memory: `mem init` runs once per tree, every case gets a copy of that. */
const mkroot = async (tree, t, prefix = 'cm-mbc-') => {
  if (!templates.has(tree)) {
    const tpl = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-mbc-tpl-'));
    process.on('exit', () => { try { fs.rmSync(tpl, { recursive: true, force: true }); } catch { /* gone */ } });
    const r = spawnSync(process.execPath, [path.join(tree, 'bin', 'mem'), 'init', '--root', tpl],
      { encoding: 'utf8', input: '', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    templates.set(tree, tpl);
  }
  // Not `tempDir`: its cleanup waits for a component-table rebuild per directory, ~0.5 s each, and this file
  // makes a hundred and more. The directories go at process exit instead.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  made.push(root);
  fs.cpSync(templates.get(tree), root, { recursive: true });
  return root;
};
/** One line straight into a drawer, past the write path (so the key sits unmasked on disk). */
async function plant(tree, root, type, obj, { project = null } = {}) {
  const memory = await imp(tree, 'src/memory.mjs');
  const p = memory.logPath(root, type, project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify({ id: `p${Math.random().toString(36).slice(2, 9)}`, ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...obj })}\n`);
}
/** Async spawn (the cases run side by side): `{ status, stdout, stderr }`, never throws on a non-zero exit. */
function run(cmd, args, { input = '', env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { c.kill(); reject(new Error(`timeout: ${cmd} ${args.slice(0, 3).join(' ')}`)); }, 90000);
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
    c.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    c.stdin.on('error', () => { /* the child did not read its input (git): fine */ });
    c.stdin.end(input);
  });
}
const mem = (tree, root, ...args) => run(process.execPath, [path.join(tree, 'bin', 'mem'), ...args, '--root', root],
  { env: { ...process.env, CHEAP_MEM_AGENT: 'mbc-test', MEM_RETRIEVE_NO_PULL: '1' } });

/** A capture whose lines carry `texts` (as the content of user lines); the key goes in AFTER the capture, past redaction. */
async function plantCapture(tree, root, texts, { extraLines = [], front = false } = {}) {
  const raw = await imp(tree, 'src/raw.mjs');
  const tp = path.join(root, 'transcript.jsonl');
  const L = [];
  const mine = [];
  texts.forEach((x, i) => mine.push(JSON.stringify({ timestamp: `2026-01-01T01:00:${String(i).padStart(2, '0')}Z`, type: 'user', message: { content: `PLACEHOLDER${i}` } })));
  if (front) L.push(...mine);
  for (let i = 0; i < 100; i += 1) L.push(JSON.stringify({ timestamp: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, type: 'user', message: { content: `filler talk number ${i}` } }));
  if (!front) L.push(...mine);
  for (const x of extraLines) L.push(x);
  fs.writeFileSync(tp, `${L.join('\n')}\n`);
  const r = raw.capture(root, tp);
  assert.equal(r.status, 'captured', JSON.stringify(r));
  const file = path.join(root, r.path);
  let body = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  texts.forEach((x, i) => { body = body.replace(`PLACEHOLDER${i}`, () => x); });
  fs.writeFileSync(file, zlib.gzipSync(body));
  return raw.listCaptures(root)[0];
}

// ------------------------------------------------------------------------------ the helper itself

test('cutMasked / windowMasked: the mask comes first, no torn marker, nothing for plain text', () => {
  for (const kind of KIND_NAMES) {
    const b = bait(kind, 100);
    assert.ok(!leaks(cutMasked(b.text, 100), b.key), `${kind}: cutMasked leaked`);
    assert.ok(leaks(b.text.slice(0, 100), b.key), `${kind}: positive control: a plain cut leaks the stump`);
    const w = baitTail(kind, 100);
    assert.ok(!leaks(windowMasked(w.text, 100, 400), w.key), `${kind}: windowMasked leaked the tail`);
    assert.ok(leaks(w.text.slice(100, 400), w.key), `${kind}: positive control: a plain window leaks the tail`);
  }
  assert.equal(cutMasked('plain words only', 5), 'plain');
  assert.equal(cutMasked('short', 50), 'short');
  assert.equal(cutMasked(null, 5), '');
  // a cut inside the marker drops the torn marker (it is not shown half)
  const m = maskText(bait('github', 60).text);
  const at = m.indexOf('[REDACTED') + 5;
  assert.ok(!/\[REDACTED:?[a-z-]*$/.test(cutMasked(m, at)), 'a torn marker is dropped');
  // a window edge inside a marker moves to the marker's start
  const w2 = windowMasked(m, at, m.length);
  assert.ok(!w2.startsWith('ED:'), 'the window does not start inside a marker');
});

test('the bait is a bait: for every family the stump / tail is NOT recognised, the whole key is', () => {
  for (const kind of KIND_NAMES) {
    const b = bait(kind, 400);
    assert.ok(!leaks(maskText(b.text), b.key), `${kind}: the whole bait is masked`);
    assert.ok(leaks(maskText(b.text.slice(0, 400)), b.key), `${kind}: mask-after-cut leaks (the bug)`);
    assert.ok(!leaks(maskText(b.text).slice(0, 400), b.key), `${kind}: mask-before-cut does not`);
    const w = baitTail(kind, 400);
    assert.ok(leaks(maskText(w.text.slice(400)), w.key), `${kind}: the tail window leaks when cut first`);
  }
});

// ------------------------------------------------------------------------------ the cases

/**
 * A case: `id` (site), `kinds` (which families), `cut` (the boundary the site cuts at), `run(ctx, b)` -> the text
 * the site shows (or writes). `mode: 'head'` feeds `bait(kind, cut)`, `mode: 'tail'` feeds `baitTail(kind, cut)`;
 * `mode: 'whole'` feeds a bait whose key lies fully in the text (no cut involved: a site that did not mask at all).
 */
const CASES = [];
const add = (c) => CASES.push({ kinds: KIND_NAMES, mode: 'head', ...c });
const J = JSON.stringify;

// ---- A. cut before mask ------------------------------------------------------------------------------------------

add({ id: 'A pure: question.line (100)', cut: 100,
  async run({ tree }, b) {
    const q = await imp(tree, 'src/question.mjs');
    return q.line({ id: 'q1', open: true, answers: [], question: b.text });
  } });

add({ id: 'A pure: bodyfields.restOfBody (120)', cut: 119,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/bodyfields.mjs');
    return m.restOfBody({ learning: b.text }, [], { type: 'learning' }).join('\n');
  } });

add({ id: 'B pure: neighbours.line (80)', cut: 80,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/neighbours.mjs');
    return m.line({ id: 'n1', ts: '2026-01-01T00:00:00Z', title: b.text });
  } });

add({ id: 'B pure: teach.short (110)', cut: 109,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/teach.mjs');
    return m.short({ title: b.text });
  } });

add({ id: 'B pure: closingreport.reportText (60)', cut: 59,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/closingreport.mjs');
    return m.reportText([{ id: 'd1', title: b.text }]);
  } });

add({ id: 'B pure: answercheck.redactExcerpt (120)', cut: 119,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/answercheck.mjs');
    return m.redactExcerpt(b.text);
  } });

add({ id: 'B pure: broadcast.note (300)', cut: 300,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/broadcast.mjs');
    return m.note({ class: 'x', title: b.text }, { trigger: 'src/a.js', source: 'errors.jsonl', line: 1 }, { from: 'tester' });
  } });

add({ id: 'B pure: source.line (50)', cut: 50,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/source.mjs');
    return m.line({ kind: 'address', id: 's1', address: 'https://example.invalid/', title: b.text });
  } });

add({ id: 'B pure: probescaffold.text (160)', cut: 160,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/probescaffold.mjs');
    return m.text({ id: 'e1', title: b.text });
  } });

add({ id: 'B pure: errorsignature (300)', cut: 300, lead: 'Error: ',
  async run({ tree }, b) {
    const m = await imp(tree, 'src/errorsignature.mjs');
    return m.errorSignature(b.text) ?? '';
  } });

add({ id: 'B pure: repetitionhint.correctPathText (remedy, no cut)', mode: 'whole',
  async run({ tree }, b) {
    const m = await imp(tree, 'src/repetitionhint.mjs');
    return `${m.correctPathText({ remedy: b.text })}\n${m.correctPathText({ text: b.text })}`;
  } });

add({ id: 'C write: source.excerpt (4000)', cut: 4000,
  async run({ tree }, b) {
    const m = await imp(tree, 'src/source.mjs');
    return m.excerpt(b.text).text;
  } });

// ---- A. raw captures: the window and the hit text ----------------------------------------------------------------

add({ id: 'A raw.snippet window END (260)', cut: 260,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const rel = await plantCapture(tree, root, [`zebra ${b.text.slice(6)}`]);
    const raw = await imp(tree, 'src/raw.mjs');
    return raw.snippet(root, rel, ['zebra']);
  } });

add({ id: 'A raw.snippet window START (the tail without its prefix)', mode: 'tail', cut: 200,
  async run({ tree, t }, b) {
    // the window starts at (index of the word) - 86; the word sits after the key
    const word = 200 + 86;
    const padded = `${b.text}${' y'.repeat(200)}`.slice(0, word) + 'zebra';
    const root = await mkroot(tree, t);
    const rel = await plantCapture(tree, root, [padded]);
    const raw = await imp(tree, 'src/raw.mjs');
    return raw.snippet(root, rel, ['zebra']);
  } });

add({ id: 'A search raw hit (400), mem find --only-raw --json', cut: 400, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plantCapture(tree, root, [b.text, 'zebra zebra zebra'], { front: true });
    const r = await mem(tree, root, 'find', 'zebra', '--only-raw', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /zebra/, 'positive control: the raw hit is there');
    return r.stdout;
  } });

add({ id: 'A timesearch.rawInWindow shortContent (240)', cut: 240,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plantCapture(tree, root, [b.text]);
    const ts = await imp(tree, 'src/timesearch.mjs');
    const r = ts.rawInWindow(root, { from: '2025-12-31T00:00:00Z', to: '2026-01-02T00:00:00Z' });
    return (r.lines ?? []).map((l) => l.text).join('\n');
  } });

// ---- A. the retrieval gateway and the MCP bridge ----------------------------------------------------------------------

/** The body of a claim reads `title — text` when both exist: the title `zebra` costs 8 characters in front. */
const LEADING = 'zebra — '.length;

add({ id: 'A retrieval.retrieve bodyChars (4000)', cut: 4000,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'learning', { title: 'zebra', text: b.text.slice(LEADING) });
    const retrieval = await imp(tree, 'src/retrieval.mjs');
    const capability = await imp(tree, 'src/capability.mjs');
    const r = retrieval.retrieve(root, 'zebra', capability.grantAll('mbc'), { top: 3 });
    assert.equal(r.claims.length, 1, 'positive control: the claim is there');
    return r.claims[0].body;
  } });

/** MCP over stdio: the calls, answered in order. */
async function bridge(tree, root, calls) {
  const lines = [J({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  let id = 10;
  for (const [name, a] of calls) lines.push(J({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  const r = await run(process.execPath, [path.join(tree, 'bin', 'mem-mcp')], {
    input: `${lines.join('\n')}\n`,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'session' },
  });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  if (replies.length < calls.length + 1) throw new Error(`bridge answered ${replies.length} times: ${String(r.stderr).slice(0, 600)}`);
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: J(x.error) }] });
}
const resultText = (res) => (res.content ?? []).map((c) => c.text).join('\n');

add({ id: 'A bin/mem-mcp mem_retrieve line (300)', cut: 300, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'learning', { title: 'zebra', text: b.text.slice(LEADING) });
    const [res] = await bridge(tree, root, [['mem_retrieve', { query: 'zebra' }]]);
    const text = resultText(res);
    assert.match(text, /zebra/, 'positive control: the claim line is there');
    return text;
  } });

// ---- A/B. questions, board, command guard, error context ---------------------------------------------------------

add({ id: 'A agents.mjs mem questions: why (90)', cut: 90, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'question', { question: 'Which door is open?', why: b.text });
    const r = await mem(tree, root, 'questions');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Which door/, 'positive control: the question is listed');
    return r.stdout;
  } });

add({ id: 'A board.tileQuestions line (60)', cut: 60,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'question', { question: b.text });
    const board = await imp(tree, 'src/board.mjs');
    const tile = board.tileQuestions(root);
    assert.match(tile.line, /1 open/, 'positive control: the question is counted');
    return tile.line;
  } });

add({ id: 'A commandguard.build: booklet title on disk (140)', cut: 140, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'error', { class: 'mishandling', title: b.text, text: 'x', command_pattern: 'rm -rf somewhere' });
    const cg = await imp(tree, 'src/commandguard.mjs');
    const rules = cg.build(root);
    assert.equal(rules.length, 1, 'positive control: the rule is there');
    const onDisk = fs.readFileSync(path.join(cg.bookletDir(root), 'rules.json'), 'utf8');
    return `${J(rules)}\n${onDisk}`;
  } });

add({ id: 'A commandguard.candidates: title (140)', cut: 140, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'error', { class: 'mishandling', title: b.text, text: 'x' });
    const cg = await imp(tree, 'src/commandguard.mjs');
    const c = cg.candidates(root);
    assert.equal(c.length, 1, 'positive control: the candidate is there');
    return c[0].title;
  } });

add({ id: 'B errorcontext.historyLines: earlier error title (60)', cut: 60,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'error', { class: 'mbc-x', title: b.text, text: 'x', file: 'src/a.js' });
    const ec = await imp(tree, 'src/errorcontext.mjs');
    const lines = ec.historyLines(root, { id: 'newerr1', class: 'mbc-x', title: 'again', file: 'src/a.js' });
    assert.ok(lines.length > 0, 'positive control: the history is there');
    return lines.join('\n');
  } });

add({ id: 'B write.mjs mem log error: "most recent" (70)', cut: 70, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'error', { class: 'mbc-y', title: b.text, text: 'x' });
    const r = await mem(tree, root, 'log', 'error', '--class', 'mbc-y', '--title', 'again', '--text', 'the same thing once more');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /this is number/, 'positive control: the repeat line is there');
    return r.stdout;
  } });

add({ id: 'B errorfixes.noteForLearning: short (70)', cut: 70,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'error', { class: 'mbc-z', title: b.text, text: 'x' });
    const ef = await imp(tree, 'src/errorfixes.mjs');
    const lines = ef.noteForLearning(root, { title: 'a lesson about mbc-z', text: 'none' });
    assert.ok(lines.length > 0, 'positive control: the note is there');
    return lines.join('\n');
  } });

// ---- B. dashboard, skill catalogue, day list ---------------------------------------------------------------------

add({ id: 'B dashboard-data.retrievalProbe body (300)', cut: 300, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'learning', { title: 'zebra', text: b.text.slice(LEADING) });
    const dd = await imp(tree, 'src/dashboard-data.mjs');
    const r = dd.retrievalProbe(root, 'zebra');
    assert.equal(r.hits?.length, 1, 'positive control: the probe finds the claim');
    return r.hits[0].body;
  } });

add({ id: 'B dashboard-data.factsAt title (160)', cut: 160, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    // the title reads `mbc.k = <value>`: the 8 characters in front cost the cut
    await plant(tree, root, 'timeline', { key: 'mbc.k', value: b.text.slice('mbc.k = '.length), valid_from: '2026-01-01' });
    const dd = await imp(tree, 'src/dashboard-data.mjs');
    const r = dd.factsAt(root, { known: '2099-01-01', valid: '2099-01-01' });
    assert.equal(r.holds?.length, 1, 'positive control: the fact holds');
    return r.holds[0].title;
  } });

add({ id: 'B dashboard-data.factsAt value (whole)', mode: 'whole',
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'timeline', { key: 'mbc.k', value: b.text, valid_from: '2026-01-01' });
    const dd = await imp(tree, 'src/dashboard-data.mjs');
    const r = dd.factsAt(root, { known: '2099-01-01', valid: '2099-01-01' });
    assert.equal(r.holds?.length, 1, 'positive control: the fact holds');
    return J(r.holds);
  } });

add({ id: 'E dashboard-data.entryWhole raw + text (whole)', mode: 'whole',
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'learning', { id: 'ewhole01', title: 'one entry', text: b.text });
    const dd = await imp(tree, 'src/dashboard-data.mjs');
    const r = dd.entryWhole(root, 'ewhole01');
    assert.ok(r.raw && r.text, 'positive control: raw line and text are there');
    return J({ raw: r.raw, text: r.text });
  } });

add({ id: 'B skillcatalog.catalogue: title (90), titleFull, fullText', cut: 89, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'skill', { title: b.text, skill: `${b.text} and more` });
    const sc = await imp(tree, 'src/skillcatalog.mjs');
    const cat = sc.catalogue(root, { env: { HOME: path.join(root, 'nohome') } });
    assert.equal(cat.entries?.length, 1, 'positive control: the skill is listed');
    const e = cat.entries[0];
    return J({ title: e.title, titleFull: e.titleFull, when: e.when, fullText: e.fullText, label: e.label });
  } });

add({ id: 'B skillregistry.skillMd description (1024) and name', cut: 1023, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'skill', { title: b.text, skill: 'body' });
    const reg = await imp(tree, 'src/skillregistry.mjs');
    const items = reg.registry(root);
    assert.equal(items.length, 1, 'positive control: the skill is registered');
    return `${reg.skillMd(items[0])}\n${J(items.map(({ entry, ...it }) => it))}\n${reg.card(items[0])}`;
  } });

add({ id: 'B appointment-today.today: duty title (120)', cut: 120,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'duty', { title: b.text, owner: 'human', due: '2020-01-01' });
    const at = await imp(tree, 'src/appointment-today.mjs');
    const r = at.today(root, { now: Date.parse('2026-10-13T10:00:00Z') });
    assert.equal(r.duties?.due?.length, 1, `positive control: the duty is due: ${J(r.duties)}`);
    return J(r.duties.due);
  } });

add({ id: 'B appointment-today.today: letter subject (100)', cut: 100,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const inbox = await imp(tree, 'src/inbox.mjs');
    const cfg = await imp(tree, 'src/config.mjs');
    const w = inbox.write(root, cfg.readConfig(root).participants, { from: 'session', to: 'user', subject: 'SUBJPLACE', text: 'hello' });
    fs.writeFileSync(w.path, fs.readFileSync(w.path, 'utf8').replace('SUBJPLACE', () => b.text));
    const at = await imp(tree, 'src/appointment-today.mjs');
    const r = at.today(root, { now: Date.parse('2026-10-13T10:00:00Z') });
    assert.equal(r.letters?.n, 1, `positive control: the letter is counted: ${J(r.letters)}`);
    return J(r.letters.subjects);
  } });

// ---- B/C. write paths, doctor, ledgers --------------------------------------------------------------

add({ id: 'C raw.capture: unreadable line (2000), kept in the capture', cut: 2000, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const raw = await imp(tree, 'src/raw.mjs');
    const tp = path.join(root, 'tr.jsonl');
    const L = [];
    for (let i = 0; i < 100; i += 1) L.push(J({ timestamp: '2026-01-01T00:00:00Z', type: 'user', message: { content: `filler ${i}` } }));
    L.push(b.text);
    fs.writeFileSync(tp, `${L.join('\n')}\n`);
    const r = raw.capture(root, tp);
    assert.equal(r.status, 'captured', J(r));
    const got = raw.readCapture(root, r.path).lines;
    assert.ok(got.some((l) => l.__unparsable), 'positive control: the unreadable line was kept');
    return J(got.filter((l) => l.__unparsable));
  } });

add({ id: 'C errorfixes.backfill: commit subject in the resolves link (120)', cut: 120, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'error', { id: 'errbf0001', class: 'mbc-b', title: 'a bug', text: 'x' });
    const git = (...a) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: root });
    assert.equal((await git('init', '-q')).status, 0);
    fs.writeFileSync(path.join(root, 'f.txt'), 'x');
    await git('add', 'f.txt');
    const c = await git('commit', '-q', '-m', `${b.text}\n\nFixes: errbf0001`);
    assert.equal(c.status, 0, c.stderr);
    const ef = await imp(tree, 'src/errorfixes.mjs');
    const r = ef.backfill(root, { repo: root });
    assert.ok(J(r).includes('errbf0001') || (r.written ?? r.trailer?.written ?? []).length >= 0, 'ran');
    const memory = await imp(tree, 'src/memory.mjs');
    const links = memory.readLog(root, 'link', { project: null }).entries.filter((l) => l.kind === 'resolves');
    assert.equal(links.length, 1, `positive control: the resolves link is written: ${J(r)}`);
    return J(links);
  } });

add({ id: 'C heartbeat.beat: what (200)', cut: 200,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const hb = await imp(tree, 'src/heartbeat.mjs');
    const r = hb.beat(root, 'mbc-agent', { what: b.text });
    assert.equal(r.written, true, J(r));
    return fs.readFileSync(path.join(root, hb.LOG), 'utf8');
  } });

add({ id: 'C shrink.setBaseline: why (200)', cut: 200,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const sh = await imp(tree, 'src/shrink.mjs');
    const st = sh.setBaseline(root, {}, { why: b.text });
    return `${J(st)}\n${fs.readFileSync(path.join(root, sh.BASELINE_FILE), 'utf8')}`;
  } });

add({ id: 'C ruledraft.run: quote of the newest error (300) in the thought', cut: 299,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    for (const [i, day] of ['08', '09', '10'].entries()) {
      await plant(tree, root, 'error', { id: `errrd000${i}`, ts: `2026-10-${day}T00:00:00Z`, class: 'mishandling', title: 'same trouble', file: 'src/r.js', ...(i === 2 ? { remedy: b.text } : {}), text: 'x' });
    }
    const rd = await imp(tree, 'src/ruledraft.mjs');
    const r = rd.run(root, { now: new Date('2026-10-13T00:00:00Z'), write: true });
    assert.equal(r.created.length, 1, `positive control: a draft was written: ${J(r)}`);
    const memory = await imp(tree, 'src/memory.mjs');
    return J(memory.readLog(root, 'thought', { project: null }).entries);
  } });

add({ id: 'B admin.mjs mem observations: query (48)', cut: 48, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const ob = await imp(tree, 'src/observations.mjs');
    const p = ob.readAll(root).path;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${J({ ts: '2026-10-01T00:00:00Z', lane: 'bm25', ids: ['a'], query: b.text })}\n`);
    const r = await mem(tree, root, 'observations');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 hit\(s\)/, 'positive control: the ledger line is listed');
    return r.stdout;
  } });

add({ id: 'B doctor.checkEntryForm: field name with whitespace (40)', cut: 40,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'learning', { title: 'x', text: 'y', [b.text]: 1 });
    const dr = await imp(tree, 'src/doctor.mjs');
    const f = dr.checkEntryForm(root);
    assert.match(J(f), /field name with whitespace/, `positive control: the finding is there: ${J(f)}`);
    return J(f);
  } });

add({ id: 'B store.readRegister: unreadable line (120)', cut: 120, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const store = await imp(tree, 'src/store.mjs');
    const p = path.join(root, store.REGISTER);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${b.text}\n`);
    const rows = store.readRegister(root);
    assert.equal(rows.length, 1, 'positive control: the broken line is returned');
    return J(rows);
  } });

add({ id: 'B shardarchive.readManifest: unreadable line (120)', cut: 120, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const sa = await imp(tree, 'src/shardarchive.mjs');
    const p = path.join(root, '.mem', sa.MANIFEST_FILE);
    const alt = [p, path.join(root, sa.MANIFEST_FILE), path.join(root, 'global', sa.MANIFEST_FILE)];
    for (const q of alt) { fs.mkdirSync(path.dirname(q), { recursive: true }); fs.writeFileSync(q, `${b.text}\n`); }
    const rows = sa.readManifest(root);
    assert.equal(rows.length, 1, 'positive control: the broken line is returned');
    return J(rows);
  } });

// ---- E. output that went past the guarded out() ---------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

add({ id: 'E mem context: current facts block (stdout)', mode: 'whole',
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'timeline', { key: 'mbc.k', value: b.text, valid_from: today() });
    const r = await mem(tree, root, 'context');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mbc\.k/, 'positive control: the fact line is in the block');
    return r.stdout;
  } });

add({ id: 'E mem core: stable facts (stdout)', mode: 'whole',
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'timeline', { key: 'mbc.k', value: b.text, valid_from: today() });
    const r = await mem(tree, root, 'core');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mbc\.k/, 'positive control: the fact line is in the block');
    return r.stdout;
  } });

add({ id: 'E mem raw show: the capture lines (stdout)', mode: 'whole',
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const rel = await plantCapture(tree, root, [b.text]);
    const r = await mem(tree, root, 'raw', 'show', rel);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /filler talk number 1/, 'positive control: the lines are printed');
    return r.stdout;
  } });

for (const sub of ['all', 'new']) {
  add({ id: `E mem inbox ${sub}: subject (whole)`, mode: 'whole', kinds: ['github', 'jwt', 'password'],
    async run({ tree, t }, b) {
      const root = await mkroot(tree, t);
      const inbox = await imp(tree, 'src/inbox.mjs');
      const cfg = await imp(tree, 'src/config.mjs');
      const w = inbox.write(root, cfg.readConfig(root).participants, { from: 'session', to: 'user', subject: 'SUBJPLACE', text: 'hello' });
      fs.writeFileSync(w.path, fs.readFileSync(w.path, 'utf8').replace('SUBJPLACE', () => b.text));
      const r = await mem(tree, root, 'inbox', sub, '--as', 'user');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /from session/, 'positive control: the message is listed');
      return r.stdout;
    } });
}

add({ id: 'B setup.mjs mem net --derived: listed titles (50)', cut: 50, kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const shared = 'quokka narwhal axolotl platypus pangolin capybara wombat ocelot manatee lemur tapir okapi';
    await plant(tree, root, 'learning', { title: b.text, text: shared });
    await plant(tree, root, 'learning', { title: 'second one', text: shared });
    for (let i = 0; i < 30; i += 1) await plant(tree, root, 'learning', { title: `filler ${i}`, text: `alpha beta gamma delta word${i}x common stuff here` });
    const r = await mem(tree, root, 'net', '--derived');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /borderline 1/, 'positive control: the pair is listed');
    return r.stdout;
  } });

test('the output guard is ON for every command; the exception list is short and argued', () => {
  const shell = fs.readFileSync(path.join(REPO, 'src', 'cli', 'shell.mjs'), 'utf8');
  const m = /const UNGUARDED = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\);/.exec(shell);
  assert.ok(m, 'UNGUARDED found');
  assert.deepEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), ['serve'], 'only `serve` (its setup code is what it exists to show)');
  assert.match(shell, /guardOutput = !UNGUARDED\.has\(command\)/, 'the switch is the exception list, not an allow-list');
  assert.match(shell, /let guardOutput = true;/, 'on from the start');
  const old = fs.readFileSync(path.join(oldDir(), 'src', 'cli', 'shell.mjs'), 'utf8');
  assert.doesNotMatch(/const READ_COMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(old)[1], /'suggest'|'inbox'|'teach'/, 'red proof: the old allow-list did not have them');
});

add({ id: 'E mem inbox show: the message printed byte for byte (stdout)', mode: 'whole', kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const inbox = await imp(tree, 'src/inbox.mjs');
    const cfg = await imp(tree, 'src/config.mjs');
    const w = inbox.write(root, cfg.readConfig(root).participants, { from: 'session', to: 'user', subject: 'SUBJPLACE', text: 'TEXTPLACE' });
    fs.writeFileSync(w.path, fs.readFileSync(w.path, 'utf8').replace('SUBJPLACE', () => b.text).replace('TEXTPLACE', () => b.text));
    const r = await mem(tree, root, 'inbox', 'show', w.name, '--as', 'user');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /From: session/, 'positive control: the message is printed');
    return r.stdout;
  } });

add({ id: 'E mem suggest procedure: the title in the draft command (stdout)', mode: 'whole', kinds: ['github', 'jwt', 'password'],
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    await plant(tree, root, 'error', { class: 'mishandling', title: b.text, text: 'x' });
    const r = await mem(tree, root, 'suggest', 'procedure', 'mishandling');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mem log procedure/, 'positive control: the draft is printed');
    return r.stdout;
  } });

add({ id: 'C rewrites.lock: reason (200)', cut: 200,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const rw = await imp(tree, 'src/rewrites.mjs');
    const p = path.join(root, rw.FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${J({ kind: 'pair', from: 'aaa', to: 'bbb', sessions: ['s1', 's2'], last: '2026-10-01T00:00:00Z', evidence: [] })}\n`);
    const r = rw.lock(root, 'aaa', 'bbb', b.text);
    assert.equal(r.written, true, `positive control: the lock was written: ${J(r)}`);
    return fs.readFileSync(p, 'utf8');
  } });

// ---- E. mem serve: every JSON answer leaves through the output guard ------------------------------------------------

/** GET `route` from a running server: `{ status, text }` (gunzipped when the answer is gzip). */
function httpGet(base, route) {
  return new Promise((resolve, reject) => {
    const u = new URL(route, base);
    const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { 'accept-encoding': 'gzip' } }, (r) => {
      const parts = [];
      r.on('data', (c) => parts.push(c));
      r.on('end', () => {
        let buf = Buffer.concat(parts);
        if (/gzip/.test(String(r.headers['content-encoding']))) buf = zlib.gunzipSync(buf);
        resolve({ status: r.statusCode, type: String(r.headers['content-type'] ?? ''), text: buf.toString('utf8') });
      });
    });
    q.on('error', reject); q.end();
  });
}

/** The routes a browser reads, with the parameters that make them answer about the planted entries. */
function serveRoutes(messageName, entryId) {
  return ['/console.json', '/desk.json', '/dashboard.json', '/dashboard/part.json?part=inbox', '/dashboard/part.json?part=experiences',
    '/dashboard/part.json?part=entries', `/dashboard/message.json?name=${encodeURIComponent(messageName)}`, `/dashboard/entry.json?id=${entryId}`,
    `/entry.json?id=${entryId}`, '/dashboard/probe.json?question=zebra', '/dashboard/facts-at.json?known=2099-01-01&valid=2099-01-01',
    '/entries.json?q=zebra', '/dashboard/skills.json', '/dashboard/appointments.json'];
}

add({ id: 'E mem serve: inbox subject/text/replies, facts, experiences (all JSON routes)', mode: 'whole', kinds: ['github', 'jwt', 'password'], serial: true,
  async run({ tree, t }, b) {
    const root = await mkroot(tree, t);
    const inbox = await imp(tree, 'src/inbox.mjs');
    const cfg = await imp(tree, 'src/config.mjs');
    const parts = cfg.readConfig(root).participants;
    const w = inbox.write(root, parts, { from: 'session', to: 'user', subject: 'SUBJPLACE', text: 'TEXTPLACE' });
    fs.writeFileSync(w.path, fs.readFileSync(w.path, 'utf8').replace('SUBJPLACE', () => b.text).replace('TEXTPLACE', () => b.text));
    const r2 = inbox.write(root, parts, { from: 'user', to: 'session', subject: 'REPLYSUBJ', text: 'REPLYTEXT', inReplyTo: w.name });
    fs.writeFileSync(r2.path, fs.readFileSync(r2.path, 'utf8').replace('REPLYSUBJ', () => b.text).replace('REPLYTEXT', () => b.text));
    await plant(tree, root, 'timeline', { key: 'mbc.k', value: b.text, valid_from: '2026-01-01' });
    await plant(tree, root, 'learning', { id: 'servelrn1', title: b.text, text: `zebra ${b.text}` });
    await plant(tree, root, 'learning', { id: 'servelrn2', title: 'zebra cited', learning: b.text });
    const serve = await imp(tree, 'bin/mem-serve');
    const s = await serve.serve(root, { ...process.env, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' }, { allowWrites: false });
    try {
      const base = `http://127.0.0.1:${s.server.address().port}`;
      const got = [];
      for (const route of serveRoutes(w.name, 'servelrn1')) {
        const r = await httpGet(base, route);
        got.push({ route, ...r });
      }
      assert.ok(got.some((g) => g.status === 200 && g.text.includes('mbc.k') ), 'positive control: the planted fact is served somewhere');
      assert.ok(got.filter((g) => g.status === 200 && /json/.test(g.type)).length >= 8, `positive control: most routes answered: ${got.map((g) => `${g.route}=${g.status}`).join(' ')}`);
      return got.map((g) => g.text).join('\n');
    } finally { await new Promise((r) => { s.server.close(r); s.server.closeAllConnections?.(); }); }
  } });

test('servemask: JSON is masked, an answer without a key is byte for byte unchanged, gzip stays gzip, other types pass', async () => {
  const b = bait('github', 200);
  const plain = JSON.stringify({ a: 1, list: ['x', 'y'], note: 'no key here' }, null, 2);
  assert.equal(maskBody(plain, false), plain, 'an unchanged string comes back as the very same string');
  const buf = zlib.gzipSync(plain);
  assert.equal(maskBody(buf, true), buf, 'an unchanged gzip body comes back as the very same buffer');
  const dirty = JSON.stringify({ subject: b.text, n: 2 });
  const clean = maskBody(dirty, false);
  assert.ok(leaks(dirty, b.key), 'positive control: the document carries the key');
  assert.ok(!leaks(clean, b.key) && JSON.parse(clean).n === 2, 'masked, still valid JSON');
  const gz = maskBody(zlib.gzipSync(dirty), true);
  assert.ok(!leaks(zlib.gunzipSync(gz).toString(), b.key), 'a gzip body is unpacked, masked, packed again');
  // through a real response object
  const server = http.createServer((req, res) => {
    guardResponse(res);
    if (req.url === '/json') res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(dirty) }).end(dirty);
    else res.writeHead(200, { 'content-type': 'text/plain' }).end(b.text);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const j = await httpGet(base, '/json');
    assert.ok(!leaks(j.text, b.key), 'JSON route: masked, and a fixed content-length did not break the answer');
    const p = await httpGet(base, '/plain');
    assert.ok(leaks(p.text, b.key), 'control: a non-JSON answer is not touched by this guard');
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); }
});

test('mem-serve: every request runs through guardResponse before any route can answer', () => {
  const src = fs.readFileSync(path.join(REPO, 'bin', 'mem-serve'), 'utf8');
  const m = /function handler\(req, res\) \{\n\s*guardResponse\(res\);/.exec(src);
  assert.ok(m, 'guardResponse(res) is the first statement of the one request handler');
  assert.equal((src.match(/http\.createServer\(/g) ?? []).length, 1, 'one server, one handler');
  assert.match(src, /http\.createServer\(handler\)/, 'the server is created with that handler');
  const old = fs.readFileSync(path.join(oldDir(), 'bin', 'mem-serve'), 'utf8');
  assert.ok(!/guardResponse/.test(old), 'red proof: the old server had no such exit');
});

// ---- an open PEM block (no END line in view) -------------------------------------------------------------------------

const pemLines = (n) => Array.from({ length: n }, (_, i) => Buffer.from(`pem-probe-line-${String(i).padStart(4, '0')}-${'AbCdEfGhIjKlMnOpQrStUvWxYz'.repeat(2)}`).toString('base64'));

/** How many of the first key lines survive `questiontext.prepare` on a PEM block whose END lies beyond the 8000 bound. */
async function pemLinesKept(tree) {
  const lines = pemLines(200);
  const text = `Why does this fail? ${['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')}\n${lines.join('\n')}\n${['-----END', 'RSA PRIVATE KEY-----'].join(' ')}\nthanks`;
  assert.ok(text.indexOf('-----END') > 8000, 'the END line lies beyond the 8000 bound');
  const m = await imp(tree, 'src/questiontext.mjs');
  const out = m.prepare(text, { env: {} }).question;
  return lines.slice(0, 20).filter((l) => out.includes(l)).length;
}
test('new tree: C questiontext.prepare: an open PEM block cut by the 8000 bound keeps no key line', async () => {
  assert.equal(await pemLinesKept(REPO), 0);
});
test('old acff04e (red proof): C questiontext.prepare: the open PEM block survives (positive control)', async () => {
  assert.ok(await pemLinesKept(oldDir()) >= 10, 'about 2000 characters of key material stay in the old question');
});

test('an open PEM block: header and key material fall, a header alone in prose does not, a complete block still falls whole', async () => {
  const { redact } = await import('../src/redaction.mjs');
  const lines = pemLines(4);
  const head = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const open = redact(`note ${head}\n${lines.join('\n')}`).text;
  assert.ok(!lines.some((l) => open.includes(l)) && /REDACTED:pem-block/.test(open), `open block masked: ${open}`);
  const esc = redact(`{"text":"${head}\\n${lines.join('\\n')}\\n"}`).text;
  assert.ok(!lines.some((l) => esc.includes(l)), 'the JSON-escaped form too');
  assert.ok(esc.endsWith('"}'), `and the string around it survives: ${esc}`);
  const prose = `a ${['-----BEGIN', 'CERTIFICATE-----'].join(' ')} line starts the block, then words follow.`;
  assert.equal(redact(prose).text, prose, 'a header alone in prose is not touched');
  const whole = redact(`${head}\n${lines[0]}\n${['-----END', 'PRIVATE KEY-----'].join(' ')} after`).text;
  assert.equal(whole, '[REDACTED:pem-block] after', 'a complete block falls whole, as before');
  const old = await imp(oldDir(), 'src/redaction.mjs');
  assert.ok(lines.some((l) => old.redact(`note ${head}\n${lines.join('\n')}`).text.includes(l)), 'red proof: the old tree leaves the open block');
});

// ---- the runner -----------------------------------------------------------------------------------------------------

function inputFor(c, kind) {
  if (c.mode === 'tail') return baitTail(kind, c.cut);
  if (c.mode === 'whole') return bait(kind, 60, { tail: ' tail' });
  return bait(kind, c.cut, { lead: c.lead ?? '' });
}
async function outcome(which, c, kind, t) {
  const b = inputFor(c, kind);
  const out = await c.run({ tree: treeOf(which), t, which }, b);
  return { out: String(out), leaked: leaks(out, b.key), b };
}

/** Run `fn` for every kind, side by side; a case that opens a server or patches process state is `serial`. */
async function forKinds(c, fn) {
  if (c.serial) { const out = []; for (const k of c.kinds) out.push(await fn(k)); return out; }
  return Promise.all(c.kinds.map(fn));
}

for (const c of CASES) {
  test(`new tree: ${c.id}: no key fragment shows (${c.kinds.join(', ')})`, async (t) => {
    await forKinds(c, async (kind) => {
      const r = await outcome('new', c, kind, t);
      assert.ok(r.out.length > 0, `${kind}: positive control: the site shows something`);
      assert.ok(!r.leaked, `${kind}: a fragment of the key shows: ${r.out.slice(-120)}`);
    });
  });
  test(`old acff04e (red proof): ${c.id}: the key fragment leaks`, async (t) => {
    await forKinds(c, async (kind) => {
      const r = await outcome('old', c, kind, t);
      assert.ok(r.leaked, `${kind}: the old tree should leak here (the probe would not prove anything): ${r.out.slice(-120)}`);
    });
  });
}
