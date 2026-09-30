// test/o2b-shred-body-fields.test.mjs — O2b (2026-09-30): every content
// field of every type is encrypted by `shred: true`.
//
// Finding (O2 agent): `shred.SHREDDABLE_FIELDS` was a hand copy of the
// old body list without `steps` (workflow) and `body` (snippet). A
// snippet or workflow written with `shred: true` kept its body / steps
// in PLAINTEXT in the jsonl file and in the index cache on disk.
// Decision 1fw996e7zo5c (threat model: data theft at rest): never
// plaintext on disk or in a cache; in memory the signed-in user and the
// agents read and search it decrypted.
//
// Now `SHREDDABLE_FIELDS` is derived from `src/bodyfields.mjs` (one
// truth) plus the free-text fields the old copy carried.
//
// Red proof: on the start commit 26540a2 (origin/sicherung/agent/o2-cm)
// the ratchet and the on-disk probes fail — `body` / `steps` are missing
// from SHREDDABLE_FIELDS and the snippet's body word sits in
// snippets.jsonl and the index cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as shred from '../src/shred.mjs';
import { BODY_FIELDS, BODY_FIELDS_BY_TYPE } from '../src/bodyfields.mjs';

const BODY_WORD = 'snippetsecretobsidian';
const STEP_WORD = 'workflowsecretbasalt';

function mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'o2b-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });
function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
/** Every file under `root` (dot-folders included) containing `needle`. */
const filesWith = (root, needle) => walk(root).filter((f) => fs.readFileSync(f).includes(needle));
const hitsOf = (idx, q) => {
  const r = search.search(idx, q);
  return r.results ?? r;
};

function seed(root) {
  const snip = memory.logEntry(root, 'snippet', {
    title: 'crypt snippet', description: 'a guarded helper', body: `echo ${BODY_WORD} && exit 0`, shred: true,
  });
  const wf = memory.logEntry(root, 'workflow', {
    title: 'crypt workflow', steps: ['open the vault', `turn the ${STEP_WORD} key`, 'close the vault'], shred: true,
  });
  return { snip: snip.entry, wf: wf.entry };
}

test('ratchet: every content field of every type is shreddable (red names the field)', () => {
  const missing = [];
  for (const [type, fields] of Object.entries(BODY_FIELDS_BY_TYPE)) {
    for (const f of fields) if (!shred.SHREDDABLE_FIELDS.includes(f)) missing.push(`${type}.${f}`);
  }
  for (const f of BODY_FIELDS) if (!shred.SHREDDABLE_FIELDS.includes(f) && !missing.some((m) => m.endsWith(`.${f}`))) missing.push(f);
  assert.deepEqual(missing, [], `content fields left in the clear by shred: true: ${missing.join(', ')}`);
});

test('ratchet: nothing the old hand copy encrypted was dropped', () => {
  const OLD = ['choice', 'learning', 'duty', 'rule', 'question', 'skill',
    'why', 'title', 'text', 'fact', 'description', 'excerpt', 'rejected'];
  for (const f of OLD) assert.ok(shred.SHREDDABLE_FIELDS.includes(f), `${f} lost from SHREDDABLE_FIELDS`);
  for (const f of shred.NEVER_ENCRYPT) assert.ok(!shred.SHREDDABLE_FIELDS.includes(f), `${f} must never be encrypted`);
});

test('on disk: an encrypted snippet body and workflow steps are in no file under the root (log + index cache)', () => {
  const root = mkRoot();
  try {
    const { snip, wf } = seed(root);
    assert.equal(snip.body, undefined, 'snippet body left on the written entry');
    assert.equal(wf.steps, undefined, 'workflow steps left on the written entry');
    assert.ok(snip.body_enc && wf.body_enc);
    for (const opts of [{ fresh: true }, {}]) search.loadIndex(root, opts);
    assert.deepEqual(filesWith(root, BODY_WORD), [], 'snippet body in plaintext on disk');
    assert.deepEqual(filesWith(root, STEP_WORD), [], 'workflow steps in plaintext on disk');
  } finally { away(root); }
});

test('positive control: in memory the body and steps decrypt intact and are found by search', () => {
  const root = mkRoot();
  try {
    const { snip, wf } = seed(root);
    const b = memory.readEntryBody(root, snip);
    assert.equal(b.state, 'ok');
    assert.equal(b.fields.body, `echo ${BODY_WORD} && exit 0`);
    const s = memory.readEntryBody(root, wf);
    assert.equal(s.state, 'ok');
    assert.deepEqual(s.fields.steps, ['open the vault', `turn the ${STEP_WORD} key`, 'close the vault']);
    for (const opts of [{ fresh: true }, {}]) {
      const idx = search.loadIndex(root, opts);
      const hb = hitsOf(idx, BODY_WORD);
      assert.equal(hb.length, 1, `snippet body found (${JSON.stringify(opts)})`);
      assert.match(String(hb[0].entry.body), new RegExp(BODY_WORD));
      const hs = hitsOf(idx, STEP_WORD);
      assert.equal(hs.length, 1, `workflow steps found (${JSON.stringify(opts)})`);
      assert.ok(Array.isArray(hs[0].entry.steps));
    }
    // The probe sees plaintext when it is there: a plain snippet leaves its word on disk.
    memory.logEntry(root, 'snippet', { title: 'open snippet', body: 'echo plainsnippetwalrus' });
    assert.ok(filesWith(root, 'plainsnippetwalrus').length > 0, 'probe blind: plain word not found on disk');
  } finally { away(root); }
});

test('key destroyed: body and steps leave search at once', () => {
  const root = mkRoot();
  try {
    const { snip, wf } = seed(root);
    memory.shredEntry(root, 'snippet', snip.id, { reason: 'test' });
    memory.shredEntry(root, 'workflow', wf.id, { reason: 'test' });
    const idx = search.loadIndex(root, { fresh: true });
    assert.equal(hitsOf(idx, BODY_WORD).length, 0);
    assert.equal(hitsOf(idx, STEP_WORD).length, 0);
  } finally { away(root); }
});
