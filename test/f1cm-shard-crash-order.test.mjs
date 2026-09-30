/**
 * Archiving has no crash point where an entry is in NEITHER place.
 *
 * **The finding, audit 2026-09-30, B3.** archiveOldest wrote the shard,
 * then truncated the drawer in place, and only then appended the
 * manifest rows. A crash between the last two left the moved entries
 * only in a shard no manifest row named: resolveEntry answered FAIL
 * ("no entry") for every one of them. Measured on 241a8aa by throwing
 * after the drawer write: 3 of 3 moved ids FAIL.
 *
 * The probe simulates the crash at every step boundary through the
 * `_crashProbe` seam (a throw leaves the disk exactly as a process
 * killed there would, all writes being synchronous), then checks every
 * id still resolves, and that a re-run finishes the job without
 * archiving anything twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as cfg from '../src/config.mjs';
import * as shardarchive from '../src/shardarchive.mjs';

function seeded(t, n) {
  const root = tempDir('f1cm-shard-crash-', t);
  cfg.writeConfig(root, cfg.DEFAULT_CONFIG);
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(memory.logEntry(root, 'learning', { title: `lesson ${i}`, text: `step ${i} went wrong` }).entry.id);
  }
  return { root, ids };
}

function allResolve(root, ids) {
  return ids.filter((id) => shardarchive.resolveEntry(root, id).state !== shardarchive.PASS);
}

for (const step of ['shard', 'manifest', 'drawer']) {
  test(`a crash right after '${step}' loses no entry, and a re-run completes`, (t) => {
    const { root, ids } = seeded(t, 5);
    shardarchive._crashProbe.crashAt = step;
    try {
      assert.throws(() => shardarchive.archiveOldest(root, 'learning', { count: 3 }), /simulated crash/);
    } finally { shardarchive._crashProbe.crashAt = null; }
    assert.deepEqual(allResolve(root, ids), [], `ids unreachable after a crash at '${step}'`);

    const again = shardarchive.archiveOldest(root, 'learning', { count: 3 });
    assert.deepEqual(allResolve(root, ids), [], 'ids unreachable after the re-run');
    const manifestIds = shardarchive.readManifest(root).map((r) => r.id);
    assert.equal(new Set(manifestIds).size, manifestIds.length, `an id archived twice: ${manifestIds}`);
    if (step !== 'drawer') {
      // the drawer had not been shrunk yet: the re-run must shrink it now
      const live = memory.readLog(root, 'learning').entries.map((e) => e.id);
      assert.deepEqual(live, ids.slice(3), `drawer after re-run (${JSON.stringify(again)})`);
    }
  });
}

test('positive control: an uninterrupted run moves exactly the oldest lines', (t) => {
  const { root, ids } = seeded(t, 5);
  const r = shardarchive.archiveOldest(root, 'learning', { count: 3 });
  assert.equal(r.archived, 3);
  assert.deepEqual(memory.readLog(root, 'learning').entries.map((e) => e.id), ids.slice(3));
  for (const id of ids.slice(0, 3)) {
    const res = shardarchive.resolveEntry(root, id);
    assert.equal(res.state, shardarchive.PASS);
    assert.equal(res.source, 'archive');
  }
});
