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
//   - a `luckyMemPending` id the list does not carry, or a phase this house
//     builds as a stub (a file importing bench/atlas/stub.mjs) that `cmStubs`
//     does not name, or the other way round
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

/** The phase ids whose file is a stub: it imports ./stub.mjs, so it measures nothing and says so. */
function cmStubIds() {
  const dir = path.join(REPO, 'bench', 'atlas');
  return fs.readdirSync(dir).filter((f) => /^phase-.*\.mjs$/.test(f))
    .filter((f) => /from '\.\/stub\.mjs'/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    .map((f) => f.slice(6, -4)).sort();
}

/**
 * Compare a list of this house's phase ids with the fixed parity list.
 * Returns the problems, as sentences; an empty array is parity.
 * `stubIds` (optional): the ids whose phase file is a stub, compared with `cmStubs`.
 */
export function compare(cmIds, parity, stubIds = null) {
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
  for (const id of Object.keys(parity.luckyMemPending ?? {})) {
    if (!lm.has(id)) problems.push(`luckyMemPending names "${id}", which the sister list does not carry`);
  }
  const declared = (parity.cmStubs ?? []).map((e) => e.id).sort();
  for (const e of parity.cmStubs ?? []) {
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) problems.push(`stub "${e.id}" has no reason`);
    if (!cmIds.includes(e.id)) problems.push(`cmStubs names "${e.id}", which this house does not have`);
  }
  if (stubIds) {
    for (const id of stubIds) if (!declared.includes(id)) problems.push(`phase "${id}" is a stub (its file imports stub.mjs) but cmStubs does not name it`);
    for (const id of declared) if (!stubIds.includes(id)) problems.push(`cmStubs names "${id}", whose file is not a stub (it does not import stub.mjs)`);
  }
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
  const problems = compare(cmPhaseIds(), PARITY, cmStubIds());
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\nUpdate test/atlas-phase-parity.json in the same commit as the phase change.`);
});

test('every phase has one id in both houses: the three that had two names are equal now, and no mapping is left', () => {
  const ids = cmPhaseIds();
  assert.ok(ids.includes('skala') && PARITY.luckyMemPhases.includes('skala'));
  for (const id of ['identifiers', 'bridge', 'silent-errors', 'dashboard', 'cost', 'digest', 'net-tempo']) {
    assert.ok(ids.includes(id) && PARITY.luckyMemPhases.includes(id), id);
  }
  assert.deepEqual(PARITY.idMap, {});
  for (const old of ['kennungen', 'bruecke', 'stille-fehler', 'netz-tempo']) assert.ok(!PARITY.luckyMemPhases.includes(old), `${old} is the old German id`);
});

test('the phases not yet on the sister house\'s main branch are named with their branch, and nothing else is', () => {
  const pending = PARITY.luckyMemPending;
  assert.deepEqual(Object.keys(pending).sort(), ['bridge', 'cost', 'dashboard', 'digest', 'identifiers', 'net-tempo', 'silent-errors']);
  for (const [id, why] of Object.entries(pending)) {
    assert.match(why, /agent\/atlas-rahmen-lm/, `${id}: the pending note names no branch`);
    assert.ok(PARITY.luckyMemPhases.includes(id), `${id} is pending but not in the list`);
  }
});

test('the phases this house names but has not built are exactly the stub files', () => {
  assert.deepEqual(PARITY.cmStubs.map((e) => e.id).sort(), ['cost', 'dashboard', 'digest', 'net-tempo']);
  assert.deepEqual(cmStubIds(), PARITY.cmStubs.map((e) => e.id).sort());
});

test('every phase only the sister house has is listed with a reason, and the ones this house lacks are exactly those', () => {
  const lmOnly = new Set(PARITY.lmOnly.map((e) => e.id));
  for (const id of ['wiederherstellung', 'lesekreis', 'weiche', 'partition', 'nutzung', 'guard']) {
    assert.ok(lmOnly.has(id), `${id} is not in lmOnly`);
    assert.ok(PARITY.lmOnly.find((e) => e.id === id).reason.length >= 60, `${id}: the reason is too short to be one`);
  }
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
  const strayPending = compare(real, { ...PARITY, luckyMemPending: { ...PARITY.luckyMemPending, 'not-there': 'agent/x' } });
  assert.ok(strayPending.some((p) => p.includes('"not-there"')), 'a pending id the list lacks must be named');
  const stubs = cmStubIds();
  assert.ok(compare(real, PARITY, [...stubs, 'load']).some((p) => p.includes('"load"') && p.includes('stub')), 'a stub file cmStubs does not name must be named');
  assert.ok(compare(real, PARITY, stubs.slice(1)).some((p) => p.includes(`"${stubs[0]}"`)), 'a cmStubs entry whose file is no stub must be named');
});

test('a new phase in the sister house needs a reason, and with one it is accepted', () => {
  const real = cmPhaseIds();
  const withNew = { ...PARITY, luckyMemPhases: [...PARITY.luckyMemPhases, 'invented-lm-phase'], newInLm: [{ id: 'invented-lm-phase', reason: 'a phase built in the sister house first, for the test' }] };
  assert.deepEqual(compare(real, withNew), []);
  const bare = { ...PARITY, luckyMemPhases: [...PARITY.luckyMemPhases, 'invented-lm-phase'], newInLm: [{ id: 'invented-lm-phase', reason: '' }] };
  assert.ok(compare(real, bare).some((p) => p.includes('no reason')));
});
