// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-dashboard.mjs — NOT BUILT YET (a stub).
//
// The id `dashboard` is shared with the sister house (lucky-mem), which is adding a
// phase of the same id; test/atlas-phase-parity.json lists it. This file holds
// the id in the atlas and reports it honestly as `not-measured` (see ./stub.mjs).
// Replace the body of `run` with the real measurements when the phase is
// built, and delete the `stubs` entry for `dashboard` from the parity list.
import { runStub } from './stub.mjs';

export function run(atlas) {
  runStub(atlas, {
    id: 'dashboard',
    title: 'The dashboard: what its pages serve and what they cost',
    owes: 'The built phase is to measure the dashboard server and its pages.',
  });
}
