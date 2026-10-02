// Y4 (ChatGPT brief 2026-09-30, point 4): `replaces_id` was judged by
// authority.maySupersede, `retires_id` and `closes_id` were applied
// unchecked — an entry with authority=inferred, agent=digest put a
// user-tier target to rest with one line. One rule now
// (authority.mayChangeState), enforced on replay so that import and merge
// are covered too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as state from '../src/state.mjs';
import * as maintenance from '../src/maintenance.mjs';
import { mayChangeState, STATE_FIELDS } from '../src/authority.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cm-y4-'));
const USER = { authority: 'user', agent: 'lucky' };
const DIGEST = { authority: 'inferred', agent: 'digest' };

// field -> the type its line is written in and the extra fields it needs
const FIELDS = [
  ['retires_id', 'decision'],
  ['closes_id', 'duty'],
  ['replaces_id', 'decision'],
];

function scenario(mem, root, field, typ, claimer, targetFields = USER) {
  const t = mem.logEntry(root, 'decision', { text: 'Nutzerwille', ...targetFields });
  const tid = t.entry.id;
  const c = mem.logEntry(root, typ, {
    [field]: tid, state: 'obsolete', text: 'stilllegen', ...claimer,
  });
  return { tid, cid: c.entry.id };
}

test('the rule is one function over exactly the three fields', () => {
  assert.deepEqual([...STATE_FIELDS].sort(), ['closes_id', 'replaces_id', 'retires_id']);
});

for (const [field, typ] of FIELDS) {
  test(`${field}: an inferred digest may NOT put a user-tier target to rest`, () => {
    const root = tmp();
    const { tid, cid } = scenario(memory, root, field, typ, DIGEST);
    const st = state.deriveState(root);
    assert.equal(state.statusOf(st, tid), 'active', 'the target stays active');
    assert.equal(state.statusOf(st, cid), 'disputed', 'the usurper is visibly marked, not dropped');
    assert.match(st.get(cid).why, /may not|outrank|same tier/);
  });

  test(`${field}: the user (higher tier) still can`, () => {
    const root = tmp();
    const { tid } = scenario(memory, root, field, typ, USER, DIGEST);
    const st = state.deriveState(root);
    assert.notEqual(state.statusOf(st, tid), 'active');
    assert.equal(st.get(tid).unresolved, undefined, 'a resolved target is not flagged');
  });

  test(`${field}: the same author may always change their own claim`, () => {
    const root = tmp();
    const { tid } = scenario(memory, root, field, typ, { authority: 'inferred', agent: 'digest' },
      { authority: 'inferred', agent: 'digest' });
    assert.notEqual(state.statusOf(state.deriveState(root), tid), 'active');
  });
}

test('replay: a hostile line that arrives by IMPORT (raw file) is judged the same', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  const lines = [
    { id: 'aaa111', ts: '2026-09-30T10:00:00Z', text: 'user decision', authority: 'user', agent: 'lucky' },
    { id: 'bbb222', ts: '2026-09-30T10:01:00Z', retires_id: 'aaa111', state: 'obsolete', authority: 'inferred', agent: 'digest' },
  ];
  fs.writeFileSync(path.join(root, 'global', 'decisions.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const st = state.deriveState(root);
  assert.equal(state.statusOf(st, 'aaa111'), 'active');
  assert.equal(state.statusOf(st, 'bbb222'), 'disputed');
  // The streaming reader and the array reader must agree (P11 equivalence).
  assert.deepEqual([...state.deriveStateMaterialized(root)], [...st]);
});

test('replay: the closer may come BEFORE its target in file order (merge=union)', () => {
  const closer = { id: 'ccc333', retires_id: 'ddd444', state: 'done', authority: 'inferred', agent: 'digest' };
  const target = { id: 'ddd444', text: 'x', authority: 'user', agent: 'lucky' };
  const m = memory.retiredMap([closer, target]);
  assert.equal(m.has('ddd444'), false);
  assert.equal(m.get('ccc333').state, 'disputed');
});

// --- duties: the intended difference ------------------------------------

test('duty: the debtor may close it even at a LOWER authority', () => {
  const root = tmp();
  const d = memory.logEntry(root, 'duty', { text: 'ship it', owner: 'bob', ...USER }).entry;
  memory.closeDuty(root, d.id, { agent: 'bob', authority: 'inferred' });
  const { open, done, refused } = memory.openDuties(root);
  assert.equal(open.length, 0);
  assert.equal(done.length, 1);
  assert.equal(refused.length, 0);
});

test('duty: a stranger at a lower authority may NOT close it — it stays open and is reported', () => {
  const root = tmp();
  const d = memory.logEntry(root, 'duty', { text: 'ship it', owner: 'bob', ...USER }).entry;
  memory.logEntry(root, 'duty', { closes_id: d.id, state: 'done', ...DIGEST });
  const { open, done, refused } = memory.openDuties(root);
  assert.deepEqual(open.map((x) => x.id), [d.id]);
  assert.equal(done.length, 0);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].target, d.id);
});

test('duty: the ordinary close (unstamped writers, different agents, legacy data) keeps working', () => {
  const root = tmp();
  const d = memory.logEntry(root, 'duty', { text: 'legacy duty', agent: 'session-1' }).entry;
  memory.closeDuty(root, d.id, { agent: 'session-2' });
  const legacyRoot = tmp();
  fs.mkdirSync(path.join(legacyRoot, 'global'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'global', 'duties.jsonl'), [
    { id: 'old111', ts: '2025-01-01T00:00:00Z', text: 'pre-authority duty' },
    { id: 'old222', ts: '2025-01-02T00:00:00Z', closes_id: 'old111', state: 'done' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(memory.openDuties(root).open.length, 0);
  assert.equal(memory.openDuties(legacyRoot).open.length, 0);
  assert.equal(memory.openDuties(legacyRoot).refused.length, 0);
});

test('retire: a higher tier or the owner retires; a lateral (same tier) tombstone is tolerated', () => {
  const root = tmp();
  const t = memory.logEntry(root, 'thought', { text: 'stale', authority: 'agent', agent: 'a1' }).entry;
  memory.retireEntry(root, 'thought', t.id, { agent: 'a2', authority: 'agent', why: 'stale' });
  assert.equal(state.statusOf(state.deriveState(root), t.id), 'done');
});

test('maintenance dedupe (tombstone speaks for the survivor) keeps working over mixed tiers', () => {
  const root = tmp();
  memory.logEntry(root, 'decision', { text: 'same words', title: 't', ...DIGEST });
  memory.logEntry(root, 'decision', { text: 'same words', title: 't', ...USER });
  const report = maintenance.dedupe(root, { type: 'decision' });
  assert.equal(report.length, 1);
  const st = state.deriveState(root);
  assert.equal(state.statusOf(st, report[0].retired), 'obsolete');
  assert.equal(state.statusOf(st, report[0].survivor), 'active');
  assert.equal([...st.values()].filter((v) => v.state === 'disputed').length, 0);
});

// --- missing target: unresolved, not authorised -------------------------

test('a missing target is UNRESOLVED — never an authorisation, and flagged in the map', () => {
  for (const f of STATE_FIELDS) {
    const v = mayChangeState({ agent: 'x', authority: 'user' }, null, f);
    assert.equal(v.ok, false, `${f}: not authorised`);
    assert.equal(v.status, 'unresolved');
  }
  const m = memory.retiredMap([{ id: 'e1', closes_id: 'nope', state: 'done', agent: 'x' }]);
  assert.equal(m.get('nope').unresolved, true);
});

// --- early warning on the write path ------------------------------------

test('the write path answers early: verdict returned, warning emitted, line still appended', async () => {
  const root = tmp();
  const t = memory.logEntry(root, 'decision', { text: 'Nutzerwille', ...USER }).entry;
  const seen = [];
  const on = (w) => { if (w.code === 'CM_STATE_CHANGE_REFUSED') seen.push(w); };
  process.on('warning', on);
  const r = memory.retireEntry(root, 'decision', t.id, { agent: 'digest', authority: 'inferred' });
  await new Promise((res) => setImmediate(res));
  process.off('warning', on);
  assert.equal(r.verdict.status, 'refused');
  assert.equal(seen.length, 1);
  assert.ok(r.entry.id, 'append-only: the attempt is on record');
  assert.equal(state.statusOf(state.deriveState(root), t.id), 'active');
});

// --- Red proof: the fixed pre-fix commit (rule 12) ------------------------
const OLD = 'd0a305aaa819338c96727b55bb3a08883ab8b45b';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let oldTree = null;
try {
  execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${OLD}^{commit}`], { stdio: 'ignore' });
  oldTree = tmp();
  execFileSync('bash', ['-c', `git -C "${REPO}" archive ${OLD} src | tar -x -C "${oldTree}"`]);
} catch { oldTree = null; }

test('RED on the pinned pre-fix commit: retires_id and closes_id let the digest through, replaces_id did not',
  { skip: oldTree ? false : 'pre-fix commit not available in this clone' }, async () => {
    const oldMem = await import(pathToFileURL(path.join(oldTree, 'src', 'memory.mjs')).href);
    const oldState = await import(pathToFileURL(path.join(oldTree, 'src', 'state.mjs')).href);
    const seen = {};
    for (const [field, typ] of FIELDS) {
      const root = tmp();
      const { tid } = scenario(oldMem, root, field, typ, DIGEST);
      seen[field] = oldState.statusOf(oldState.deriveState(root), tid);
    }
    // Positive control: the probe does see a stilled target on the old code
    // (retires/closes), and the one field that was already guarded stays active.
    assert.equal(seen.retires_id, 'obsolete');
    assert.equal(seen.closes_id, 'obsolete');
    assert.equal(seen.replaces_id, 'active');
    // ... and the same three scenarios on the CURRENT code all stay active.
    for (const [field, typ] of FIELDS) {
      const root = tmp();
      const { tid } = scenario(memory, root, field, typ, DIGEST);
      assert.equal(state.statusOf(state.deriveState(root), tid), 'active', field);
    }
  });
