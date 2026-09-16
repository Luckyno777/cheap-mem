// Deleting a raw capture — the one place where "delete" has to mean it.
//
// **The trap this file is built around.** `src/archive.mjs` opens with
// the reason captures were moved out of the repository at all: *git
// deletes nothing.* A file taken out of the working tree is gone from
// the checkout and still in every clone's history. So a delete that
// only removes a row, or only removes a file inside git, has done
// nothing except make the person believe it did — which is worse than
// refusing, because they stop looking.
//
// Hence the shape: the BYTES go, in the archive, outside git. The
// append-only register keeps the capture row and gains a TOMBSTONE
// saying who removed it and why. And the listing shows three states,
// because "the bytes are missing and nobody said so" is a broken
// archive, not a decision, and one word for both would hide it.
//
// invariant: drei-zustaende-nie-zwei
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as archive from '../src/archive.mjs';
import * as raw from '../src/raw.mjs';
import * as consolePage from '../src/console.mjs';

const away = (r) => fs.rmSync(r, { recursive: true, force: true });

/**
 * A memory whose archive really holds bytes.
 *
 * The captures are written the way `capture()` leaves them — gzipped
 * under the archive location, with a register row each — rather than
 * through a stub. A fixture that fakes the storage would not notice a
 * delete that removes the wrong file.
 */
function world({ captures = 2, project = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-review-'));
  const store = path.join(root, 'archive-outside');
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ name: 'review' }));
  archive.setLocation(root, store);
  const cfg = archive.readConfig({}, root);

  const paths = [];
  for (let i = 0; i < captures; i += 1) {
    const rel = path.posix.join('raw', '2026', '09', `2026-09-0${i + 1}T00-00-00Z--s${i}.jsonl.gz`);
    const body = zlib.gzipSync(Buffer.from(`{"line":${i}}\n`, 'utf8'));
    archive.put(cfg, rel, body);
    archive.writeRecord(root, {
      path: rel,
      captured_at: `2026-09-0${i + 1}T00:00:00Z`,
      ts_to: `2026-09-0${i + 1}T00:00:00Z`,
      lines: 1,
      stored_bytes: body.length,
      stamp: { session_id: `s${i}`, surface: 'test', project },
    });
    paths.push(rel);
  }
  return { root, cfg, paths };
}

// --- the bytes -------------------------------------------------------

test('POSITIVE: the fixture really puts bytes in the archive', () => {
  // Without this, every probe below could pass against an archive that
  // was empty all along — and "the file is gone" would prove nothing.
  const { root, cfg, paths } = world();
  try {
    for (const p of paths) {
      const file = archive.filePath(cfg, root, p);
      assert.ok(file, `no file behind ${p}`);
      assert.ok(fs.statSync(file).size > 0, `${p} is an empty file`);
    }
  } finally { away(root); }
});

test('delete removes the bytes, and they are gone from the disk', () => {
  const { root, cfg, paths } = world();
  try {
    const file = archive.filePath(cfg, root, paths[0]);
    const size = fs.statSync(file).size;

    const r = archive.remove(cfg, root, paths[0], { reason: 'nicht mehr gebraucht', by: 'lucky' });
    assert.equal(r.state, 'deleted');
    assert.equal(r.freed, size, 'the freed size is not the size that was there');
    assert.ok(!fs.existsSync(file), 'the file is still on disk');
    assert.equal(archive.reachable(cfg, root, paths[0]), false);

    // And the other one is untouched — a delete that takes a neighbour
    // with it would pass every probe that only looks at its target.
    assert.ok(archive.reachable(cfg, root, paths[1]), 'the second capture was taken too');
  } finally { away(root); }
});

test('the register keeps the capture row and gains a tombstone', () => {
  const { root, cfg, paths } = world();
  try {
    const before = archive.records(root).length;
    archive.remove(cfg, root, paths[0], { reason: 'Platz', by: 'lucky' });
    const rows = archive.records(root);

    assert.equal(rows.length, before + 1, 'the register did not grow by exactly one row');
    assert.ok(rows.some((r) => r.path === paths[0] && r.record !== archive.DELETED_MARK),
      'the capture row was rewritten away — the register is append-only');

    const tomb = archive.deletions(root).get(paths[0]);
    assert.ok(tomb, 'no tombstone');
    assert.equal(tomb.reason, 'Platz');
    assert.equal(tomb.by, 'lucky');
    assert.ok(tomb.at, 'the tombstone does not say when');
    assert.equal(tomb.bytesWereThere, true);
  } finally { away(root); }
});

test('a path the register never saw is refused, not deleted', () => {
  // A delete that shrugs at a typo is one that eventually removes the
  // wrong thing.
  const { root, cfg } = world();
  try {
    assert.throws(() => archive.remove(cfg, root, 'raw/2026/09/never-existed.jsonl.gz'),
      /No capture/);
    assert.equal(archive.records(root).filter(
      (r) => r.record === archive.DELETED_MARK).length, 0,
    'a tombstone was written for something that never existed');
  } finally { away(root); }
});

test('deleting twice does not free the bytes twice', () => {
  const { root, cfg, paths } = world();
  try {
    const first = archive.remove(cfg, root, paths[0], { reason: 'einmal' });
    const second = archive.remove(cfg, root, paths[0], { reason: 'zweimal' });
    assert.equal(first.state, 'deleted');
    assert.equal(second.state, 'already', 'a second delete was treated as a new one');
    assert.equal(second.freed, 0);
    const tombs = archive.records(root).filter((r) => r.record === archive.DELETED_MARK);
    assert.equal(tombs.length, 1, `${tombs.length} tombstones for one capture`);
  } finally { away(root); }
});

// --- three states ----------------------------------------------------

test('the review tells deleted from unreachable', () => {
  // The whole reason this listing exists. Bytes missing WITH a
  // tombstone is a decision; bytes missing WITHOUT one is a broken
  // archive path — and the sibling project lost a whole index to
  // exactly that, silently.
  const { root, cfg, paths } = world({ captures: 3 });
  try {
    archive.remove(cfg, root, paths[0], { reason: 'weg damit', by: 'lucky' });
    // The second one loses its bytes behind everyone's back.
    fs.unlinkSync(archive.filePath(cfg, root, paths[1]));

    const rows = raw.capturesWithState(root);
    const state = Object.fromEntries(rows.map((r) => [r.path, r.state]));
    assert.equal(state[paths[0]], 'deleted');
    assert.equal(state[paths[1]], 'unreachable');
    assert.equal(state[paths[2]], 'present');

    const removed = rows.find((r) => r.path === paths[0]);
    assert.equal(removed.deleted.reason, 'weg damit');
    const broken = rows.find((r) => r.path === paths[1]);
    assert.equal(broken.deleted, null, 'an unreachable capture was given a tombstone');
  } finally { away(root); }
});

test('a capture with no project says null, not "global"', () => {
  // Most sessions never name one. `null` means nobody wrote it down;
  // calling that "global" would invent a fact about every capture.
  const { root } = world({ captures: 1, project: null });
  try {
    assert.equal(raw.capturesWithState(root)[0].project, null);
  } finally { away(root); }

  const named = world({ captures: 1, project: 'quarry' });
  try {
    assert.equal(raw.capturesWithState(named.root)[0].project, 'quarry');
  } finally { away(named.root); }
});

// --- what the rest of the tool sees ----------------------------------

test('a deleted capture leaves the work list', () => {
  // `listCaptures` feeds the index, `pending` and the digest. Handing
  // them a path whose bytes are gone makes each of them fail at the
  // file read, and two of them fail without a word.
  const { root, cfg, paths } = world({ captures: 3 });
  try {
    assert.equal(raw.listCaptures(root).length, 3);
    archive.remove(cfg, root, paths[0], { reason: 'x' });

    const work = raw.listCaptures(root);
    assert.equal(work.length, 2, 'the deleted capture is still in the work list');
    assert.ok(!work.includes(paths[0]));

    // But the review still knows about it — that is the difference
    // between the two functions.
    assert.ok(raw.listCaptures(root, { withDeleted: true }).includes(paths[0]));
    assert.ok(raw.capturesWithState(root).some((r) => r.path === paths[0]));
  } finally { away(root); }
});

test('the console counts captures, not register rows', () => {
  // Counting rows would make every delete look like a NEW capture: the
  // number going up as material is removed is the most convincing kind
  // of wrong.
  const { root, cfg, paths } = world({ captures: 3 });
  try {
    const before = consolePage.collect(root).inventory;
    assert.equal(before.captures, 3);
    assert.equal(before.capturesDeleted, 0);

    archive.remove(cfg, root, paths[0], { reason: 'x' });

    const after = consolePage.collect(root).inventory;
    assert.equal(after.captures, 2, `captures went ${before.captures} -> ${after.captures}`);
    assert.equal(after.capturesDeleted, 1);
  } finally { away(root); }
});

test('the time filter still works over the review rows', () => {
  // `archive.inRange` already existed and is not re-implemented here —
  // a second range filter would eventually disagree with the first.
  const { root } = world({ captures: 3 });
  try {
    const rows = archive.records(root).filter((r) => r.record !== archive.DELETED_MARK);
    const early = archive.inRange(rows, { to: '2026-09-02T00:00:00Z' });
    assert.ok(early.length >= 1 && early.length < rows.length,
      `the range filter kept ${early.length} of ${rows.length} — it filtered nothing`);
  } finally { away(root); }
});
