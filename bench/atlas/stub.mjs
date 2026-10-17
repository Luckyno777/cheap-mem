// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/stub.mjs — the row of a phase that is named but not built yet.
//
// **Why a stub exists at all.** The two houses (this one and lucky-mem) number
// their atlas phases alike, so that a record in one has a counterpart in the
// other. A phase id is therefore agreed before the phase is built, and the id
// has to be somewhere in this atlas from that day: otherwise the parity list
// (test/atlas-phase-parity.json) would have to call a planned phase "missing",
// and a reader of the atlas would not see that anything is owed.
//
// **What a stub measures: nothing, and says so.** It writes exactly one record,
// `<id>.not-built`, with the verdict `not-measured` (the third state the atlas
// already has for "could not look"), and one named blind spot. It never writes
// `pass`. A run that includes a stub therefore ends with exit code 3, not 0:
// "this was never looked at" must not read as green. Everything the stub says
// about itself is a fixed sentence, not a measurement, and carries no number.
//
// **The guard.** test/atlas-stub-never-passes.test.mjs runs every phase file
// that imports this module and requires zero `pass` records, a `not-built`
// record and a blind spot. It also runs a variant that counts a stub as ok, and
// that variant must turn the test red.
import { VERDICT } from './core.mjs';

/**
 * Record a phase that is not built yet.
 * @param {import('./core.mjs').Atlas} atlas
 * @param {{id: string, title: string, owes: string}} stub `owes`: what the
 *   built phase is meant to answer, in one sentence.
 */
export function runStub(atlas, { id, title, owes }) {
  atlas.phase(id, title, `**Not built yet.** ${owes}`);
  atlas.record({
    id: `${id}.not-built`,
    title: `phase ${id} is built`,
    verdict: VERDICT.NOT_MEASURED,
    expected: 'a built phase that measures something',
    actual: 'not built yet',
    evidence: `${owes} Nothing is measured here; this row only holds the id.`,
  });
  atlas.blind(`phase "${id}" (${title})`, 'not built yet: the id is agreed with the sister house, the phase is not');
}
