// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// o7-number-places.test.mjs — every place a number guard checks is a
// place the number writer fixes (BAUPLAN O7, 2026-09-30).
//
// **The finding.** After a merge on 2026-09-30, docs/mcp-setup.md:3/:267
// and docs/CAPABILITIES.md:560 ("N tools") were red in the guards
// (test/tool-count-doc.test.mjs, test/doc-numbers.test.mjs), and
// `node bench/readme-numbers.mjs --write --all` — the step the merge
// chain runs for exactly this — fixed none of them. The writer knew
// four phrasings; the guards swept every sentence. Two lists of places,
// so the hand-fix came back.
//
// **The probe.** A copy of this tree gets a deliberately WRONG number at
// EVERY place the guards check (their own sweep, imported — the list is
// the product's, not this test's). One `--write --all` run must leave no
// place the guards would fail. Positive control: before the run, the
// check sees every injected place. Red proof, pinned to the fixed start
// commit c23ad5c (never a moving merge-base): the writer of that commit,
// run on the same injected tree, leaves at least the docs places wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as places from '../bench/readme-numbers.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = 'c23ad5c';

/** The files the counters and the sweep read — not the images. */
function copyTree(t) {
  const dest = tempDir('cm-o7-', t);
  const files = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => f.endsWith('.md') || /^(bin|src)\//.test(f) || /^install\/hooks\//.test(f)
      || (/^test\/[^/]+\.mjs$/.test(f)) || (/^bench\/[^/]+\.mjs$/.test(f)));
  for (const f of files) {
    const from = path.join(REPO, f);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, f));
  }
  return dest;
}

/** Every place the guards check in `root`, with a wrong value for it. */
async function injectEverywhere(root) {
  const counters = places.buildCounters(root);
  const real = {};
  for (const f of ['mcp', 'cli', 'modules', 'tests', 'lines', 'linesCli']) real[f] = await counters[f]();
  const perFile = new Map();
  const add = (rel, start, end, to) => {
    if (!perFile.has(rel)) perFile.set(rel, new Map());
    perFile.get(rel).set(start, { start, end, to });
  };
  for (const c of places.sweepClaims(root).checked) {
    const r = real[places.KIND_FIELD[c.kind]];
    const wrong = places.EXACT_KINDS.includes(c.kind) ? r + 7 : r * 3;
    add(c.rel, c.start, c.end, c.raw.includes(',') ? wrong.toLocaleString('en-US') : String(wrong));
  }
  for (const c of places.toolCountClaims(root)) {
    // A numeral the sweep already covers keeps the sweep's wrong value.
    if (perFile.get(c.rel)?.has(c.start)) continue;
    const wrong = /^\d+$/.test(c.raw) ? String(real.mcp + 7) : places.TOOL_WORDS[(real.mcp + 3) % places.TOOL_WORDS.length];
    add(c.rel, c.start, c.end, wrong);
  }
  let n = 0;
  for (const [rel, spans] of perFile) {
    const p = path.join(root, rel);
    let text = fs.readFileSync(p, 'utf8');
    for (const s of [...spans.values()].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, s.start) + s.to + text.slice(s.end);
      n += 1;
    }
    fs.writeFileSync(p, text);
  }
  return { n, files: [...perFile.keys()] };
}

/** What the guards would fail in `root`, by their own rules. */
async function failing(root) {
  const counters = places.buildCounters(root);
  const out = [];
  for (const c of places.sweepClaims(root).checked) {
    const r = await counters[places.KIND_FIELD[c.kind]]();
    if (places.sweepFails(c.kind, c.number, r)) out.push(`${c.rel}:${c.line} ${c.raw} ${c.word} (real ${r})`);
  }
  const n = await counters.mcp();
  for (const c of places.toolCountClaims(root)) if (c.said !== n) out.push(`${c.rel}: ${c.raw} tools (real ${n})`);
  return out;
}

function runWriter(root) {
  return spawnSync(process.execPath, [path.join(root, 'bench', 'readme-numbers.mjs'), '--root', root, '--write', '--all'],
    { encoding: 'utf8', timeout: 60000 });
}

test('POSITIVE: the sweep reaches the places the 2026-09-30 hand-fix touched', () => {
  const tools = places.toolCountClaims(REPO).map((c) => c.rel);
  assert.ok(tools.includes('docs/mcp-setup.md'), 'docs/mcp-setup.md "N tools" is not in the list of places');
  assert.ok(tools.includes('docs/CAPABILITIES.md'), 'docs/CAPABILITIES.md "N tools" is not in the list of places');
  const swept = new Set(places.sweepClaims(REPO).checked.map((c) => c.rel));
  for (const f of ['README.md', 'docs/CAPABILITIES.md', 'CLAUDE.md']) assert.ok(swept.has(f), `${f} not swept`);
});

test('a wrong number at EVERY checked place is corrected by one --write --all', async (t) => {
  const root = copyTree(t);
  assert.deepEqual(await failing(root), [], 'precondition: the copy starts clean (or the docs are already stale)');
  const placesBefore = places.sweepClaims(root).checked.length + places.toolCountClaims(root).length;
  const { n, files } = await injectEverywhere(root);
  assert.ok(n >= 10, `only ${n} places injected — the sweep barely reaches the docs`);
  assert.ok(files.includes('docs/mcp-setup.md'));
  const seen = await failing(root);
  // Positive control: the check sees the injected numbers at all.
  assert.ok(seen.length >= n, `the check sees ${seen.length} of ${n} injected places`);

  const r = runWriter(root);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await failing(root), [], `places still wrong after --write --all:\n${r.stdout}`);
  const placesAfter = places.sweepClaims(root).checked.length + places.toolCountClaims(root).length;
  assert.equal(placesAfter, placesBefore, 'a place disappeared instead of being corrected');
  const check = await places.checkNumbers({ root, only: places.ALL });
  assert.deepEqual(check.mismatches, [], JSON.stringify(check.mismatches));
});

test(`RED on the fixed start ${START}: that writer leaves the docs places wrong`, async (t) => {
  let old;
  try {
    old = execFileSync('git', ['-C', REPO, 'show', `${START}:bench/readme-numbers.mjs`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip(`commit ${START} is not in this clone (shallow?) — the red proof cannot run here, which is unknown, not green`);
    return;
  }
  const root = copyTree(t);
  await injectEverywhere(root);
  fs.writeFileSync(path.join(root, 'bench', 'readme-numbers.mjs'), old);
  runWriter(root);
  const left = await failing(root);
  assert.ok(left.some((l) => l.startsWith('docs/mcp-setup.md')),
    `the old writer fixed docs/mcp-setup.md — the red proof no longer shows the gap:\n${left.join('\n')}`);
});

test('the guards import the places from the writer — one list, not two', () => {
  for (const f of ['test/doc-numbers.test.mjs', 'test/tool-count-doc.test.mjs']) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.match(src, /from '\.\.\/bench\/readme-numbers\.mjs'/, `${f} no longer imports the writer's places`);
    assert.doesNotMatch(src, /\\b\(\[\\d\]\[\\d,\]\*\)\\s\+\(MCP tools/, `${f} carries its own copy of the sweep pattern again`);
  }
  // The module is importable as a URL on every platform (windows-paths).
  assert.ok(pathToFileURL(path.join(REPO, 'bench', 'readme-numbers.mjs')).href.startsWith('file:'));
});
