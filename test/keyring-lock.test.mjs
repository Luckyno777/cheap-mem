// The keyring is read-modify-write. Two writers holding stale snapshots
// lost a key (A) or brought back a destroyed one (B). Both now run under
// the keyring lock, reading the newest state inside it.
//
// The "other writer" is a REAL second process: an in-process call would
// hit the nesting guard. Red proof against the pinned pre-lock commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { NEW_SRC, PRE_LOCK_COMMIT, mkTmp, url, oldSrc, runChild, waitForChild } from './filelock-fixtures.mjs';

async function scenario(src, kind) {
  const s = await import(url(src, 'shred.mjs'));
  const root = mkTmp('kl-');
  const marks = mkTmp('klm-');
  const started = path.join(marks, 'started'); const done = path.join(marks, 'done');
  const kp = s.keyringPath(root);
  let child = null;
  const other = (call) => runChild(`
    import fs from 'node:fs';
    const s = await import(${JSON.stringify(url(src, 'shred.mjs'))});
    fs.writeFileSync(${JSON.stringify(started)}, '1');
    ${call}
    fs.writeFileSync(${JSON.stringify(done)}, '1');`);
  if (kind === 'lost-key') s.putKey(root, 'base', randomBytes(32));
  else for (const k of ['X', 'Y']) s.putKey(root, k, randomBytes(32));

  const real = fs.readFileSync; let reads = 0;
  fs.readFileSync = function (p, ...a) {
    const r = real.call(fs, p, ...a);
    if (p === kp && ++reads === 1) {
      fs.readFileSync = real;
      child = other(kind === 'lost-key'
        ? `s.putKey(${JSON.stringify(root)}, 'B', Buffer.alloc(32, 7));`
        : `s.destroyKey(${JSON.stringify(root)}, 'Y');`);
      waitForChild(started, done);
    }
    return r;
  };
  try {
    if (kind === 'lost-key') s.putKey(root, 'A', randomBytes(32));
    else s.destroyKey(root, 'X');
  } finally { fs.readFileSync = real; }
  const res = await child.done;
  assert.equal(res.code, 0, res.out);
  return [...s.loadKeyring(root).keys.keys()].sort();
}

test('A: two putKey with a stale snapshot lose no key', async () => {
  assert.deepEqual(await scenario(NEW_SRC, 'lost-key'), ['A', 'B', 'base']);
});

test('B: a destroyed key is not brought back by a stale destroyKey', async () => {
  assert.deepEqual(await scenario(NEW_SRC, 'resurrect'), []);
});

test(`red proof: the pre-lock commit ${PRE_LOCK_COMMIT.slice(0, 7)} loses the key (A) and revives the destroyed one (B)`, async (t) => {
  const old = oldSrc();
  if (!old) return t.skip(`commit ${PRE_LOCK_COMMIT} not in this clone — red proof not measurable here`);
  assert.deepEqual(await scenario(old, 'lost-key'), ['A', 'base'], 'old code must lose B');
  assert.deepEqual(await scenario(old, 'resurrect'), ['Y'], 'old code must revive Y');
});
