// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-net-tempo.mjs — NOT BUILT YET (a stub).
//
// The id `net-tempo` is shared with the sister house (lucky-mem), which is adding a
// phase of the same id; test/atlas-phase-parity.json lists it. This file holds
// the id in the atlas and reports it honestly as `not-measured` (see ./stub.mjs).
// Replace the body of `run` with the real measurements when the phase is
// built, and delete the `stubs` entry for `net-tempo` from the parity list.
import { runStub } from './stub.mjs';

export function run(atlas) {
  runStub(atlas, {
    id: 'net-tempo',
    title: 'Net speed: contexts, programs and model computations of the 3D net',
    owes: 'The built phase is to count what the 3D net causes on build and reload (WebGL contexts, programs, model computations); time would be an accompanying value only.',
  });
}
