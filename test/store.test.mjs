import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/store.mjs';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cm-st-'));
const rm = (r) => fs.rmSync(r, { recursive: true, force: true });
function file(content, name = 'x.md') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-src-'));
  const p = path.join(d, name);
  fs.writeFileSync(p, content);
  return p;
}

test('the register goes in the repo, the bytes do not', () => {
  const r = root();
  try {
    const l = store.put(r, file('# report\n'), { purpose: 'handover', agent: 'session' });
    assert.match(fs.readFileSync(path.join(r, store.REGISTER), 'utf8'), /"sha256":/);
    assert.ok(fs.existsSync(store.objectPath(r, l.sha256)));
    // objectPath is a real filesystem path and correctly native; the
    // assertion was the thing assuming a separator.
    assert.ok(store.objectPath(r, l.sha256)
      .includes(path.join('objects', l.sha256.slice(0, 2), l.sha256)));
    assert.equal(l.checked, true, 'text must have passed redaction');
  } finally { rm(r); }
});

test('the same content twice stores the bytes once', () => {
  // Content-addressed means forty builds of the same page cost space
  // once. The register still gets two lines — the provenance differs.
  const r = root();
  try {
    const a = store.put(r, file('same\n', 'a.md'), { purpose: 'first' });
    const b = store.put(r, file('same\n', 'b.md'), { purpose: 'second' });
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.already, false);
    assert.equal(b.already, true);
    assert.equal(store.readRegister(r).length, 2, 'both origins stay recorded');
  } finally { rm(r); }
});

test('a text file with a hit is REJECTED, not quietly cleaned', () => {
  // Cleaned bytes would hash differently from what the user produced —
  // then the audit trail proves the wrong thing.
  const r = root();
  try {
    const p = file(`token: ghp_${'A'.repeat(36)}\n`, 'leak.md');
    assert.throws(() => store.put(r, p, { purpose: 'must not' }), /Rejected/);
    assert.equal(fs.existsSync(path.join(r, store.REGISTER)), false, 'nothing registered');
    assert.equal(fs.existsSync(path.join(r, 'store/objects')), false, 'no bytes stored');
  } finally { rm(r); }
});

test('a binary is recorded as unchecked, not as checked', () => {
  const r = root();
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-b-')), 'img.png');
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]));
    const l = store.put(r, p, { purpose: 'image' });
    assert.equal(l.checked, false);
    assert.equal(l.mime, 'image/png');
    assert.equal(store.verify(r).unchecked, 1);
  } finally { rm(r); }
});

test('removing deletes the bytes and keeps the proof', () => {
  // Exactly what "commit everything" cannot do: there, every version
  // stays in history forever, while GDPR Art. 17 requires erasure.
  const r = root();
  try {
    const l = store.put(r, file('sensitive enough\n'), { purpose: 'customer data' });
    store.remove(r, l.sha256, { reason: 'erasure request' });
    assert.equal(fs.existsSync(store.objectPath(r, l.sha256)), false, 'bytes still there');
    const h = store.holdings(r)[0];
    assert.equal(h.sha256, l.sha256, 'the hash still proves WHAT was there');
    assert.ok(h.deleted_at);
    assert.equal(h.delete_reason, 'erasure request');
    const v = store.verify(r);
    assert.equal(v.missing.length, 0, 'deleted is not missing');
    assert.equal(v.deleted, 1);
  } finally { rm(r); }
});

test('verify finds missing, changed and orphaned', () => {
  const r = root();
  try {
    const a = store.put(r, file('stays\n', 'a.md'), { purpose: 'a' });
    const b = store.put(r, file('gets changed\n', 'b.md'), { purpose: 'b' });
    const c = store.put(r, file('disappears\n', 'c.md'), { purpose: 'c' });
    fs.writeFileSync(store.objectPath(r, b.sha256), 'somebody wrote on it\n');
    fs.rmSync(store.objectPath(r, c.sha256));
    const stray = 'f'.repeat(64);
    fs.mkdirSync(path.join(r, 'store/objects/ff'), { recursive: true });
    fs.writeFileSync(path.join(r, 'store/objects/ff', stray), 'never registered\n');

    const v = store.verify(r);
    assert.deepEqual(v.changed.map((l) => l.sha256), [b.sha256]);
    assert.deepEqual(v.missing.map((l) => l.sha256), [c.sha256]);
    assert.deepEqual(v.orphans, [stray]);
    assert.equal(v.registered, 3);
    assert.ok(a.sha256);
  } finally { rm(r); }
});

test('oversized files need an explicit --large', () => {
  const r = root();
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-l-')), 'big.bin');
    fs.writeFileSync(p, Buffer.alloc(store.LARGE_OVER_BYTES + 1));
    assert.throws(() => store.put(r, p, {}), /exceeds/);
    assert.equal(store.put(r, p, { large: true }).size, store.LARGE_OVER_BYTES + 1);
  } finally { rm(r); }
});

test('a malformed hash does not get through remove', () => {
  const r = root();
  try {
    assert.throws(() => store.remove(r, '../../etc/passwd'), /Not a SHA-256/);
    assert.throws(() => store.remove(r, 'short'), /Not a SHA-256/);
  } finally { rm(r); }
});
