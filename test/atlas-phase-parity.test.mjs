// test/atlas-phase-parity.test.mjs — the two atlases name their phases alike,
// or say why not.
//
// The atlas of this house (bench/atlas.mjs) and the one in the sister house
// (lucky-mem) are meant to be read side by side: a record `skala.rung100000.…`
// in one should have a counterpart in the other. That only holds while the
// phase ids line up. This test compares this house's ids with a FIXED list
// of the sister house's (test/atlas-phase-parity.json) and fails on any
// difference that the file does not name with a reason:
//
//   - a phase here that the other house lacks, and that is not in `cmOnly`
//   - a phase there that this house lacks, and that is not in `lmOnly`
//   - a phase there that is new (`newInLm`) without a reason
//   - an `idMap` entry whose target the list does not carry
//
// The list is fixed on purpose: the sister house is not a dependency of this
// repository, and a test that reads someone else's checkout passes or fails
// by where it runs. The cost is that the file is updated by hand when the
// other house changes; the sister house keeps the mirror image of this file.
//
// **Positive control.** `compare()` is run on an invented atlas that has a
// phase the list does not know, and on one that lacks a phase the list
// promises; both must come back with a problem, or the green of the real
// comparison would say nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PARITY = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'atlas-phase-parity.json'), 'utf8'));

/** The phase ids bench/atlas.mjs runs, read from its PHASES table (the file runs main() on import, so it is read, not imported). */
function cmPhaseIds() {
  const src = fs.readFileSync(path.join(REPO, 'bench', 'atlas.mjs'), 'utf8');
  const table = src.slice(src.indexOf('const PHASES = ['), src.indexOf('];', src.indexOf('const PHASES = [')));
  return [...table.matchAll(/^\s*\['([a-z][a-z0-9-]*)',\s*'\.\/atlas\/phase-[a-z0-9-]+\.mjs'/gm)].map((m) => m[1]);
}

/**
 * Compare a list of this house's phase ids with the fixed parity list.
 * Returns the problems, as sentences; an empty array is parity.
 */
export function compare(cmIds, parity) {
  const problems = [];
  const lm = new Set(parity.luckyMemPhases);
  const idMap = parity.idMap ?? {};
  const cmOnly = new Map((parity.cmOnly ?? []).map((e) => [e.id, e.reason]));
  const lmOnly = new Map((parity.lmOnly ?? []).map((e) => [e.id, e.reason]));
  const mapped = (id) => idMap[id] ?? id;

  for (const [id, reason] of [...cmOnly, ...lmOnly]) {
    if (typeof reason !== 'string' || reason.trim().length < 20) problems.push(`difference "${id}" has no reason`);
  }
  for (const e of parity.newInLm ?? []) {
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) problems.push(`new phase "${e.id}" in the sister house has no reason`);
  }
  const newInLm = new Set((parity.newInLm ?? []).map((e) => e.id));

  for (const id of cmIds) {
    if (cmOnly.has(id)) {
      if (lm.has(mapped(id))) problems.push(`"${id}" is listed as only here, but the sister list carries "${mapped(id)}"`);
      continue;
    }
    if (!lm.has(mapped(id))) problems.push(`phase "${id}" here has no counterpart "${mapped(id)}" in the sister list and is not in cmOnly`);
  }
  const mappedHere = new Set(cmIds.map(mapped));
  for (const id of lm) {
    if (lmOnly.has(id)) {
      if (mappedHere.has(id)) problems.push(`"${id}" is listed as only in the sister house, but this house has it`);
      continue;
    }
    if (newInLm.has(id)) continue;
    if (!mappedHere.has(id)) problems.push(`phase "${id}" in the sister list is missing here and is not in lmOnly or newInLm`);
  }
  for (const id of cmOnly.keys()) if (!cmIds.includes(id)) problems.push(`cmOnly names "${id}", which this house does not have`);
  for (const id of lmOnly.keys()) if (!lm.has(id)) problems.push(`lmOnly names "${id}", which the sister list does not carry`);
  for (const [from, to] of Object.entries(idMap)) {
    if (!cmIds.includes(from)) problems.push(`idMap names "${from}", which this house does not have`);
    if (!lm.has(to)) problems.push(`idMap maps "${from}" to "${to}", which the sister list does not carry`);
  }
  return problems;
}

test('every phase file has a row in bench/atlas.mjs and the other way round', () => {
  const ids = cmPhaseIds();
  assert.ok(ids.length >= 8, `read ${ids.length} phase ids from bench/atlas.mjs`);
  const files = fs.readdirSync(path.join(REPO, 'bench', 'atlas')).filter((f) => /^phase-.*\.mjs$/.test(f)).map((f) => f.slice(6, -4)).sort();
  assert.deepEqual([...ids].sort(), files);
});

test('the phase ids of the two atlases line up, or every difference is named with a reason', () => {
  const problems = compare(cmPhaseIds(), PARITY);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\nUpdate test/atlas-phase-parity.json in the same commit as the phase change.`);
});

test('the scale phase has the same id in both houses and the identifiers phase is mapped', () => {
  const ids = cmPhaseIds();
  assert.ok(ids.includes('skala') && PARITY.luckyMemPhases.includes('skala'));
  assert.equal(PARITY.idMap.identifiers, 'kennungen');
  assert.ok(ids.includes('identifiers') && PARITY.luckyMemPhases.includes('kennungen'));
});

test('positive control: an invented phase here, and a missing one, turn the comparison red', () => {
  const real = cmPhaseIds();
  const invented = compare([...real, 'invented-phase'], PARITY);
  assert.ok(invented.some((p) => p.includes('invented-phase')), 'a phase the list does not know must be named');
  const missing = compare(real.filter((id) => id !== 'load'), PARITY);
  assert.ok(missing.some((p) => p.includes('"load"')), 'a phase the list promises and this house lacks must be named');
  const noReason = compare(real, { ...PARITY, cmOnly: [{ id: 'register', reason: '' }] });
  assert.ok(noReason.some((p) => p.includes('no reason')), 'a difference without a reason must be named');
  const wrongMap = compare(real, { ...PARITY, idMap: { identifiers: 'nowhere' } });
  assert.ok(wrongMap.some((p) => p.includes('nowhere')), 'a mapping to an id the list lacks must be named');
});

test('a new phase in the sister house needs a reason, and with one it is accepted', () => {
  const real = cmPhaseIds();
  const withNew = { ...PARITY, luckyMemPhases: [...PARITY.luckyMemPhases, 'bruecke'], newInLm: [{ id: 'bruecke', reason: 'the bridge phase, built in the sister house first' }] };
  assert.deepEqual(compare(real, withNew), []);
  const bare = { ...PARITY, luckyMemPhases: [...PARITY.luckyMemPhases, 'bruecke'], newInLm: [{ id: 'bruecke', reason: '' }] };
  assert.ok(compare(real, bare).some((p) => p.includes('no reason')));
});
