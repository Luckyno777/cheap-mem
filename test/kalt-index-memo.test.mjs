// test/kalt-index-memo.test.mjs — cold path (2026-09-30): the in-process
// index memo for long-lived processes (src/search.mjs setProcessMemo).
//
// Probes:
//   1. Default OFF: a plain process never memoizes (CLI unchanged).
//   2. Memo ON gives the same search results as the un-memoized load, and
//      it really is the memo answering (positive control: the counters).
//   3. Encrypted entries: decrypted on a COPY; destroying the key takes
//      effect on the very next question (no plaintext in the result), and
//      a rotated key likewise. Positive control: before the change the
//      word IS found.
//   4. An entry appended after the memo was built is found (append path).
//   5. A rewritten log (same size, other bytes) is not served stale.
//   6. The recall server (a real child process, memo on) answers byte for
//      byte what `mem find --json` prints, also after a shred.
// Red proof: at START_COMMIT `setProcessMemo` does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as shred from '../src/shred.mjs';
import * as place from '../src/recallserver-place.mjs';

const START_COMMIT = 'aba20c6';
const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const CLIENT = path.join(CODE, 'bin', 'mem-retrieve-client.mjs');
const WORD = 'uniquesecretquartz';
const PLAIN = 'plainvisiblemarmot';

const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
function mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'kalt-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  return r;
}
function seed(root) {
  for (let i = 0; i < 30; i += 1) memory.logEntry(root, 'decision', { title: `base ${i}`, text: `filler plain entry number ${i}` });
  const enc = memory.logEntry(root, 'decision', { title: 'crypt title', text: `${WORD} vault contents`, shred: true });
  memory.logEntry(root, 'decision', { title: 'open title', text: `${PLAIN} open contents` });
  return enc.id ?? enc.entry?.id;
}
const found = (idx, q) => {
  const r = search.search(idx, q);
  return (r.results ?? r).length;
};
const asText = (idx, q) => JSON.stringify(search.search(idx, q));

test('red proof: the start commit has no process memo', (t) => {
  let src;
  try { src = execFileSync('git', ['show', `${START_COMMIT}:src/search.mjs`], { encoding: 'utf8', stdio: 'pipe' }); }
  catch { t.skip('start commit not in this clone - unknown, not green'); return; }
  assert.ok(!/setProcessMemo/.test(src));
});

test('the memo is OFF by default: a plain process loads without it', () => {
  const root = mkRoot();
  seed(root);
  assert.equal(search.processMemoInfo().on, false);
  search.loadIndex(root);
  search.loadIndex(root);
  assert.deepEqual([search.processMemoInfo().entries, search.processMemoInfo().builds], [0, 0]);
});

test('memo on: same results as the un-memoized load, and the memo really answers', () => {
  const root = mkRoot();
  seed(root);
  const direct = [WORD, PLAIN, 'filler'].map((q) => asText(search.loadIndex(root), q));
  search.setProcessMemo(true);
  try {
    const before = search.processMemoInfo();
    const memoized = [WORD, PLAIN, 'filler'].map((q) => asText(search.loadIndex(root), q));
    assert.deepEqual(memoized, direct, 'memoized results equal the direct ones');
    const after = search.processMemoInfo();
    assert.equal(after.builds - before.builds, 1, 'one build');
    assert.ok(after.hits - before.hits >= 2, `positive control: later questions are memo hits ${JSON.stringify(after)}`);
    assert.equal(found(search.loadIndex(root), WORD), 1, 'the encrypted body is found');
  } finally { search.setProcessMemo(false); }
});

test('key destroyed: the next question has no plaintext; the original stays encrypted', () => {
  const root = mkRoot();
  const id = seed(root);
  search.setProcessMemo(true);
  try {
    const b0 = search.processMemoInfo().builds;
    assert.equal(found(search.loadIndex(root), WORD), 1, 'control: found while the key exists');
    assert.equal(found(search.loadIndex(root), WORD), 1);
    assert.ok(search.processMemoInfo().hits >= 1);
    shred.destroyKey(root, id, { reason: 'test' });
    const idx = search.loadIndex(root);
    assert.equal(found(idx, WORD), 0, 'nothing found by the encrypted words after the key is gone');
    assert.equal(found(idx, PLAIN), 1, 'plain entries unaffected');
    const dump = JSON.stringify(idx.documents.map((d) => d.entry));
    assert.ok(!dump.includes(WORD) && !dump.includes('vault contents'), 'no plaintext left in the served index');
    const stub = idx.documents.find((d) => d.enc);
    assert.equal(stub.encState, 'unreadable');
    // and again (the memo answers, still no plaintext)
    assert.equal(found(search.loadIndex(root), WORD), 0);
    assert.equal(search.processMemoInfo().builds - b0, 1, 'this was the memo, not a rebuild');
  } finally { search.setProcessMemo(false); }
});

test('key rotated (same id, new key): the old body is not readable on the next question', () => {
  const root = mkRoot();
  const id = seed(root);
  search.setProcessMemo(true);
  try {
    assert.equal(found(search.loadIndex(root), WORD), 1);
    shred.destroyKey(root, id);
    shred.putKey(root, id, Buffer.alloc(32, 7));
    const idx = search.loadIndex(root);
    assert.equal(found(idx, WORD), 0);
    assert.equal(idx.documents.find((d) => d.enc).encState, 'unreadable');
  } finally { search.setProcessMemo(false); }
});

test('keyring removed entirely: unreadable, not plaintext', () => {
  const root = mkRoot();
  seed(root);
  search.setProcessMemo(true);
  try {
    assert.equal(found(search.loadIndex(root), WORD), 1);
    fs.rmSync(shred.keyringPath(root));
    assert.equal(found(search.loadIndex(root), WORD), 0);
  } finally { search.setProcessMemo(false); }
});

test('an entry appended after the memo was built is found; encrypted appends too', () => {
  const root = mkRoot();
  seed(root);
  search.setProcessMemo(true);
  try {
    search.loadIndex(root);
    const b0 = search.processMemoInfo().builds;
    memory.logEntry(root, 'decision', { title: 'late one', text: 'zyxwvutsrq late plain arrival' });
    memory.logEntry(root, 'decision', { title: 'late two', text: 'qponmlkjih late vault arrival', shred: true });
    const idx = search.loadIndex(root);
    assert.equal(found(idx, 'zyxwvutsrq'), 1);
    assert.equal(found(idx, 'qponmlkjih'), 1);
    assert.equal(found(idx, WORD), 1);
    const info = search.processMemoInfo();
    assert.equal(info.builds, b0, 'appended in memory, not rebuilt');
    assert.ok(info.appends >= 1);
    // equality with a cold load of the same state
    search.setProcessMemo(false);
    const cold = search.loadIndex(root);
    for (const q of ['zyxwvutsrq', 'qponmlkjih', WORD, 'late']) assert.equal(found(cold, q), found(idx, q), q);
  } finally { search.setProcessMemo(false); }
});

test('a log rewritten in place (same size) is not served stale', () => {
  const root = mkRoot();
  seed(root);
  search.setProcessMemo(true);
  try {
    assert.equal(found(search.loadIndex(root), PLAIN), 1);
    const p = path.join(root, 'global', 'decisions.jsonl');
    const f = fs.existsSync(p) ? p : memory.logPath(root, 'decision', null);
    const text = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, text.replace(PLAIN, 'plainvisiblemarmoX'));
    assert.equal(found(search.loadIndex(root), PLAIN), 0, 'the old text is gone');
    assert.equal(found(search.loadIndex(root), 'plainvisiblemarmoX'), 1);
  } finally { search.setProcessMemo(false); }
});

async function startServer(root) {
  const kid = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(path.join(CODE, 'src', 'recallserver.mjs'))}).then((r) => r.start(${JSON.stringify(root)}))
      .then((x) => { if (!x.running) process.exit(1); process.on('SIGTERM', () => x.close().then(() => process.exit(0))); });
  `], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  kid.stderr.on('data', (s) => { err += s; });
  const until = Date.now() + 15000;
  while (!/listening on/.test(err) && Date.now() < until && kid.exitCode == null) await new Promise((r) => setTimeout(r, 25));
  assert.match(err, /listening on/, err);
  return async () => { if (kid.exitCode != null) return; const gone = new Promise((r) => kid.once('exit', r)); kid.kill('SIGTERM'); await gone; };
}
const noMs = (t) => String(t).replace(/"ms": \d+/, '"ms": 0');
const client = (root, q) => spawnSync(process.execPath, [CLIENT, root, q, '5'], { encoding: 'utf8', timeout: 20000 });
const cli = (root, q) => spawnSync(process.execPath, [MEM, '--root', root, 'find', q, '--top', '5', '--json'], { encoding: 'utf8', timeout: 30000 });

test('recall server (memo on): byte-equal to the CLI; new entry found; no plaintext after the key is gone', async () => {
  const root = mkRoot();
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  const id = seed(root);
  const stop = await startServer(root);
  try {
    for (const q of [WORD, PLAIN, 'filler entry']) {
      const a = client(root, q); const b = cli(root, q);
      assert.equal(a.status, place.CLIENT_RC.OK, a.stderr);
      assert.equal(noMs(a.stdout), noMs(b.stdout), `server == CLI for ${q}`);
    }
    assert.match(client(root, WORD).stdout, new RegExp(WORD), 'control: the server finds the encrypted body');
    memory.logEntry(root, 'decision', { title: 'newest', text: 'lmnopqrstu brand new entry' });
    assert.match(client(root, 'lmnopqrstu').stdout, /lmnopqrstu/, 'the appended entry is found');
    shred.destroyKey(root, id, { reason: 'test' });
    const after = client(root, WORD);
    const cliAfter = cli(root, WORD);
    assert.equal(noMs(after.stdout), noMs(cliAfter.stdout), 'server == CLI after the key is gone');
    const hitsAfter = JSON.stringify(JSON.parse(after.stdout).hits);
    assert.ok(!/uniquesecretquartz|vault contents/.test(hitsAfter), 'no plaintext in the hits after the key is gone');
    const hitsBefore = JSON.stringify(JSON.parse(client(root, PLAIN).stdout).hits);
    assert.match(hitsBefore, new RegExp(PLAIN), 'control: the hits part of the answer does carry entry text');
  } finally { await stop(); }
});
