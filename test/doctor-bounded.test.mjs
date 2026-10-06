// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/doctor-bounded.test.mjs — the doctor does not blow the heap any more.
//
// Port of lucky-mem's test/doktor-speicherbegrenzt.test.mjs (Parity-Done:
// fe0637bb, 274824d9). Trigger there (betrieb/messung/speicher-breite-10m-
// 2026-10-06.md): at 100k entries the doctor built a full index in `index`,
// another one in `correction-content-loss`, and several findings read the
// whole corpus — 2.6 GiB, then "Map maximum size exceeded". Same shape here:
// `checkIndex`, `checkSynonyms` and `correctionLossHits` each called
// `search.loadIndex`, and `correctionLossHits` added a `byId` map over
// every document.
//
// What is claimed, and how each claim is probed:
//   1. Streaming `correctionLossHits` gives the same hits as the old
//      algorithm (a full `byId` map over all documents), chains,
//      closing corrections and a duplicate id included.
//   2. The full index is built AT MOST ONCE per doctor run (counter), and
//      `search.loadIndex` is called from exactly one place in doctor.mjs
//      (the old file had three: static red proof against a FIXED hash).
//   3. A large corpus is "not measurable" (level unknown), never a zero and
//      never a build; so are the whole-corpus findings when
//      source bytes x factor exceed the heap limit.
//   4. Memory gate: `mem doctor` in a child with a small heap on a
//      generated corpus. OLD (git archive of a fixed hash) dies, NEW runs;
//      positive control: NEW with the cap lifted dies too, so the heap limit
//      is what bites, not luck.
//   5. Old and new agree on every finding the change must not touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as authority from '../src/authority.mjs';
import * as doctor from '../src/doctor.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Fixed prior state (origin/main before this change). Never `merge-base`:
// that moves with the merge and would turn this probe red by itself.
const OLD_STATE = 'f9fd134003dbdec6e342066fbe21a060ba6bf5c5';

function tempRoot(prefix) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'), JSON.stringify({
    version: 1, language: 'en',
    participants: { user: { role: 'the human', human: true }, session: 'an AI session' },
  }));
  return w;
}

function withEnv(values, fn) {
  const before = {};
  for (const k of Object.keys(values)) before[k] = process.env[k];
  for (const [k, v] of Object.entries(values)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function oldCode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbd-old-'));
  const tar = execFileSync('git', ['archive', OLD_STATE, 'src', 'bin', 'shared', 'package.json'],
    { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return dir;
}

/** Chains: a loss, a restored loss (head holds the word), a closing correction, a duplicate id. */
function chainCorpus(prefix) {
  const w = tempRoot(prefix);
  for (let i = 0; i < 25; i += 1) {
    memory.logEntry(w, 'decision', { title: `Filler ${i}`, choice: 'filler', why: `filler text number ${i} for the flow` });
  }
  const { entry: a } = memory.logEntry(w, 'decision', {
    title: 'Old version', choice: 'x', why: 'We use quarkfrobnitz for the flow.' });
  memory.correctionEntry(w, 'decision', a.id, {
    title: 'New version', choice: 'x', why: 'We use something else for the flow.' });
  const { entry: b } = memory.logEntry(w, 'decision', {
    title: 'Second old', choice: 'y', why: 'The word zwirbelplonk belongs here.' });
  const { entry: b2 } = memory.correctionEntry(w, 'decision', b.id, {
    title: 'Second middle', choice: 'y', why: 'The word is missing now.' });
  memory.correctionEntry(w, 'decision', b2.id, {
    title: 'Second head', choice: 'y', why: 'The word zwirbelplonk belongs here again.' });
  const { entry: c } = memory.logEntry(w, 'decision', {
    title: 'Third old', choice: 'z', why: 'A "very rare quoted phrase" stays.' });
  const { entry: c2 } = memory.correctionEntry(w, 'decision', c.id, {
    title: 'Third new', choice: 'z', why: 'Nothing quoted any more.' });
  // A later line with the same id as a correction but no replaces_id: the later line wins.
  const file = memory.logPath(w, 'decision', null);
  fs.appendFileSync(file, `${JSON.stringify({ id: c2.id, ts: new Date().toISOString(), title: 'dup', choice: 'z', why: 'dup' })}\n`);
  return w;
}

/** The algorithm as it stood before this change: a full `byId` map over every document. */
function referenceHits(root) {
  const idx = search.loadIndex(root, { language: 'en' });
  const rareDf = search.RARE_DF;
  const byId = new Map();
  for (const d of idx.documents) if (d?.entry?.id) byId.set(d.entry.id, d.entry);
  const successor = new Map();
  for (const e of byId.values()) if (e.replaces_id && !memory.isClosingCorrection(e)) successor.set(e.replaces_id, e);
  const headOf = (e) => {
    let h = e; const seen = new Set();
    while (successor.has(h.id) && !seen.has(h.id)) { seen.add(h.id); h = successor.get(h.id); }
    return h;
  };
  let checked = 0; const hits = [];
  for (const entry of byId.values()) {
    if (!entry.replaces_id) continue;
    const original = byId.get(entry.replaces_id);
    if (!original) continue;
    if (memory.isClosingCorrection(entry)) continue;
    checked += 1;
    const lost = search.lostCorrectionContent(original, entry, { docFreq: idx.docFreq, rareDf });
    if (!lost.lost) continue;
    const head = headOf(entry);
    if (head.id !== entry.id && !search.lostCorrectionContent(original, head, { docFreq: idx.docFreq, rareDf }).lost) continue;
    hits.push({ from: original.id, to: entry.id, ...lost });
  }
  return { checked, hits, rareDf };
}

test('streaming correctionLossHits equals the old full-byId algorithm', () => {
  const w = chainCorpus('dbd-eq-');
  try {
    const want = referenceHits(w);
    const got = doctor.correctionLossHits(w);
    assert.ok(want.checked >= 3, `the probe needs corrections (${want.checked})`);
    assert.ok(want.hits.length >= 1, 'positive control: at least one loss is found');
    assert.deepEqual(got, want);
    // The bounded variant (the doctor finding) agrees too on a small corpus.
    assert.deepEqual(doctor.correctionLossHits(w, { bounded: true }), want);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('a large corpus is "not measurable" (unknown), builds nothing, is never zero', () => {
  const w = chainCorpus('dbd-none-');
  try {
    const before = doctor.fullIndexBuildCount();
    withEnv({ MEM_DOCTOR_FULLBUILD_MAX_MIB: '0' }, () => {
      const f = doctor.checkCorrectionContentLoss(w);
      assert.equal(f.level, 'unknown', f.text);
      assert.match(f.text, /not measurable/);
      assert.equal(doctor.doctorIndex(w).kind, 'none');
      const run = doctor.checkAll(w).findings;
      for (const name of ['index', 'correction-content-loss', 'synonyms']) {
        const x = run.find((y) => y.name === name);
        assert.equal(x.level, 'unknown', `${name}: ${x.text}`);
        assert.match(x.text, /not measurable/, name);
      }
      // The CLI path (not bounded) keeps loading the index as it always did.
      assert.ok(doctor.correctionLossHits(w).checked >= 3);
    });
    // Counter: the two bounded runs above built nothing; the unbounded CLI call built one.
    assert.equal(doctor.fullIndexBuildCount() - before, 1);
    // Positive control: the same corpus under the default cap is measured.
    const ok = doctor.checkCorrectionContentLoss(w);
    assert.equal(ok.level, 'warn', ok.text);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('the full index is built at most once per doctor run', () => {
  const w = chainCorpus('dbd-once-');
  try {
    const before = doctor.fullIndexBuildCount();
    const run = doctor.checkAll(w).findings;
    assert.equal(run.find((x) => x.name === 'index').level, 'good');
    assert.equal(run.find((x) => x.name === 'correction-content-loss').level, 'warn');
    assert.notEqual(run.find((x) => x.name === 'synonyms').level, undefined);
    assert.equal(doctor.fullIndexBuildCount() - before, 1, 'one index for index, synonyms AND correction-content-loss');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('static red proof: the old doctor loaded the index in three places, the new one in doctorIndex only', () => {
  const old = execFileSync('git', ['show', `${OLD_STATE}:src/doctor.mjs`], { cwd: REPO, encoding: 'utf8' });
  const count = (text) => (text.match(/search\.loadIndex\(/g) ?? []).length;
  assert.equal(count(old), 3);
  const current = fs.readFileSync(path.join(REPO, 'src/doctor.mjs'), 'utf8');
  assert.equal(count(current), 1);
  const body = current.slice(current.indexOf('export function doctorIndex('));
  assert.ok(body.indexOf('search.loadIndex(') < body.indexOf('\n}\n'), 'the one call sits inside doctorIndex');
});

test('whole-corpus findings say "not measurable" when source bytes x factor exceed the heap', () => {
  const w = chainCorpus('dbd-read-');
  const names = ['drawers', 'orphan-drawers', 'topic-quality', 'categories', 'skill-sharpen',
    'procedure-effect', 'integrity', 'corpus-size'];
  try {
    withEnv({ MEM_DOCTOR_FULLREAD_FACTOR: '1000000000' }, () => {
      const run = doctor.checkAll(w).findings;
      for (const n of names) {
        const f = run.find((x) => x.name === n);
        assert.ok(f, `finding ${n} must still be reported`);
        assert.equal(f.level, 'unknown', `${n}: ${f.text}`);
        assert.match(f.text, /not measurable/, n);
      }
    });
    // Positive control: with the default factor the same findings run.
    const run = doctor.checkAll(w).findings;
    for (const n of ['integrity', 'corpus-size', 'drawers']) {
      const f = run.find((x) => x.name === n);
      assert.doesNotMatch(f.text, /not measurable/, `${n}: ${f.text}`);
    }
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('old and new agree on the findings this change must not touch', async () => {
  const w = chainCorpus('dbd-parity-');
  const old = oldCode();
  try {
    // A refused retirement, so `contested-claims` has something to find.
    const target = withEnv({ [authority.CEILING_ENV]: null }, () => memory.logEntry(w, 'decision',
      { title: 'user claim', choice: 'c', why: 'w', agent: 'lucky', authority: 'user' }).entry);
    withEnv({ [authority.CEILING_ENV]: null }, () => memory.retireEntry(w, 'decision', target.id, { agent: 'someone' }));
    const oldDoctor = await import(pathToFileURL(path.join(old, 'src/doctor.mjs')).href);
    const a = oldDoctor.checkAll(w).findings;
    const b = doctor.checkAll(w).findings;
    const same = ['contested-claims', 'topic-quality', 'categories', 'integrity', 'corpus-size', 'drawers',
      'orphan-drawers', 'synonyms', 'correction-content-loss', 'skill-sharpen', 'procedure-effect', 'error-linked'];
    for (const n of same) {
      const x = a.find((y) => y.name === n);
      const y = b.find((z) => z.name === n);
      assert.ok(x && y, n);
      assert.deepEqual({ level: y.level, text: y.text }, { level: x.level, text: x.text }, n);
    }
    assert.equal(b.find((x) => x.name === 'contested-claims').level, 'warn', 'positive control: a contested claim exists');
    // `index` differs only in the timing it prints.
    assert.equal(b.find((x) => x.name === 'index').level, a.find((x) => x.name === 'index').level);
    assert.deepEqual(b.map((x) => x.name), a.map((x) => x.name), 'same findings, same order, no renames');
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
});

// --- memory gate: a child process with a small heap -------------------------

const GATE_N = 50000;
const GATE_HEAP_MIB = 128;

function doctorChild(code, root, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [`--max-old-space-size=${GATE_HEAP_MIB}`,
    path.join(code, 'bin/mem'), 'doctor', '--root', root], {
    encoding: 'utf8', timeout: 150000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return { r, sec: (Date.now() - t0) / 1000 };
}

test(`memory gate: mem doctor on ${GATE_N} entries at ${GATE_HEAP_MIB} MiB heap — OLD dies, NEW runs`, { timeout: 280000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbd-gate-'));
  const old = oldCode();
  try {
    const gen = spawnSync(process.execPath, [path.join(REPO, 'bench/heaps-corpus.mjs'), 'build', root,
      String(GATE_N), '--seed', '1337', '--budget', String(GATE_N)], { encoding: 'utf8', timeout: 120000 });
    assert.equal(gen.status, 0, gen.stderr);

    const a = doctorChild(old, root);
    assert.notEqual(a.r.status, 0, 'RED: the old doctor must die at this heap');
    assert.match(String(a.r.stderr), /heap out of memory|Allocation failed|Map maximum size/i,
      `RED must be a memory failure, not some other one: ${String(a.r.stderr).slice(-300)}`);

    const fresh = doctorChild(REPO, root);
    assert.equal(fresh.r.signal, null);
    assert.ok([0, 1, 2].includes(fresh.r.status),
      `NEW runs through (findings may be red, the process may not die): status=${fresh.r.status} ${String(fresh.r.stderr).slice(-300)}`);
    const line = (name) => String(fresh.r.stdout).split('\n').find((l) => new RegExp(`^\\S+\\s+${name}\\s`).test(l));
    assert.match(line('index') ?? '', /^\?\s+index\s+not measurable/, 'no register: not measurable, not a number');
    assert.match(line('correction-content-loss') ?? '', /^\?\s+correction-content-loss\s+not measurable/);
    assert.ok(fresh.sec < 90, `NEW took ${fresh.sec} s`);

    // Positive control: lift the cap and NEW dies as well — the heap limit is what bites.
    const p = doctorChild(REPO, root, { MEM_DOCTOR_FULLBUILD_MAX_MIB: '4096', MEM_DOCTOR_FULLREAD_FACTOR: '0.000001' });
    assert.notEqual(p.r.status, 0, 'positive control: with the guards lifted the heap limit still kills the doctor');
    assert.match(String(p.r.stderr), /heap out of memory|Allocation failed|Map maximum size/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
});
