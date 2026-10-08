// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Z1d: retrieve() must (a) pick candidates from permitted scopes only, so
// foreign-project entries cannot fill the candidate pool, and (b) refill
// after the author quota, so that asking for more never returns less
// (unless the hard quota forces it, and then it says so).
//
// Red proof against the fixed start commit 3d89195 (the last commit before
// this change): the same probes run against `git archive 3d89195 src` and
// must FAIL there — that is the positive control that the probe sees.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.join(import.meta.dirname, '..');
const START = '3d89195';

function mkroot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-z1d-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ version: 1, participants: { a: 'x' }, language: 'en' }));
  return r;
}

async function load(srcDir) {
  const u = (f) => pathToFileURL(path.join(srcDir, f)).href;
  return {
    memory: await import(u('memory.mjs')),
    retrieval: await import(u('retrieval.mjs')),
    capability: await import(u('capability.mjs')),
  };
}

function probes({ memory, retrieval, capability }) {
  const out = {};
  {
    const r = mkroot();
    memory.projectInit(r, 'other'); memory.projectInit(r, 'wanted');
    for (let i = 0; i < 30; i++) {
      memory.logEntry(r, 'decision',
        { topic: `zebrax ${i}`, choice: 'zebrax zebrax zebrax rule', why: 'zebrax' }, { project: 'other' });
    }
    memory.logEntry(r, 'decision',
      { topic: 'zebrax', choice: 'wanted answer for zebrax', why: 'ok' }, { project: 'wanted' });
    out.scope = {};
    for (const top of [1, 3, 10]) {
      const x = retrieval.retrieve(r, 'zebrax', capability.grantProject('wanted'), { top });
      out.scope[top] = x.claims.map((c) => c.scope);
    }
    fs.rmSync(r, { recursive: true, force: true });
  }
  {
    // six entries of ONE author, plus an optional second author
    const r = mkroot();
    memory.projectInit(r, 'p');
    const w = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    for (let i = 0; i < 6; i++) {
      memory.logEntry(r, 'learning',
        { title: `quokkaq ${w[i]}`, text: `quokkaq finding ${w[i]} distinct ${i * 7919}`, agent: 'digest' },
        { project: 'p' });
    }
    out.single = {};
    for (const top of [1, 2, 3, 4, 5, 6]) {
      const x = retrieval.retrieve(r, 'quokkaq finding', capability.grantProject('p'), { top });
      out.single[top] = { n: x.claims.length, short: x.quotaShort, coverage: x.coverage };
    }
    // a second author appears: the refill must draw on it
    const other = ['golf', 'hotel', 'india'];
    for (let i = 0; i < 3; i++) {
      memory.logEntry(r, 'learning',
        { title: `quokkaq ${other[i]}`, text: `quokkaq finding ${other[i]} other ${i * 104729}`, agent: 'scout' },
        { project: 'p' });
    }
    out.mixed = {};
    for (const top of [2, 3, 4, 5, 6]) {
      const x = retrieval.retrieve(r, 'quokkaq finding', capability.grantProject('p'), { top });
      const by = {};
      for (const c of x.claims) by[c.author] = (by[c.author] ?? 0) + 1;
      out.mixed[top] = { n: x.claims.length, by };
    }
    fs.rmSync(r, { recursive: true, force: true });
  }
  return out;
}

const cur = probes(await load(path.join(REPO, 'src')));

test('scope first: top=1 and top=3 in the project find the permitted hit', () => {
  for (const top of [1, 3, 10]) {
    assert.deepEqual(cur.scope[top], ['project:wanted'], `top=${top}`);
  }
});

test('monotone: more top never returns fewer claims (single author, hard quota)', () => {
  let prev = 0;
  for (const top of [1, 2, 3, 4, 5, 6]) {
    assert.ok(cur.single[top].n >= prev, `top=${top} gave ${cur.single[top].n} < ${prev}`);
    prev = cur.single[top].n;
  }
});

test('positive control: one author flood stays capped by the quota, and says so', () => {
  const t6 = cur.single[6];
  assert.ok(t6.n <= 3, `six entries of one author, top=6 must be capped at 3, got ${t6.n}`);
  assert.equal(t6.short, true, 'quota-forced shortfall must be visible');
  assert.ok(t6.coverage.reasons.some((x) => /author share quota/.test(x.why)));
});

test('refill: with a second author the quota cut is filled from that author', () => {
  const t6 = cur.mixed[6];
  assert.equal(t6.n, 6, JSON.stringify(t6));
  assert.ok(t6.by.digest <= 3, 'digest stays at or under the quota');
  assert.equal(t6.by.scout, 3);
  let prev = 0;
  for (const top of [2, 3, 4, 5, 6]) {
    assert.ok(cur.mixed[top].n >= prev);
    prev = cur.mixed[top].n;
  }
});

test('red proof: the probes FAIL against the start commit', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-z1d-base-'));
  try {
    exportCommit(REPO, START, ['src'], tmp);
    const old = probes(await load(path.join(tmp, 'src')));
    assert.deepEqual(old.scope[1], [], 'old code: top=1 misses the hit');
    assert.ok(old.single[3].n < old.single[2].n, 'old code: top=3 returns less than top=2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
