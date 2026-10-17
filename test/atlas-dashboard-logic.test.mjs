// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-dashboard-logic.test.mjs — the pure helpers of the `dashboard` atlas phase (atlas-neue-phasen-cm)
// on planted input: which route a request belongs to, which routes were asked twice, how many lines of
// entry logs lie on disk, and the written-down bounds. No server, no browser.
//
// Red proof (bench/mutation.mjs, "ATLAS-DASHBOARD ..."): a `routeOf` that forgets the part name, a bound on the
// passes over the store relaxed from 32 to 99.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as phase from '../bench/atlas/phase-dashboard.mjs';
import { tempDir } from './temp-dir.mjs';

test('routeOf: a path, plus the part name of a deferred part; the base is cut off', () => {
  const base = 'http://127.0.0.1:1234';
  assert.equal(phase.routeOf(`${base}/dashboard.json`, base), '/dashboard.json');
  assert.equal(phase.routeOf(`${base}/dashboard/part.json?part=raw`, base), '/dashboard/part.json?part=raw');
  assert.equal(phase.routeOf(`${base}/dashboard/part.json?part=entries&from=0&n=5000`, base), '/dashboard/part.json?part=entries');
  assert.equal(phase.routeOf(`${base}/dashboard/app.js?v=abc`, base), '/dashboard/app.js');
});

test('duplicatesOf: only a route asked for more than once, with the count', () => {
  assert.deepEqual(phase.duplicatesOf(['/a', '/b', '/a', '/c', '/a', '/b']), [{ route: '/a', times: 3 }, { route: '/b', times: 2 }]);
  assert.deepEqual(phase.duplicatesOf(['/a', '/b']), []);
  assert.deepEqual(phase.duplicatesOf([]), []);
});

test('linesOnDisk counts the lines of the entry logs under global/ and projects/, nothing else', (t) => {
  const root = tempDir('cm-atlas-dash-', t);
  fs.mkdirSync(path.join(root, 'global'));
  fs.mkdirSync(path.join(root, 'projects', 'p1'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mem'));
  fs.writeFileSync(path.join(root, 'global', 'learnings.jsonl'), '{"a":1}\n{"a":2}\n');
  fs.writeFileSync(path.join(root, 'projects', 'p1', 'errors.jsonl'), '{"a":3}\n');
  fs.writeFileSync(path.join(root, '.mem', 'noise.jsonl'), '{"a":4}\n{"a":5}\n{"a":6}\n');
  fs.writeFileSync(path.join(root, 'global', 'notes.txt'), 'a\nb\nc\n');
  assert.equal(phase.linesOnDisk(root), 3);
  assert.equal(phase.linesOnDisk(path.join(root, 'nothing-here')), 0);
});

test('the bounds are written down: about 29 passes measured, 32 allowed; a cache hit reads under half', () => {
  assert.equal(phase.BUILD_PASSES_MAX, 32);
  assert.equal(phase.CACHED_SHARE_MAX, 0.5);
});
