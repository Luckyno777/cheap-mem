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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as archive from '../src/archive.mjs';
import * as raw from '../src/raw.mjs';
import * as consolePage from '../src/console.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as astra from '../src/astra.mjs';

const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

// --- the CLI: `mem raw review` / `mem raw delete` ---------------------
//
// `world()` above builds a bare `.mem/config.json` with no `participants`
// map — enough for the library functions, not for the CLI, which calls
// `requireConfig()` on every subcommand. So the CLI probes go through
// `mem init` first, the same door any real user goes through, and then
// seed the archive exactly like `world()` does: real gzip bytes via
// `archive.put`, never a stub that only pretends to store something.
function cliWorld({ captures = 2, project = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-review-cli-'));
  execFileSync('node', [path.join(PKG_ROOT, 'bin', 'mem'), '--root', root, 'init'], { encoding: 'utf8' });
  const store = path.join(root, 'archive-outside');
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

/** Run `mem <args>` against a root. Never throws — the exit code and both
 * streams matter to these probes, and `execFileSync` throwing on a
 * non-zero exit would make every "this should fail" test clumsier than
 * the thing it checks. */
function mem(root, args) {
  try {
    const out = execFileSync('node', [path.join(PKG_ROOT, 'bin', 'mem'), '--root', root, ...args],
      { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, out, err: '' };
  } catch (e) {
    return { status: e.status ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

test('CLI: raw review lists the three states and counts them', () => {
  const { root, cfg, paths } = cliWorld({ captures: 3 });
  try {
    archive.remove(cfg, root, paths[0], { reason: 'weg', by: 'lucky' });
    fs.unlinkSync(archive.filePath(cfg, root, paths[1]));

    const r = mem(root, ['raw', 'review']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /3 captures — 1 present, 1 deleted, 1 unreachable/);
    assert.match(r.out, new RegExp(paths[2].replace(/[.[\]]/g, '\\$&')));
  } finally { away(root); }
});

test('CLI: raw review --project filters, and does not invent a topic filter', () => {
  const { root } = cliWorld({ captures: 1, project: 'quarry' });
  try {
    const hit = mem(root, ['raw', 'review', '--project', 'quarry']);
    assert.equal(hit.status, 0, hit.err);
    assert.match(hit.out, /1 captures — 1 present/);

    const miss = mem(root, ['raw', 'review', '--project', 'somewhere-else']);
    assert.equal(miss.status, 0, miss.err);
    assert.match(miss.out, /0 captures/);

    // The documented gap: filtering by TOPIC is refused as an unknown
    // flag, not silently accepted and ignored. Silently accepting it
    // would look like a feature that does not exist.
    const topic = mem(root, ['raw', 'review', '--topic', 'anything']);
    assert.equal(topic.status, 1, 'an unknown --topic flag was accepted');
    assert.match(topic.err, /unknown flag/);
  } finally { away(root); }
});

test('CLI: raw review reuses archive.inRange, not a second time filter', () => {
  const { root } = cliWorld({ captures: 3 });
  try {
    const all = mem(root, ['raw', 'review']);
    assert.match(all.out, /^3 captures/);

    const early = mem(root, ['raw', 'review', '--to', '2026-09-02T00:00:00Z']);
    assert.equal(early.status, 0, early.err);
    assert.match(early.out, /^2 captures/, 'the range filter kept the wrong count');
  } finally { away(root); }
});

test('CLI: raw delete without --yes only shows the plan — nothing is touched', () => {
  const { root, cfg, paths } = cliWorld({ captures: 2 });
  try {
    const file = archive.filePath(cfg, root, paths[0]);
    const before = archive.records(root).length;

    const r = mem(root, ['raw', 'delete', paths[0], '--reason', 'testing', '--by', 'lucky']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Would delete/);
    // The exact byte count, not just "some number" — a dry run that
    // shows a made-up figure is worse than one that shows none.
    assert.match(r.out, new RegExp(`bytes: ${fs.statSync(file).size}\\b`));
    assert.match(r.out, /Nothing was deleted/);

    assert.ok(fs.existsSync(file), 'the file was deleted by a dry run');
    assert.equal(archive.records(root).length, before, 'a tombstone was written by a dry run');
  } finally { away(root); }
});

test('CLI: raw delete requires --reason even with --yes', () => {
  const { root, cfg, paths } = cliWorld({ captures: 1 });
  try {
    const file = archive.filePath(cfg, root, paths[0]);
    const r = mem(root, ['raw', 'delete', paths[0], '--yes']);
    assert.equal(r.status, 1, 'a delete without --reason went through');
    assert.match(r.err, /--reason/);
    assert.ok(fs.existsSync(file), 'the file was deleted without a reason');
  } finally { away(root); }
});

test('CLI: raw delete --yes actually deletes, and the register gains a tombstone', () => {
  const { root, cfg, paths } = cliWorld({ captures: 2 });
  try {
    const file = archive.filePath(cfg, root, paths[0]);
    const size = fs.statSync(file).size;

    const r = mem(root, ['raw', 'delete', paths[0], '--reason', 'testing', '--by', 'lucky', '--yes']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, new RegExp(`freed: ${size} bytes`));
    assert.ok(!fs.existsSync(file), 'the CLI reported success but left the file');

    const tomb = archive.deletions(root).get(paths[0]);
    assert.ok(tomb, 'no tombstone after --yes');
    assert.equal(tomb.by, 'lucky');
    assert.equal(tomb.reason, 'testing');

    // The neighbour must be untouched — a delete that takes a neighbour
    // with it would pass every check that only looks at its own target.
    assert.ok(archive.reachable(cfg, root, paths[1]));
  } finally { away(root); }
});

test('CLI: raw delete refuses a path the register never saw', () => {
  const { root } = cliWorld({ captures: 1 });
  try {
    const r = mem(root, ['raw', 'delete', 'raw/2026/09/never-existed.jsonl.gz', '--reason', 'x', '--yes']);
    assert.equal(r.status, 1);
    assert.match(r.err, /no capture/);
    assert.equal(archive.records(root).filter((row) => row.record === archive.DELETED_MARK).length, 0);
  } finally { away(root); }
});

// --- the desk: the review is visible, not just usable from a shell ----

test('the desk collects the raw review as its own data, with real counts', () => {
  const { root, cfg, paths } = world({ captures: 3, project: 'quarry' });
  try {
    archive.remove(cfg, root, paths[0], { reason: 'weg', by: 'lucky' });

    const d = dashboard.collect(root);
    assert.ok(d.raw, 'dashboard.collect() carries no raw field');
    assert.equal(d.raw.captures.length, 3);
    // Three keys always, even at zero — never omitted. Omitting
    // `unreachable` here would silently read as "not measured", and it
    // really was measured, at zero.
    assert.deepEqual(Object.keys(d.raw.counts).sort(), ['deleted', 'present', 'unreachable']);
    assert.equal(d.raw.counts.deleted, 1);
    assert.equal(d.raw.counts.present, 2);
    assert.equal(d.raw.counts.unreachable, 0);
  } finally { away(root); }
});

test('the desk page shows the raw review, deleted ones included', () => {
  const { root, cfg, paths } = world({ captures: 2 });
  try {
    archive.remove(cfg, root, paths[0], { reason: 'aus Platzgruenden', by: 'lucky' });
    const { html } = astra.build(root, { title: 'desk test' });
    assert.match(html, /Raw captures/);
    // The path really is on the page — not just the word "deleted"
    // somewhere unrelated to it.
    assert.ok(html.includes(paths[0]), 'the deleted capture is not shown at all');
    assert.ok(html.includes(paths[1]), 'the present capture is not shown at all');
    assert.match(html, /aus Platzgruenden/);
  } finally { away(root); }
});

test('SABOTAGE CHECK: a wrong raw count would be caught', () => {
  // Sanity for the two tests above: if `capturesWithState` were fed to a
  // counter that (like the console's own history) counted register ROWS
  // instead of live captures, a delete would make the total go UP, not
  // down. Reproduced here directly against dashboard output.
  const { root, cfg, paths } = world({ captures: 2 });
  try {
    const before = dashboard.collect(root).raw.captures.length;
    archive.remove(cfg, root, paths[0], { reason: 'x' });
    const after = dashboard.collect(root).raw.captures.length;
    assert.equal(after, before, `the capture count changed on delete (${before} -> ${after}) `
      + '— a tombstone must not add or remove a row from this list, only change its state');
  } finally { away(root); }
});

// --- and the state that is not a state -------------------------------

test('a register that cannot be read is NOT "no captures"', () => {
  // **The fourth state.** The first version of the desk wrapped the
  // read in `try { ... } catch { rawCaptures = []; }`. An empty list on
  // that page reads as "nothing has been captured yet" — so a broken
  // register arrived looking exactly like a quiet one. That is the
  // house's oldest defect (`annahme-statt-messung`) and the reason this
  // repo counts states rather than truthiness: zero was MEASURED,
  // unreadable was not.
  //
  // The break is real, not stubbed: the register is replaced by a
  // DIRECTORY, so `readFileSync` throws EISDIR the way a genuinely
  // broken file would.
  const w = world({ captures: 2 });
  try {
    const reg = path.join(w.root, archive.RECORD_FILE);
    fs.rmSync(reg, { force: true });
    fs.mkdirSync(reg, { recursive: true });

    const d = dashboard.collect(w.root);
    assert.equal(d.raw.readable, false, 'the desk claims it read a register it could not read');
    assert.ok(d.raw.error, 'the failure travels without saying what failed');
    // Not measured, and therefore not zero. This is the assertion that
    // would have caught the original shape: with `catch { [] }` the
    // counts were 0/0/0 and this line reads 0, not null.
    for (const k of ['present', 'deleted', 'unreachable']) {
      assert.equal(d.raw.counts[k], null, `${k} reports a number nobody counted`);
    }

    const html = astra.build(w.root, { title: 'review' }).html;
    // The NOTE where the table would be, not just the heading. The first
    // version of this line matched anywhere on the page — and the
    // heading says the same thing, so rewriting the note to claim the
    // register was "empty" left this probe green. Found by sabotage.
    assert.match(html, /class="none unmeasured"[\s\S]{0,120}could not be read/,
      'the note in place of the table does not say the register was unreadable');
    assert.match(html, /not measured — the register could not be read/,
      'the heading reports counts that were never taken');
    assert.equal(/No raw capture has been recorded yet/.test(html), false,
      'the page claims there are no captures — that is the bug this probe exists for');
  } finally { away(w.root); }
});

test('POSITIVE: with the register intact the same page does say "none yet"', () => {
  // Without this, the probe above would also pass if the page had simply
  // lost its empty-state sentence altogether.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-review-leer-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'leer' }));
    const d = dashboard.collect(root);
    assert.equal(d.raw.readable, true, 'an empty memory counts as unreadable');
    assert.deepEqual(d.raw.counts, { present: 0, deleted: 0, unreachable: 0 });
    assert.match(astra.build(root, { title: 'review' }).html,
      /No raw capture has been recorded yet/, 'the empty-state sentence is gone');
  } finally { away(root); }
});
