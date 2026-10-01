// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// claim-same-millisecond.test.mjs — a claim and its closing line in the
// SAME millisecond (twin of lucky-mem's uebernahme-gleichzeit, chain run
// 2026-10-01).
//
// order() sorted ties by (by, id) — and the id is random. When the closing
// line's id was smaller it came BEFORE its own claim, found no holder and
// was read as invalid: about every second same-millisecond case.
// Red on the previous state: the first two tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, KIND, STATUS } from '../src/claim.mjs';

const TIME = '2026-10-01T05:00:00.000Z';
const UNTIL = '2026-10-01T06:00:00.000Z';
const claim = { kind: KIND.CLAIM, message: 'm.md', claimed_by: 'gemini', until: UNTIL, time: TIME, id: 'ffffffffffff' };

test('same millisecond: failed with a SMALLER id still counts (claim first)', () => {
  const f = { kind: KIND.FAILED, message: 'm.md', by: 'gemini', claim_id: 'ffffffffffff', reason: 'x', time: TIME, id: '000000000000' };
  const r = fold([f, claim], { now: TIME });
  assert.equal(r.failures.length, 1, JSON.stringify(r.invalid));
  assert.equal(r.status, STATUS.FREE);
});

test('same millisecond: done with a SMALLER id still counts', () => {
  const d = { kind: KIND.DONE, message: 'm.md', by: 'gemini', claim_id: 'ffffffffffff', time: TIME, id: '000000000000' };
  const r = fold([d, claim], { now: TIME });
  assert.equal(r.status, STATUS.DONE, JSON.stringify(r.invalid));
});

test('positive control: a closing line EARLIER than the claim stays invalid', () => {
  const f = { kind: KIND.FAILED, message: 'm.md', by: 'gemini', claim_id: 'ffffffffffff', reason: 'x', time: '2026-10-01T04:59:59.999Z', id: '000000000000' };
  const r = fold([f, claim], { now: TIME });
  assert.equal(r.failures.length, 0);
  assert.equal(r.invalid.length, 1);
  assert.equal(r.status, STATUS.CLAIMED);
});
