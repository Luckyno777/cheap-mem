// Equality probe for the slim search candidates (port of lucky-mem fadd11f8).
//
// `search()` scores every admitted document but only a few reach the answer;
// the candidates are now slim (score + document reference) and become plain
// hits only for the answer. The answer must stay byte-identical to the pinned
// old state, over many questions and option combinations (MMR, state question,
// minScore, withRetired, coverage, type filter, tie order).
//
// Memory note (measured, see the commit message): in cheap-mem the index
// documents are plain in-memory objects, the candidate only references them,
// so the saving is the candidate object itself (about 130 -> 46 bytes per
// scored document) and does not move the heap limit of a run - the index
// dominates the peak. There is therefore no heap-limit probe for search here
// (it could not be red on the old state); the heap probe lives in
// test/startblock-slim.test.mjs, where the saving is large.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CHILD = path.join(HERE, 'search-slim-child.mjs');
// FIXED state before the change (never merge-base: it moves along with a merge).
const OLD = 'f9fd134003dbdec6e342066fbe21a060ba6bf5c5';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-slim-s-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function oldTree() {
  const dest = path.join(tmp, 'old');
  try {
    fs.mkdirSync(dest, { recursive: true });
    const tar = execFileSync('git', ['-C', REPO, 'archive', OLD, 'src', 'package.json'], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dest], { input: tar });
    return dest;
  } catch { return null; }
}
const old = oldTree();

function child(tree, mode, root, { n = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [CHILD, tree, mode, root, String(n)], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env },
  });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

test('search: same hits as the old state (MMR, state question, minScore, retired, coverage, filters)',
  { skip: !old && 'old commit not reachable (shallow clone?)', timeout: 55000 }, () => {
    const root = path.join(tmp, 'small');
    assert.equal(child(REPO, 'create', root, { n: 1500, env: { WITH_CITES: '1' } }).rc, 0);
    const a = child(old, 'same', root);
    const n = child(REPO, 'same', root);
    assert.equal(a.rc, 0, a.err);
    assert.equal(n.rc, 0, n.err);
    // Since 2026-10-07 the gate's `covered` leaves out conversational filler
    // words of the question (QUERY_FILLER in src/search.mjs: what, how, tell,
    // me, ...). For a question containing one, `covered` is allowed to differ
    // from the pinned old state; every other field (score, order, source,
    // entry) and every other question stays byte-identical.
    const FILLER = /\b(tell|me|explain|please|remind|about|what|how|why|when|where|which|who)\b/i;
    const normal = (out) => JSON.stringify(JSON.parse(out).results.map((r) => (FILLER.test(r.q)
      ? { ...r, hits: r.hits.map(({ covered: _covered, ...h }) => h) } : r)));
    assert.equal(normal(n.out), normal(a.out), 'hits differ from the old state');
    // Positive control: the probe compares real, varied hits and reaches the special paths.
    const results = JSON.parse(n.out).results;
    assert.ok(results.length >= 70);
    assert.ok(results.filter((r) => r.hits.length > 0).length >= results.length * 0.8, 'most cases return hits');
    assert.ok(results.some((r) => r.hits.some((h) => 'covered' in h)), 'coverage was exercised');
    assert.ok(results.some((r) => r.hits.some((h) => h.retired)), 'retired hits were exercised');
    assert.ok(results.some((r) => r.q.startsWith('still') && r.hits.length > 1), 'a state question returned hits');
    for (const h of results.flatMap((r) => r.hits)) {
      assert.ok(!('__w' in h) && !('doc' in h), 'internal fields never leave search()');
      assert.deepEqual(Object.keys(h).slice(0, 5), ['score', 'type', 'project', 'source', 'line']);
    }
  });
