#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * bench/recall-levers.mjs - measures the two recall-hook levers ported from
 * lucky-mem (the cut with a guard for a tie, src/tiecut.mjs; the request
 * frame, src/requestframe.mjs) on cheap-mem's own gold set.
 *
 *     node bench/recall-levers.mjs                  # the 54-entry gold world
 *     node bench/recall-levers.mjs --size 3000      # gold world inside 3000 synthetic notes
 *     node bench/recall-levers.mjs --old-ref <sha>  # the old state (default: the pinned one)
 *     node bench/recall-levers.mjs --json           # raw numbers only
 *
 * **What is asked.** Every question goes through the hook-shaped call
 * `mem find Q --top 3 --recall --json`; what counts as shown is what clears the
 * hook's own bar (score >= 5.0, or an exact hit). The OLD side is the old
 * state's own `bin/mem` with the call the hook made then (no `--recall`), taken
 * from `git archive <sha>` - not a switch on the new code. Four sets: the gold
 * cases (bench/gold/cases.jsonl, those with an expected id), the same cases
 * wrapped in a request frame ("explain ...", "please show me ...", "can you tell
 * me ..."; German ones for the cross-language cases), the decoys
 * (bench/gold/decoys.jsonl) and the decoys wrapped the same way. The wrapped
 * sets are DERIVED, synthetic, and say nothing about how often real questions
 * start with a request verb.
 *
 * **Honest limits.** One synthetic world, no held-out set, so the numbers do
 * not compare with lucky-mem's (which has a sample, a held-back set and 12
 * decoys). They show whether a lever costs gold here, not how much it gains in
 * a real memory. Report: docs/recall-levers-2026-10-10.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCases, loadWorld, buildWorld } from './gold-compare.mjs';
import { buildCorpus } from './scale.mjs';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
export const PINNED_OLD = 'b5959ed38a2d859a762df7da893f6ce17b0ee0cb';
const BAR = 5.0;

const EN = ['explain ', 'please show me ', 'can you tell me '];
const DE = ['erklaer mir ', 'zeig mir ', null];
/** The request frame put around a question; `i` rotates the form so no form is picked by hand. */
export function framed(q, i, german) {
  const k = i % 3;
  if (german) return k === 2 ? `kannst du mir ${q} erklaeren` : DE[k] + q;
  return EN[k] + q;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}

function oldTree(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-levers-old-'));
  const tar = execFileSync('git', ['-C', REPO, 'archive', ref, 'bin', 'src', 'package.json'], { maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return dir;
}

async function makeRoot(size) {
  const world = loadWorld();
  if (!size) return await buildWorld(world, { codeDir: REPO });
  const { root } = buildCorpus(Math.max(0, size - world.entries.length));
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify(world.config ?? {}));
  for (const row of world.entries) {
    if (row.project) memory.projectInit(root, row.project);
    memory.logEntry(root, row.type, row.data, { project: row.project ?? null, now: new Date(row.at) });
  }
  return root;
}

function ask(root, tree, recall, env, q, c) {
  const argv = [path.join(tree, 'bin', 'mem'), '--root', root, 'find', q, '--top', String(c.k ?? 3)];
  if (recall) argv.push('--recall');
  argv.push('--json');
  if (c.project) argv.push('--project', c.project);
  if (c.asOf) argv.push('--as-of', c.asOf);
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', cwd: root, timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: '', ...env } });
  if (r.status !== 0) throw new Error(`mem find exited ${r.status}: ${String(r.stderr).slice(0, 200)}`);
  const raw = JSON.parse(r.stdout).hits.map((h) => ({
    id: h.entry?.id ?? null, score: h.score, exact: (h.exact?.length ?? 0) > 0, size: JSON.stringify(h.entry).length,
  }));
  return { raw, shown: raw.filter((h) => h.score >= BAR || h.exact) };
}

const SIDES = (old) => ({
  'old state (hook call as it was)': { tree: old, recall: false, env: {} },
  'frame only (the shipped default)': { tree: REPO, recall: true, env: { MEM_RETRIEVE_TIE: '0' } },
  'tie only': { tree: REPO, recall: true, env: { MEM_RETRIEVE_TIE: '0.01', MEM_RETRIEVE_REQUEST_FRAME: '0' } },
  'both': { tree: REPO, recall: true, env: { MEM_RETRIEVE_TIE: '0.01' } },
});

export async function measure({ size = 0, ref = PINNED_OLD } = {}) {
  const cases = loadCases().filter((c) => c.expected);
  const decoys = fs.readFileSync(path.join(HERE, 'gold', 'decoys.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const root = await makeRoot(size);
  const old = oldTree(ref);
  const out = { size: size || 'gold world only (54 entries)', old: ref, sides: {}, extras: [] };
  try {
    for (const [name, side] of Object.entries(SIDES(old))) {
      const o = {};
      for (const set of ['gold', 'gold-framed', 'decoy', 'decoy-framed']) {
        const isGold = set.startsWith('gold');
        const wrap = set.endsWith('framed');
        const s = { n: 0, hits: 0, bytes: 0, ...(isGold ? { pass: 0, forbiddenShown: 0 } : { answered: 0 }) };
        (isGold ? cases : decoys).forEach((c, i) => {
          const german = c.category === 'cross-language';
          const a = ask(root, side.tree, side.recall, side.env, wrap ? framed(c.query, i, german) : c.query, c);
          const ids = a.shown.map((h) => h.id);
          s.n += 1; s.hits += a.shown.length; s.bytes += a.shown.reduce((t, h) => t + h.size, 0);
          if (isGold) {
            const bad = (c.forbidden ?? []).some((f) => ids.includes(f));
            if (c.expected.some((e) => ids.includes(e)) && !bad) s.pass += 1;
            if (bad) s.forbiddenShown += 1;
          } else if (a.shown.length) s.answered += 1;
        });
        o[set] = s;
      }
      out.sides[name] = o;
    }
    // The extra hits of the tie lever, one by one (plain gold questions, frame as shipped): where does each lie
    // against the last hit of the hard cut, and is it a hit the case wants or forbids?
    for (const c of cases) {
      const hard = ask(root, REPO, true, { MEM_RETRIEVE_TIE: '0' }, c.query, c);
      const tie = ask(root, REPO, true, { MEM_RETRIEVE_TIE: '0.01' }, c.query, c);
      if (tie.raw.length <= hard.raw.length) continue;
      const extra = tie.raw[tie.raw.length - 1];
      const last = hard.raw[hard.raw.length - 1];
      out.extras.push({
        case: c.id, extra: extra.id, score: +extra.score.toFixed(2), lastOfHardCut: +last.score.toFixed(2),
        position: extra.score > last.score ? 'above' : 'below',
        shownAtHookBar: extra.score >= BAR || extra.exact,
        forbidden: (c.forbidden ?? []).includes(extra.id), expected: c.expected.includes(extra.id),
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
  return out;
}

export function render(r) {
  const L = [`recall levers, ${typeof r.size === 'number' ? `${r.size} notes` : r.size}, old state ${r.old.slice(0, 12)}`, ''];
  for (const set of ['gold', 'gold-framed', 'decoy', 'decoy-framed']) {
    L.push(`${set}:`);
    for (const [name, o] of Object.entries(r.sides)) {
      const s = o[set];
      L.push(`  ${name.padEnd(36)} ${set.startsWith('gold') ? `pass ${s.pass}/${s.n}, forbidden shown ${s.forbiddenShown}` : `answered ${s.answered}/${s.n}`}, hits ${s.hits}, bytes ${s.bytes}`);
    }
  }
  const shown = r.extras.filter((e) => e.shownAtHookBar);
  L.push('', `tie lever: ${r.extras.length} extra hit(s) before the hook bar, ${shown.length} shown;`
    + ` of those ${shown.filter((e) => e.position === 'above').length} above the score of the last hard-cut hit,`
    + ` ${shown.filter((e) => e.expected).length} expected, ${shown.filter((e) => e.forbidden).length} forbidden`);
  for (const e of shown) L.push(`  ${e.case}: ${e.extra} ${e.score} vs ${e.lastOfHardCut} (${e.position})${e.forbidden ? ' FORBIDDEN' : ''}${e.expected ? ' EXPECTED' : ''}`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await measure({ size: Number(arg('size', 0)), ref: arg('old-ref', PINNED_OLD) });
  process.stdout.write(`${process.argv.includes('--json') ? JSON.stringify(r, null, 1) : render(r)}\n`);
}
