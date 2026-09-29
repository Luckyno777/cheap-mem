// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The per-author share cap (`LIMITS.perAuthorShare`, enforced by
// `enforceAuthorShare` in src/retrieval.mjs) held only in bench/byzantine.mjs
// and bench/mutation.mjs — nothing in test/ failed when it was loosened.
// (Finding 2026-09-29; the byzantine bench alone cannot anchor it either:
// its genuine claim is `user` tier, which is exempt from the cap.)
//
// The probe: one agent-tier author floods the memory with entries that
// carry MORE of the query's keywords than the correct entry; the correct
// entry is written by ANOTHER agent-tier author (no `user` exemption). The
// answer must (a) still contain it and (b) hold at most `perAuthorShare`
// of the selected candidates for the flooder.
//
// What the cap does and does not decide (measured 2026-09-29): retrieve()
// selects `top` candidates FIRST (tier round-robin + MMR), then caps them.
// So whether the correct entry is a candidate is the selection's doing; the
// cap's own effect is the flooder's share of the answer. (b) is therefore
// the assertion that goes red when the cap is loosened to 1.0; (a) guards
// the scenario the cap exists for. The positive control runs the same flood
// with `perAuthorShare: 1.0` and shows the flooder above the cap.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { retrieve, LIMITS } from '../src/retrieval.mjs';
import * as memory from '../src/memory.mjs';
import { grantAll } from '../src/capability.mjs';

const MEM = path.join(import.meta.dirname, '..', 'bin', 'mem');
const QUERY = 'kubernetes autoscaler cooldown';
const TOP = 10;

function flooded(limits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-share-cap-'));
  try {
    execFileSync(process.execPath, [MEM, 'init'], { env: { ...process.env, CHEAP_MEM_ROOT: root } });
    memory.logEntry(root, 'learning', {
      title: 'kubernetes autoscaler cooldown is 300 seconds',
      text: 'the cooldown after a scale-down is 300 seconds; found by the on-call review',
      author: 'carol',
    });
    for (let i = 0; i < 40; i += 1) {
      memory.logEntry(root, 'learning', {
        title: `kubernetes autoscaler cooldown note ${i}`,
        text: `kubernetes autoscaler cooldown kubernetes autoscaler cooldown variant ${i} of the same claim`,
        author: 'floodbot',
      });
    }
    return retrieve(root, QUERY, grantAll(), { top: TOP, ...(limits ? { limits } : {}) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const hasCarol = (r) => r.claims.some((c) => c.author === 'carol');
const flood = (r) => r.claims.filter((c) => c.author === 'floodbot').length;
const nCandidates = TOP;   // retrieve() selects `top` candidates, THEN caps them
const CAP = Math.floor(nCandidates * LIMITS.perAuthorShare);

test('the default cap is at most one half', () => {
  assert.ok(LIMITS.perAuthorShare > 0 && LIMITS.perAuthorShare <= 0.5, `perAuthorShare is ${LIMITS.perAuthorShare}`);
});

test('a flood of keyword-rich entries by one author is capped and a correct entry of another author stays in the top k', () => {
  const r = flooded();
  assert.ok(hasCarol(r), `the correct entry by carol is not in the top ${TOP}: ${r.claims.map((c) => c.author).join(',')}`);
  assert.ok(r.claims.length <= TOP);
  assert.ok(flood(r) <= CAP, `the flooder holds ${flood(r)} of ${r.claims.length} slots, the cap allows ${CAP}`);
  assert.ok(r.excluded.some((e) => /author share/.test(e.why || '')), 'the cap never ran');
});

test('positive control: with the cap loosened to 1.0 the same flood takes the slots the cap denies it', () => {
  const r = flooded({ ...LIMITS, perAuthorShare: 1.0 });
  assert.ok(flood(r) > CAP, `the probe does not see the cap: the flooder holds only ${flood(r)} slots without it`);
});
