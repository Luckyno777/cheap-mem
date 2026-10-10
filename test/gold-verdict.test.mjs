// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/gold-verdict.test.mjs — N9 parity ("gold nebenbei"/"Rate today"):
// src/goldlog.mjs (draw + format + append), src/today.mjs's
// pickDaily/ratedCounts/goldQuestions, POST /dashboard/gold-verdict, and
// `mem gold today`/`mem gold rate`.
//
// Not to be confused with test/verify-verdict.test.mjs: that route
// grades timeline-fact staleness/conflict, this one grades a REAL
// retrieval question drawn from the injection journal. See
// src/goldlog.mjs's header for why both exist.
//
// Red proof pinned to this worktree's starting commit
// (1d8adccfbc3d62f4a3a51edfdc2da3ab9b793de6, never `git merge-base`).
// invariant: nie-fragetext-im-repo
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { oldBinCopy } from './helpers/old-source-copy.mjs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import * as goldlog from '../src/goldlog.mjs';
import * as today from '../src/today.mjs';
import { isoWeek } from '../src/measurements.mjs';
import { lazyBrowser, browserStartProbe, waitReady, startView } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_COMMIT = '1d8adccfbc3d62f4a3a51edfdc2da3ab9b793de6';
const MEM = path.join(REPO, 'bin', 'mem');
const DOOR = ['gold-verdict-probe', String(process.pid)].join('-');

function memoryRoot({ allowWrites = true } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-verdict-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  const file = path.join(r, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (allowWrites) cfg.dashboard = { allowWrites: true };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return r;
}

async function start(scriptPath, root, env = {}) {
  const mod = await import(`${pathToFileURL(scriptPath).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', ...env,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: (route, body, extraHeaders = {}) => fetch(`${base}${route}`, {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${DOOR}`, origin: base, 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
      body,
    }),
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}

// =========================================================================
// goldlog.candidatesFrom: honest 3-way classification, pure function
// =========================================================================

test('candidatesFrom: hit/near-miss/no-hit from the REAL recorded reasons, no-signal/off/etc are not drawn', () => {
  const lines = [
    { ts: '2026-09-27T10:00:00Z', session: 's1', occasion: 'question', reason: null, sources: ['e1'] },
    { ts: '2026-09-27T11:00:00Z', session: 's2', occasion: 'question', reason: 'too-weak', sources: [] },
    { ts: '2026-09-27T12:00:00Z', session: 's3', occasion: 'question', reason: 'empty', sources: [] },
    { ts: '2026-09-27T13:00:00Z', session: 's4', occasion: 'question', reason: 'no-signal', sources: [] },
    { ts: '2026-09-27T14:00:00Z', session: 's5', occasion: 'before-edit', reason: null, sources: ['e2'] },
  ];
  const out = goldlog.candidatesFrom(lines, []);
  assert.equal(out.hit.length, 1);
  assert.equal(out['near-miss'].length, 1);
  assert.equal(out['no-hit'].length, 1);
  assert.deepEqual(out.hit[0].expected, ['e1']);
});

test('candidatesFrom: correlates a hit with the nearest real message in the SAME session, within tolerance', () => {
  const lines = [{ ts: '2026-09-27T10:00:00Z', session: 's1', occasion: 'question', reason: null, sources: ['e1'] }];
  const messages = [
    { path: 'raw/2026/09/2026-09-27T095000Z--other.jsonl.gz', line: 1, ts: '2026-09-27T10:00:01Z', text: 'wrong session, must not match' },
    { path: 'raw/2026/09/2026-09-27T100000Z--s1.jsonl.gz', line: 3, ts: '2026-09-27T10:00:02Z', text: 'the real question' },
  ];
  const out = goldlog.candidatesFrom(lines, messages);
  assert.equal(out.hit[0].question, 'the real question');
});

// =========================================================================
// today.pickDaily: deterministic per day, prefers a mixed outcome set
// =========================================================================

test('pickDaily: same day + same pool -> always the same picks', () => {
  const pool = [
    { source: 'raw-capture:hit:s1:a' }, { source: 'raw-capture:hit:s2:b' },
    { source: 'raw-capture:near-miss:s3:c' }, { source: 'raw-capture:no-hit:s4:d' },
  ];
  const now = new Date('2026-10-01T08:00:00Z');
  const a = today.pickDaily(pool, { max: 3, now });
  const b = today.pickDaily(pool, { max: 3, now });
  assert.deepEqual(a.map((c) => c.source), b.map((c) => c.source));
});

test('pickDaily: prefers a MIXED set — one hit, one near-miss, one no-hit — when all three exist', () => {
  const pool = [
    { source: 'raw-capture:hit:s1:a' }, { source: 'raw-capture:hit:s2:b' },
    { source: 'raw-capture:near-miss:s3:c' }, { source: 'raw-capture:no-hit:s4:d' },
  ];
  const picked = today.pickDaily(pool, { max: 3, now: new Date('2026-10-02T08:00:00Z') });
  const outcomes = picked.map((c) => c.source.split(':')[1]).sort();
  assert.deepEqual(outcomes, ['hit', 'near-miss', 'no-hit']);
});

test('pickDaily: a different day can rotate within a bucket that has more than one candidate', () => {
  const pool = [0, 1, 2, 3, 4].map((n) => ({ source: `raw-capture:hit:s${n}:x` }));
  const days = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((n) => today.pickDaily(pool, { max: 1, now: new Date(Date.UTC(2026, 9, 1 + n)) })[0].source);
  assert.ok(new Set(days).size > 1, 'over 10 days the pick within 5 candidates should change at least once');
});

// =========================================================================
// today.ratedCounts / goldQuestions
// =========================================================================

test('ratedCounts: only rows with a set verdict count; "this week" by the same isoWeek used elsewhere', () => {
  const now = new Date('2026-09-28T09:00:00Z');
  const rows = [
    { ts: '2026-09-28T08:00:00Z', verdict: 'correct' },
    { ts: '2026-09-24T08:00:00Z', verdict: 'wrong' },
    { ts: '2026-09-28T08:00:00Z', verdict: null },
  ];
  const r = today.ratedCounts(rows, { now, isoWeek });
  assert.equal(r.total, 2);
  assert.equal(r.thisWeek, 1);
});

test('goldQuestions: no injection journal AND no gold file -> "not measured: no injection journal", not "0 open"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-today-'));
  try {
    const r = today.goldQuestions(root, { env: { CHEAP_MEM_GOLD_FILE: path.join(root, '..', 'nowhere.jsonl') } });
    assert.equal(r.drawn.readable, false);
    assert.equal(r.drawn.reason, 'not measured: no injection journal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('goldQuestions: no live journal, but an already-drawn gold file -> candidates stay visible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-today-'));
  const goldFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-file-')), 'g.jsonl');
  try {
    const row = goldlog.buildRow({
      question: null, share: 'no', expected: ['e1'], occasion: 'question',
      source: 'raw-capture:hit:s1:x', kind: 'drawn', verdict: null,
    });
    fs.writeFileSync(goldFile, `${JSON.stringify(row)}\n`);
    const r = today.goldQuestions(root, { env: { CHEAP_MEM_GOLD_FILE: goldFile } });
    assert.equal(r.drawn.readable, true);
    assert.equal(r.candidates.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.dirname(goldFile), { recursive: true, force: true }); }
});

// =========================================================================
// goldlog format: append-only, outside-root, share:'no' never carries a question
// =========================================================================

test('checkRow: share:"no" with a question text is rejected — the one privacy rule that matters', () => {
  const row = goldlog.buildRow({ question: 'must not be here', share: 'no', expected: ['e1'], occasion: 'question', source: 'q', verdict: 'correct' });
  assert.ok(goldlog.checkRow(row).length > 0);
});

test('append: writes only ONE line, never touches an existing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-append-'));
  const target = path.join(dir, 'g.jsonl');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-root-'));
  try {
    const first = `${JSON.stringify(goldlog.buildRow({ question: null, share: 'no', expected: [], occasion: 'question', source: 'old', verdict: 'correct' }))}\n`;
    fs.writeFileSync(target, first);
    const row = goldlog.buildRow({ question: null, share: 'no', expected: ['e2'], occasion: 'question', source: 'new', verdict: 'wrong' });
    goldlog.append(target, root, row);
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.startsWith(first), 'the existing line must stay untouched at the top');
    assert.equal(content.split('\n').filter(Boolean).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// CLI: `mem gold today` / `mem gold rate`
// =========================================================================

test('mem gold help shows help, exit 0, writes nothing', () => {
  const root = memoryRoot();
  try {
    const r = spawnSync(process.execPath, [MEM, 'gold', '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mem gold today/);
    assert.match(r.stdout, /mem gold rate/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem gold today --json reads the SAME function as the dashboard (one truth)', () => {
  const root = memoryRoot();
  const goldFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-cli-')), 'g.jsonl');
  try {
    const row = goldlog.buildRow({ question: 'how does X work', share: 'no', expected: ['e1'], occasion: 'question', source: 'raw-capture:hit:s1:x', kind: 'drawn', verdict: null });
    fs.writeFileSync(goldFile, `${JSON.stringify(row)}\n`);
    const r = spawnSync(process.execPath, [MEM, 'gold', 'today', '--json', '--root', root], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_GOLD_FILE: goldFile } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].id, row.id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.dirname(goldFile), { recursive: true, force: true }); }
});

test('mem gold rate: appends one verdict, replaces_id set, existing lines untouched', () => {
  const root = memoryRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-cli-rate-'));
  const goldFile = path.join(dir, 'g.jsonl');
  try {
    const old = `${JSON.stringify(goldlog.buildRow({ question: null, share: 'no', expected: [], occasion: 'question', source: 'already-there', verdict: 'correct' }))}\n`;
    fs.writeFileSync(goldFile, old);
    const row = goldlog.buildRow({ question: 'q', share: 'no', expected: ['e1'], occasion: 'question', source: 'raw-capture:hit:s1:x', kind: 'drawn', verdict: null });
    fs.appendFileSync(goldFile, `${JSON.stringify(row)}\n`);

    const r = spawnSync(process.execPath, [MEM, 'gold', 'rate', row.id, 'correct', '--root', root], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_GOLD_FILE: goldFile } });
    assert.equal(r.status, 0, r.stderr);
    const content = fs.readFileSync(goldFile, 'utf8');
    assert.ok(content.startsWith(old));
    const lines = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[2].verdict, 'correct');
    assert.equal(lines[2].replaces_id, row.id);
    assert.equal(lines[2].question, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mem gold rate: unknown id -> non-zero exit, nothing written', () => {
  const root = memoryRoot();
  const goldFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-cli-bad-')), 'g.jsonl');
  try {
    const r = spawnSync(process.execPath, [MEM, 'gold', 'rate', 'doesnotexist', 'correct', '--root', root], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_GOLD_FILE: goldFile } });
    assert.notEqual(r.status, 0);
    assert.equal(fs.existsSync(goldFile), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// Server: POST /dashboard/gold-verdict
// =========================================================================

test('RED on the old commit: /dashboard/gold-verdict does not exist at all (404)', { timeout: 20000 }, async () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:bin/mem-serve`], { cwd: REPO, encoding: 'utf8' });
  const copy = oldBinCopy(REPO, 'mem-serve.mjs', old); // a throwaway package, nothing written into the live bin/
  const tmp = copy.script;
  const root = memoryRoot();
  let s;
  try {
    s = await start(tmp, root);
    const res = await s.post('/dashboard/gold-verdict', 'verdict=empty-correct&expected=%5B%5D');
    assert.equal(res.status, 404, 'the old commit must not answer this route at all');
  } finally { await s?.stop(); fs.rmSync(copy.dir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});
test('Positive control: the same old commit DOES answer /dashboard/verify-verdict — the probe really looks', () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:bin/mem-serve`], { cwd: REPO, encoding: 'utf8' });
  assert.match(old, /verify-verdict/);
});

test('GREEN: with writes allowed, one line is appended OUTSIDE the memory root, nothing inside it changes, question never echoed', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-target-')), 'g.jsonl');
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_GOLD_FILE: target });
    const before = fs.readdirSync(path.join(root, '.mem'));
    const res = await s.post('/dashboard/gold-verdict', new URLSearchParams({
      verdict: 'correct', occasion: 'question', source: 'raw-capture:hit:s1:x', expected: JSON.stringify(['e1']),
      question: 'A SNEAKY QUESTION, MUST NEVER BE STORED',
    }).toString());
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.state, 'ok');
    const { rows } = goldlog.read(target);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, 'correct');
    assert.equal(rows[0].question, null, 'question is ALWAYS null — the server never even reads that field');
    assert.deepEqual(fs.readdirSync(path.join(root, '.mem')).sort(), before.sort());
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /SNEAKY QUESTION/);
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a target under the memory root is refused (500), nothing written', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  const insideTarget = path.join(root, 'gold.jsonl');
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_GOLD_FILE: insideTarget });
    const res = await s.post('/dashboard/gold-verdict', 'verdict=empty-correct&expected=%5B%5D');
    const body = await res.json();
    assert.equal(res.status, 500, JSON.stringify(body));
    assert.match(body.reason, /outside/);
    assert.equal(fs.existsSync(insideTarget), false);
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unknown verdict is refused (400), nothing written', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-target2-')), 'g.jsonl');
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_GOLD_FILE: target });
    const res = await s.post('/dashboard/gold-verdict', 'verdict=maybe-ish&expected=%5B%5D');
    assert.equal(res.status, 400);
    assert.equal(fs.existsSync(target), false);
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('with the write switch off (default), the route refuses (403) and writes nothing', { timeout: 20000 }, async () => {
  const root = memoryRoot({ allowWrites: false });
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-target3-')), 'g.jsonl');
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_GOLD_FILE: target });
    const res = await s.post('/dashboard/gold-verdict', 'verdict=empty-correct&expected=%5B%5D');
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(target), false);
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a foreign Origin is refused (403), nothing written', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-target4-')), 'g.jsonl');
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_GOLD_FILE: target });
    const res = await s.post('/dashboard/gold-verdict', 'verdict=empty-correct&expected=%5B%5D', { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(target), false);
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('GET is refused (405)', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root);
    const res = await fetch(`${s.base}/dashboard/gold-verdict`, { headers: { authorization: `Bearer ${DOOR}` } });
    assert.equal(res.status, 405);
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// Browser probe: the "Rate today" card shows the fixture candidates and
// a click writes (login off in tests — same setup as test/no-jump.test.mjs).
// =========================================================================

// The browser starts on first use, not by a top-level await (a throwing start is a named red probe).
const B = lazyBrowser();
browserStartProbe(B);

test('Browser probe: the "Rate today" card renders 3 candidates on a fixture gold file, and a click writes', { timeout: 30000 }, async (t) => {
  if (!(await B.need(t))) return;
  const { browser } = await B.get();
  const root = memoryRoot();
  const goldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gold-browser-'));
  const goldFile = path.join(goldDir, 'g.jsonl');
  t.after(() => { removeTree(root); removeTree(goldDir); });
  const rows = [
    goldlog.buildRow({ question: 'how does X work', share: 'no', expected: ['e1'], occasion: 'question', source: 'raw-capture:hit:s1:a', kind: 'drawn', verdict: null }),
    goldlog.buildRow({ question: 'how does Y work', share: 'no', expected: [], occasion: 'question', source: 'raw-capture:near-miss:s2:b', kind: 'drawn', verdict: null }),
    goldlog.buildRow({ question: null, share: 'no', expected: [], occasion: 'question', source: 'raw-capture:no-hit:s3:c', kind: 'drawn', verdict: null }),
  ];
  fs.mkdirSync(path.dirname(goldFile), { recursive: true });
  fs.writeFileSync(goldFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const { base, stop } = await startView(root, {
    CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0',
    CHEAP_MEM_SERVE_TOKEN: '', CHEAP_MEM_GOLD_FILE: goldFile,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${base}/dashboard`, { waitUntil: 'load' });
    await waitReady(page).catch(() => {});
    await page.waitForSelector('.today-gold-row', { timeout: 30000 });
    const gotRows = await page.$$('.today-gold-row');
    assert.equal(gotRows.length, 3, 'all three fixture candidates should be in the card (up to GOLD_MAX)');
    // "should be empty" (empty-correct) is never disabled.
    await page.click('.today-gold-row[data-gold-row="2"] button:has-text("should be empty")');
    await page.waitForTimeout(300);
  } finally {
    await context.close();
    await stop();
  }
  const { rows: written } = goldlog.read(goldFile);
  assert.equal(written.length, 4, 'exactly one new line was appended');
  assert.equal(written[3].verdict, 'empty-correct');
});
