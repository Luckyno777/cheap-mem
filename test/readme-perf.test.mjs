// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Latency figures in the README come from ONE artifact or they are red.
//
// **The finding (2026-09-29, at 5081616).** The README said "0.027 ms
// median" and "~3 ms" for a search, docs/benchmarks said 0.048 ms, and
// docs/scale.md showed fresh processes needing 430-1719 ms to load the
// index — no figure said cold or warm, none said which commit. A number
// with no state and no commit is a rumour, so:
//   1. every latency claim in the README OUTSIDE the perf markers is red;
//   2. what sits BETWEEN the markers must equal what bench/cold-find.mjs
//      renders from bench/cold-find.json (commit, hardware, Node, size,
//      cold/warm, median/P95 live there).
// The probe is proven three ways: red against the frozen state 5081616,
// a positive control (an injected figure outside the markers is seen,
// one inside is not), and a mutated artifact no longer matches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderPerfBlock, PERF_BEGIN, PERF_END } from '../bench/cold-find.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
const ARTIFACT = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'cold-find.json'), 'utf8'));
const FROZEN = '5081616'; // fixed, never a merge-base (house rule 12)

const WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|fifty|hundred';
const CLAIMS = [
  /\d[\d.,]*\s?(?:ms|µs|us|milliseconds?|seconds?|sec|s)\b/gi,
  new RegExp(`\\b(?:${WORDS})\\s+(?:milliseconds?|seconds?)\\b`, 'gi'),
];

function outsideMarkers(text) {
  const i = text.indexOf(PERF_BEGIN);
  const j = text.indexOf(PERF_END);
  return i >= 0 && j > i ? text.slice(0, i) + text.slice(j + PERF_END.length) : text;
}

/** Latency claims in `text` outside the perf markers. A schedule ("every 15 seconds") is not a latency. */
export function unbackedClaims(text) {
  const out = [];
  const body = outsideMarkers(text);
  body.split('\n').forEach((line, n) => {
    for (const re of CLAIMS) {
      for (const m of line.matchAll(re)) {
        if (/\b(?:every|each|per)\s+~?$/i.test(line.slice(0, m.index))) continue;
        out.push(`line ${n + 1}: ${m[0]}`);
      }
    }
  });
  return out;
}

test('every latency claim in the README sits between the perf markers', () => {
  assert.deepEqual(unbackedClaims(README), []);
});

test('the block between the markers is exactly what the artifact renders', () => {
  const i = README.indexOf(PERF_BEGIN);
  const j = README.indexOf(PERF_END);
  assert.ok(i >= 0 && j > i, 'README lost its perf:begin/perf:end markers');
  assert.equal(README.slice(i, j + PERF_END.length), renderPerfBlock(ARTIFACT));
});

test('the artifact names commit, hardware, node, and per row size, state, median, P95', () => {
  const e = ARTIFACT.environment;
  for (const k of ['gitCommit', 'cpuModel', 'cpuCount', 'node']) assert.ok(e[k], `environment.${k} missing`);
  assert.ok(ARTIFACT.results.length > 0);
  for (const r of ARTIFACT.results) {
    assert.ok(Number.isInteger(r.entries));
    if (r.state === 'not-measured') { assert.ok(r.why); continue; }
    assert.ok(['cold', 'warm'].includes(r.state));
    assert.ok(Number.isFinite(r.medianMs) && Number.isFinite(r.p95Ms) && r.n >= 30, JSON.stringify(r));
  }
  const states = new Set(ARTIFACT.results.filter((r) => r.state !== 'not-measured').map((r) => r.state));
  assert.deepEqual([...states].sort(), ['cold', 'warm']);
});

test('red at the frozen state: the old README carried at least 3 unbacked latency claims', (t) => {
  let old;
  try { old = execFileSync('git', ['-C', REPO, 'show', `${FROZEN}:README.md`], { encoding: 'utf8' }); } catch {
    t.skip(`${FROZEN} not in this clone`); return;
  }
  const found = unbackedClaims(old);
  assert.ok(found.length >= 3, `expected >= 3, found ${found.length}: ${found.join('; ')}`);
});

test('positive control: a figure injected outside the markers is seen, inside is not', () => {
  const ok = 'Reading costs 0 calls.\n';
  assert.deepEqual(unbackedClaims(ok), []);
  assert.equal(unbackedClaims(`${ok}Search takes 12 ms here.\n`).length, 1);
  assert.equal(unbackedClaims(`${ok}It takes about three milliseconds.\n`).length, 1);
  assert.equal(unbackedClaims(`${ok}The watcher polls every 15 seconds.\n`).length, 0);
  assert.equal(unbackedClaims(`${PERF_BEGIN}\n| 1000 | cold | 366 ms |\n${PERF_END}\n${ok}`).length, 0);
  assert.equal(unbackedClaims(README.replace(PERF_END, `${PERF_END}\nSearch takes 12 ms here.`)).length, 1);
});

test('positive control: a changed artifact figure no longer matches the README', () => {
  const mutated = structuredClone(ARTIFACT);
  const r = mutated.results.find((x) => x.state !== 'not-measured');
  r.medianMs += 1000;
  assert.notEqual(renderPerfBlock(mutated), renderPerfBlock(ARTIFACT));
  assert.ok(!README.includes(renderPerfBlock(mutated)));
});
