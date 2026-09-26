// eval/raw-only.mjs — what does the reserve lane cost?
//
// Since 2026-09-06, raw capture only gets its turn in the gateway once
// digested entries fail to fill the slots. That helped, measurably
// (gold in the poisoned corpus 8/33 -> 11/33). The price stood next to
// it as a sentence, not as a number:
//
//   "If a fact lives only in the capture, and the digested entries
//    already supply five mediocre hits, the capture no longer gets
//    through."
//
// This measurement builds exactly that situation. Part of the facts
// exist ONLY as raw capture — undigested, the way the stop hook files
// them before the digester has run. That is not an edge case: hours
// pass between capture and digestion in real operation, and during
// that time the capture is the only source.
//
// What is measured is not the id — a raw capture has none — but
// whether the fact's CHOICE shows up in the fed context.
//
//   node eval/raw-only.mjs [--min 5] [--top 5]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { FACTS, PROJECT } from './world.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN = arg('min', 5.0);
const TOP = arg('top', 5);

const cap = grantProject(PROJECT);
const FACT = new Map(FACTS.map((f) => [f.id, f]));
const withGold = TASKS.filter((t) => t.gold.length);

/** Content words of the CHOICE — this is how the fact is recognized in context. */
function keywords(id) {
  const f = FACT.get(id);
  if (!f) return [];
  return String(f.kern.wahl).toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
}

/**
 * Is the fact in context? A majority of its keywords must occur.
 *
 * Not "one word is enough": the choice's words are the topic's
 * technical terms and also occur in neighboring entries. Not "all":
 * capture cuts off at RAW_CAP and rendering truncates.
 */
function present(id, body) {
  const w = keywords(id);
  if (!w.length) return false;
  const text = body.toLowerCase();
  let n = 0;
  for (const x of w) if (text.includes(x)) n += 1;
  return n / w.length > 0.5;
}

// Which facts move into raw capture? Every third one, deterministically —
// no cherry-picking.
const RAW_ONLY = FACTS.filter((_, i) => i % 3 === 0).map((f) => f.id);
const affected = withGold.filter((t) => t.gold.some((g) => RAW_ONLY.includes(g)));

function measure(label, buildOpt, retrOpt = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nurroh-'));
  build(root, { seed: 3, ...buildOpt });
  let hits = 0, rawInContext = 0, claims = 0, affectedHits = 0;
  const lost = [];
  for (const t of withGold) {
    const r = retrieval.retrieve(root, t.prompt, cap, { top: TOP, ...retrOpt });
    const kept = r.claims.filter((c) => c.score >= MIN);
    claims += kept.length;
    rawInContext += kept.filter((c) => !c.id).length;
    const body = kept.map((c) => c.body).join('\n');
    const hit = t.gold.some((g) => present(g, body));
    if (hit) hits += 1; else lost.push(t.id);
    if (affected.some((b) => b.id === t.id) && hit) affectedHits += 1;
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { label, hits, claims, rawInContext, lost, affectedHits };
}

console.log(`Facts existing only as raw capture: ${RAW_ONLY.length} of ${FACTS.length}`);
console.log(`tasks affected by that: ${affected.length} of ${withGold.length} (${affected.map((t) => t.id).join(' ')})\n`);

const rows = [
  measure('everything digested (baseline)', {}),
  measure('a third raw-capture-only, reserve lane', { rawOnly: RAW_ONLY }),
  // The counter-check, and it decides the interpretation: does the
  // capture fail to get through BECAUSE it is reserve — or because an
  // undigested transcript is just harder to find than a digested entry
  // regardless?
  measure('same displacement, raw capture on equal footing', { rawOnly: RAW_ONLY },
    { rawReserve: false }),
];

console.log('Condition                                    | fact in context | of those affected | raw-capture claims');
console.log('----------------------------------------------+-----------------+--------------------+--------------------');
for (const z of rows) {
  console.log(`${z.label.padEnd(45)} | ${String(`${z.hits}/${withGold.length}`).padStart(15)} | ${String(`${z.affectedHits}/${affected.length}`).padStart(18)} | ${String(z.rawInContext).padStart(18)}`);
}

const [baseline, reserve, equal] = rows;
console.log(`\nPrice of the reserve lane, overall: ${baseline.hits - reserve.hits} tasks out of ${withGold.length}.`);
console.log(`Price on the affected tasks: ${baseline.affectedHits - reserve.affectedHits} of ${affected.length}.`);
console.log(`What the counter-check recovers: ${equal.affectedHits - reserve.affectedHits} of ${affected.length} — this rule cannot lose any more than that.`);
const newlyLost = reserve.lost.filter((x) => !baseline.lost.includes(x));
console.log(`newly lost versus the baseline: ${newlyLost.length ? newlyLost.join(' ') : '(none)'}`);
