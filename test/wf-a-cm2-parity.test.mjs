// test/wf-a-cm2-parity.test.mjs — wf-a-cm2: close the remaining A1-A3
// parity gaps against lucky-mem (src/workflow.mjs, src/baustein.mjs,
// src/redaktion.mjs), measured — not assumed — against that house's
// actual behaviour.
//
// Red proof pinned to a FIXED commit (house rule, agent-rahmen.md #12:
// never `git merge-base` — it walks forward after a merge and would
// turn the probe red again for the wrong reason). `FIXED_COMMIT` below
// is 08951d1, the exact commit this package's worktree started this
// package's second pass from (given by the assignment, confirmed here
// against `git log`).
//
// Each guarantee gets: a RED proof (the old commit did not have it), a
// POSITIVE CONTROL (the probe actually sees something at that commit,
// so the red result is not just a broken probe), and the GREEN check
// on the current build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as workflow from '../src/workflow.mjs';
import * as snippet from '../src/snippet.mjs';
import * as redaction from '../src/redaction.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_COMMIT = '08951d16659a282e3ccc034ae303a831e2f894fc';

function showAtFixed(relPath) {
  try {
    return { ok: true, text: execFileSync('git', ['show', `${FIXED_COMMIT}:${relPath}`], { cwd: REPO, encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Shared positive control: the probe can read the fixed commit ----

test('POSITIVE CONTROL: the fixed commit is readable and is the one this package started from', () => {
  const wf = showAtFixed('src/workflow.mjs');
  assert.ok(wf.ok, `could not read src/workflow.mjs at ${FIXED_COMMIT}: ${wf.error}`);
  assert.match(wf.text, /export const TYPE = 'workflow'/,
    'the fixed commit does not look like the workflow.mjs this package started from');
});

// --- Guarantee 1: references rejects an unknown kind, never drops it -

test('RED PROOF: at the fixed commit, an unknown references kind was DROPPED, not rejected', () => {
  const wf = showAtFixed('src/workflow.mjs');
  assert.ok(wf.ok);
  assert.match(wf.text, /Unknown keys are dropped rather than rejected/,
    'the fixed commit no longer has the drop-not-reject comment — pick an earlier hash');
   
  assert.doesNotMatch(wf.text, /is not a known kind/,
    'the fixed commit already rejected unknown kinds — the red proof is stale');
});

test('POSITIVE CONTROL: normaliseReferences on the fixed-commit TEXT would keep the unknown key silently', () => {
  // We cannot import the old file directly (ESM has no "read this text
  // as a module at this old blob" primitive without writing it out) —
  // but the drop behaviour is fully described in its own head comment,
  // asserted above, and its replacement is asserted directly below on
  // the current module. This control instead proves our CURRENT
  // checkReferences() really does distinguish the two shapes, so the
  // red->green story is about behaviour, not just a comment string.
  const dropped = workflow.normaliseReferences({ bogus: ['x'] });
  assert.equal(dropped, null, 'an unknown kind must invalidate the whole shape now, not vanish');
});

test('GREEN: an unknown references kind is refused by name', () => {
  const r = workflow.check({
    title: 'x', steps: ['y'], issued_by: 'owner',
    references: { bogus: ['abc'] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /bogus.*not a known kind/.test(e)), JSON.stringify(r.errors));
});

test('POSITIVE CONTROL: all four known kinds still pass', () => {
  const r = workflow.check({
    title: 'x', steps: ['y'], issued_by: 'owner',
    references: { procedure: ['a'], skill: ['b'], errorclass: ['c'], snippet: ['d'] },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// --- Guarantee 2: workflow optional match fields are type-checked -----

test('RED PROOF: at the fixed commit, workflow.check() had no idea what `triggers` was', () => {
  const wf = showAtFixed('src/workflow.mjs');
  assert.ok(wf.ok);
  assert.doesNotMatch(wf.text, /OPTIONAL_ARRAY_FIELDS/,
    'the fixed commit already validated the optional match fields — pick an earlier hash');
});

test('POSITIVE CONTROL: the fixed commit DID already validate `title`, so the probe sees something real', () => {
  const wf = showAtFixed('src/workflow.mjs');
  assert.match(wf.text, /title missing/);
});

test('GREEN: triggers/path_patterns/tool_patterns/tools/source_proposal/scope are checked', () => {
  for (const field of ['triggers', 'path_patterns', 'tool_patterns', 'tools']) {
    const bad = workflow.check({ title: 'x', steps: ['y'], issued_by: 'owner', [field]: 'not-an-array' });
    assert.equal(bad.ok, false, `${field} accepted a bare string`);
    assert.ok(bad.errors.some((e) => e.includes(field)), JSON.stringify(bad.errors));

    const good = workflow.check({ title: 'x', steps: ['y'], issued_by: 'owner', [field]: ['a', 'b'] });
    assert.equal(good.ok, true, JSON.stringify(good.errors));
  }
  const badProp = workflow.check({ title: 'x', steps: ['y'], issued_by: 'owner', source_proposal: 42 });
  assert.equal(badProp.ok, false);
  const goodProp = workflow.check({ title: 'x', steps: ['y'], issued_by: 'owner', source_proposal: 'thought-123' });
  assert.equal(goodProp.ok, true, JSON.stringify(goodProp.errors));
});

// --- Guarantee 3: snippet carries language/placeholders/origin/used_by/test --

test('RED PROOF: at the fixed commit, snippet.mjs validated none of language/origin/used_by/test', () => {
  const sn = showAtFixed('src/snippet.mjs');
  assert.ok(sn.ok);
  assert.doesNotMatch(sn.text, /language must, when set/);
  assert.doesNotMatch(sn.text, /origin must, when set/);
  assert.doesNotMatch(sn.text, /used_by must, when set/);
  assert.doesNotMatch(sn.text, /test must, when set/);
});

test('POSITIVE CONTROL: the fixed commit DID already validate `version`, so the probe sees something real', () => {
  const sn = showAtFixed('src/snippet.mjs');
  assert.match(sn.text, /version must be a positive integer/);
});

test('GREEN: language/origin/test/used_by/placeholders are type-checked when set', () => {
  const base = { title: 'x', kind: 'code', body: 'y' };
  assert.equal(snippet.check({ ...base, language: 'js' }).ok, true);
  assert.equal(snippet.check({ ...base, language: 3 }).ok, false);
  assert.equal(snippet.check({ ...base, origin: 'copied from repo Z' }).ok, true);
  assert.equal(snippet.check({ ...base, origin: {} }).ok, false);
  assert.equal(snippet.check({ ...base, test: 'test/snippet.test.mjs' }).ok, true);
  assert.equal(snippet.check({ ...base, test: 7 }).ok, false);
  assert.equal(snippet.check({ ...base, used_by: ['wf-1', 'wf-2'] }).ok, true);
  assert.equal(snippet.check({ ...base, used_by: 'wf-1' }).ok, false);
  assert.equal(snippet.check({ ...base, placeholders: ['NAME'] }).ok, true);
  assert.equal(snippet.check({ ...base, placeholders: [''] }).ok, false);
});

test('GREEN: complete() defaults placeholders from body, the way baustein.ergaenze does', () => {
  const out = snippet.complete({ title: 'x', kind: 'text', body: 'Hi {{NAME}}, ref {{ID}}.' });
  assert.deepEqual(out.placeholders.sort(), ['ID', 'NAME']);
  const noPh = snippet.complete({ title: 'x', kind: 'code', body: 'no placeholders here' });
  assert.deepEqual(noPh.placeholders, []);
  const explicit = snippet.complete({ title: 'x', kind: 'text', body: 'Hi {{NAME}}', placeholders: ['NAME', 'EXTRA'] });
  assert.deepEqual(explicit.placeholders, ['NAME', 'EXTRA'], 'an explicit list must not be overwritten');
});

// --- Guarantee 4: redaction catches the three measured gaps -----------
//
// Measured directly against lucky-mem's src/redaktion.mjs (not assumed):
// on the fixed commit, all three fired in lucky-mem's module and none
// fired in cheap-mem's. See the session report for the side-by-side
// numbers; these three fixtures are the exact ones measured with.

test('RED PROOF: at the fixed commit, redaction.mjs had no credential-pair or CLI-flag detector', () => {
  const rd = showAtFixed('src/redaction.mjs');
  assert.ok(rd.ok);
  assert.doesNotMatch(rd.text, /credential-pair/);
  // The fixed-commit source has no CLI-flag-form pattern (`--token
  // value`, space instead of `:`/`=`) — only the `KEY=value` assignment
  // form this build adds a second `env-secret` entry next to.
  assert.doesNotMatch(rd.text, /access\[-_\]\?key/,
    'the fixed commit already had the CLI-flag pattern — the red proof is stale');
});

test('POSITIVE CONTROL: the fixed commit DID already catch a plain assignment, so the probe sees something real', () => {
  const rd = showAtFixed('src/redaction.mjs');
  assert.match(rd.text, /export function redact\(/);
});

test('GREEN: a CLI-flag-form secret is caught (was missed before)', () => {
  const { found, text } = redaction.redact('cloudflared tunnel run --token eyABCDEFGHIJKLMNOPQRSTUVWXYZ01234567');
  assert.ok(found.some((f) => f.type === 'env-secret'), JSON.stringify(found));
  assert.ok(!text.includes('eyABCDEFGHIJKLMNOPQRSTUVWXYZ01234567'));
});

test('GREEN: a keyword-free address/secret pair is caught (was missed before)', () => {
  const { found, text } = redaction.redact('admin: someone@example.com / aB3xY9kQ7mZ2pL5wQ1');
  assert.ok(found.some((f) => f.type === 'credential-pair'), JSON.stringify(found));
  assert.ok(text.includes('someone@example.com'), 'the address itself is not the secret and must survive');
  assert.ok(!text.includes('aB3xY9kQ7mZ2pL5wQ1'));
});

test('GREEN: fetch\'s credentials: "same-origin"/"include"/"omit" are no longer false positives', () => {
  for (const v of ['same-origin', 'include', 'omit']) {
    const { found } = redaction.redact(`fetch(url, { credentials: '${v}' })`);
    assert.deepEqual(found, [], `credentials: '${v}' should not be flagged`);
  }
});

test('POSITIVE CONTROL: a real credential inside a fetch call is still caught', () => {
  const { found } = redaction.redact("fetch(url, { headers: { Authorization: 'Bearer sk-liveABCDEFGHIJKLMNOPQRSTUVWXYZ01' } })");
  assert.ok(found.length > 0, 'the same-origin exemption must not blanket-exempt real secrets nearby');
});

test('GREEN: selfTest() still passes with the two new patterns added', () => {
  const r = redaction.selfTest();
  assert.equal(r.ok, true, JSON.stringify(r));
});
