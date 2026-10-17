// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-cost.mjs — NOT BUILT YET (a stub).
//
// The id `cost` is shared with the sister house (lucky-mem), which is adding a
// phase of the same id; test/atlas-phase-parity.json lists it. This file holds
// the id in the atlas and reports it honestly as `not-measured` (see ./stub.mjs).
// Replace the body of `run` with the real measurements when the phase is
// built, and delete the `stubs` entry for `cost` from the parity list.
import { runStub } from './stub.mjs';

export function run(atlas) {
  runStub(atlas, {
    id: 'cost',
    title: 'Cost: what a call costs to run and to read',
    owes: 'The built phase is to count what a call costs, by counters rather than by the clock.',
  });
}
