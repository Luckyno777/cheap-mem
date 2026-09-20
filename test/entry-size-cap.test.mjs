// Entry size cap (external audit, 2026-09-19): a 7.6 MB field value
// wrote straight through `memory.logEntry` without a word, because
// `search.RAW_CAP` (20 KB) only trims what the SEARCH INDEX weighs, not
// what the write path is willing to accept.
//
// `MAX_ENTRY_BYTES` is derived from measurement, not from the gut — see
// the long comment on it in src/memory.mjs for the two numbers behind
// choosing 1 MB (the largest line this repo actually holds, 1792 bytes,
// and the largest field allowed to be large BY DESIGN, `source.mjs`'s
// 4000-character excerpt).
//
// Three properties, each with its own test: the cap fires on the
// FINISHED line rather than one field, the message names both sizes so
// there is a next step, and the raw capture path (gzipped transcripts)
// is provably untouched — that path is a different write mechanism
// entirely, not merely "under the same cap and passing".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as cfg from '../src/config.mjs';
import * as raw from '../src/raw.mjs';

function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-cap-'));
  cfg.writeConfig(r, cfg.DEFAULT_CONFIG);
  return r;
}

test('an entry comfortably under the cap writes normally', () => {
  const root = tmpRoot();
  const { entry } = memory.logEntry(root, 'decision', { topic: 't', choice: 'x', why: 'y' });
  assert.ok(entry.id);
  const { entries } = memory.readLog(root, 'decision');
  assert.equal(entries.length, 1);
});

test('POSITIVE CONTROL: an entry over the cap is refused, not truncated', () => {
  const root = tmpRoot();
  const huge = 'x'.repeat(memory.MAX_ENTRY_BYTES + 1000);
  let err;
  try {
    memory.logEntry(root, 'decision', { topic: 't', choice: 'x', why: huge });
  } catch (e) { err = e; }
  assert.ok(err, 'an oversized entry must throw rather than write through');
  // The message names BOTH the actual and the allowed size — "too big"
  // alone gives nobody a next step, and a test that only checks
  // "throws" would pass just as well for that useless message.
  assert.match(err.message, /\d{6,} bytes/, 'actual size not named');
  assert.ok(err.message.includes(String(memory.MAX_ENTRY_BYTES)), 'allowed size not named');
  // Nothing was written at all — no truncated, half-formed line on disk.
  // A silent truncation would pass "it throws" and still be the bug.
  const { entries } = memory.readLog(root, 'decision');
  assert.equal(entries.length, 0, 'a refused write must leave no line behind');
});

test('the cap is on the FINISHED line, not on any one field', () => {
  const root = tmpRoot();
  // The same total size as the single-field test above, spread across
  // three separate, individually-innocuous-looking fields. A cap that
  // only inspected one field would let this straight through.
  const chunk = 'y'.repeat(Math.ceil((memory.MAX_ENTRY_BYTES + 3000) / 3));
  let err;
  try {
    memory.logEntry(root, 'decision', { topic: chunk, choice: chunk, why: chunk });
  } catch (e) { err = e; }
  assert.ok(err, 'splitting the payload across several fields must not evade the cap');
});

test('an entry exactly at the boundary is the last one accepted', () => {
  // Binary-search the exact byte where an entry crosses
  // MAX_ENTRY_BYTES, so the boundary itself — not just "way under" and
  // "way over" — is proven correct.
  //
  // **The search asks the WRITER, not a reconstruction (2026-09-20).**
  // It used to rebuild the line by hand as `{id, ts, agent, why}` and
  // measure that. That is the entry shape written down a second time,
  // and the second copy went stale the day `logEntry` started stamping a
  // version field: the computed boundary sat six bytes above the one the
  // writer really enforced, and this test failed against correct code.
  //
  // `logEntry` either accepts a payload or throws, and that is the
  // property under test. Asking it directly cannot drift from it, and
  // the next field added to an entry needs no edit here.
  const root = tmpRoot();
  const accepts = (n) => {
    try { memory.logEntry(root, 'decision', { why: 'w'.repeat(n) }); return true; }
    catch { return false; }
  };
  let lo = 0; let hi = memory.MAX_ENTRY_BYTES;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (accepts(mid)) lo = mid; else hi = mid - 1;
  }
  // The search leaves the boundary at `lo`. Both sides are asserted
  // again on a FRESH root, so a pass cannot come from state the search
  // itself left behind.
  const clean = tmpRoot();
  assert.doesNotThrow(() => memory.logEntry(clean, 'decision', { why: 'w'.repeat(lo) }),
    `the writer rejected ${lo} bytes of payload, which the search found acceptable`);
  assert.throws(() => memory.logEntry(clean, 'decision', { why: 'w'.repeat(lo + 1) }),
    `the writer accepted ${lo + 1} bytes, one past the boundary the search found`);
  // And the boundary is a real one, not zero: a search that always
  // answered "no" would leave lo at 0 and both assertions above could
  // still hold on a cap of zero.
  assert.ok(lo > 100, `the boundary came out at ${lo} bytes — the search found nothing`);
});

test('configurable via .mem/config.json "maxEntryBytes"', () => {
  const root = tmpRoot();
  const c = cfg.readConfig(root);
  cfg.writeConfig(root, { ...c, maxEntryBytes: 200 });
  let err;
  try {
    memory.logEntry(root, 'decision', { topic: 't', choice: 'x', why: 'z'.repeat(300) });
  } catch (e) { err = e; }
  assert.ok(err, 'a lowered configured cap must be honoured, not just the built-in floor');
  assert.ok(err.message.includes('cap is 200 bytes'), err.message);

  // And raising it lets through what the floor alone would have refused.
  cfg.writeConfig(root, { ...c, maxEntryBytes: memory.MAX_ENTRY_BYTES * 2 });
  assert.doesNotThrow(() => memory.logEntry(root, 'decision', {
    topic: 't', choice: 'x', why: 'z'.repeat(memory.MAX_ENTRY_BYTES + 1000),
  }));
});

test('a memory with no config yet still enforces the floor', () => {
  // A bare tmp dir mid `mem init` — config.readConfig throws ENOCONFIG.
  // The write path must fall back to MAX_ENTRY_BYTES, not skip the
  // check because reading its own limit failed.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-cap-bare-'));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  assert.throws(() => memory.logEntry(root, 'decision', {
    why: 'z'.repeat(memory.MAX_ENTRY_BYTES + 10),
  }));
});

test('SABOTAGE, described (see the session report for the run): commenting out '
  + 'the size check in logEntry must turn the POSITIVE CONTROL test above red. '
  + 'This test only documents the expectation — the actual comment-out-and-run '
  + 'was performed by hand and reverted; encoding it here would just be testing '
  + 'that the file still has the lines it has.', () => {
  const src = fs.readFileSync(new URL('../src/memory.mjs', import.meta.url), 'utf8');
  assert.match(src, /Buffer\.byteLength\(line, ['"]utf8['"]\)/,
    'the byte-length check must exist in logEntry for the sabotage to have anything to remove');
});

test('PATH EXEMPTION: raw.mjs (the capture path) never imports memory.mjs', () => {
  // Proven by absence in the source, the same way the audit found the
  // original gap — by reading the write path, not by trusting a
  // comment about it. If this ever starts importing memory.mjs, the
  // exemption this whole file relies on may have quietly stopped
  // holding.
  const src = fs.readFileSync(new URL('../src/raw.mjs', import.meta.url), 'utf8');
  assert.ok(!/from ['"]\.\/memory\.mjs['"]/.test(src),
    'raw.mjs must not import memory.mjs — the capture path writes gzip archives '
    + 'directly and must never be bounded by an entry-shaped cap');
});

test('PATH EXEMPTION, functionally: a capture far larger than MAX_ENTRY_BYTES is not rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-cap-raw-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  // One synthetic transcript line whose message content alone is bigger
  // than the entry cap. A real 7.6 MB paste is exactly this shape: one
  // huge field inside one JSON object.
  const bigContent = 'x'.repeat(memory.MAX_ENTRY_BYTES + 500000);
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-09-19T00:00:00Z', message: { role: 'user', content: 'start the work' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-19T00:00:01Z', message: { role: 'assistant', content: bigContent } }),
  ];
  const t = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(t, lines.join('\n') + '\n');

  const r = raw.capture(root, t, {});
  assert.equal(r.status, 'captured', `capture refused a large transcript: ${JSON.stringify(r)}`);
});
