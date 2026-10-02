// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// net-derive-cm.test.mjs — derived links (src/netderive.mjs): pairs that
// share rare evidence, a third kind of edge apart from the declared links
// (port of the sibling house's `vernetzung`, backlog item 10).
//
// Red proof: against the fixed base commit 8397f6c every probe here is red —
// src/netderive.mjs does not exist, `mem net` refuses `--derived`, and the
// dashboard data carries no `net.derived`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as nd from '../src/netderive.mjs';
import * as net from '../src/net.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

let seq = 0;
const row = (text, extra = {}, drawer = 'learning') => {
  seq += 1;
  return { project: 'global', drawer, held: true, entry: { id: `e${String(seq).padStart(5, '0')}`, ts: `2026-09-${String(1 + (seq % 28)).padStart(2, '0')}T${String(seq % 24).padStart(2, '0')}:00:00Z`, title: `entry ${seq}`, text, ...extra } };
};
/** `n` filler rows with only common words (no rare evidence among them). */
const filler = (n) => Array.from({ length: n }, () => row('common words about memory and the usual things'));

test('POSITIVE: shared rare terms AND a shared file make an auto link, from the younger to the older entry', () => {
  const older = row('Zebrafish quorum handshake drops the barnacle lease, see src/quorum.mjs');
  older.entry.ts = '2026-08-01T00:00:00Z';
  const younger = row('Retry the zebrafish quorum handshake and renew the barnacle lease in src/quorum.mjs');
  younger.entry.ts = '2026-09-30T00:00:00Z';
  const d = nd.derive([older, younger, ...filler(600)]);
  assert.equal(d.auto.length, 1, JSON.stringify(d));
  const l = d.auto[0];
  assert.deepEqual([l.from, l.to, l.kind, l.tier], [younger.entry.id, older.entry.id, 'derived', 'auto']);
  assert.match(l.reason, /shared rare terms: barnacle, handshake/);
  assert.match(l.reason, /same file: src\/quorum\.mjs/);
});

test('terms strong alone -> borderline (listed, not drawn); a file alone -> dropped', () => {
  const a = row('Zebrafish quorum handshake drops the barnacle lease');
  const b = row('Zebrafish quorum handshake renews the barnacle lease');
  const c = row('Edited src/lonely.mjs once');
  const e = row('Edited src/lonely.mjs again');
  const d = nd.derive([a, b, c, e, ...filler(600)]);
  assert.equal(d.auto.length, 0);
  assert.equal(d.borderline.length, 1, 'terms alone are a case for the human');
  assert.equal(d.borderline[0].tier, 'borderline');
  assert.ok(d.dropped >= 1, 'the file-only pair is dropped, not listed');
  assert.equal(nd.tierOf({ file: { strength: 9, evidence: ['x'] } }), 'dropped');
  assert.equal(nd.tierOf({ terms: { strength: 12, evidence: ['x'] }, file: { strength: 5.5, evidence: ['y'] } }), 'auto');
  assert.equal(nd.tierOf({ terms: { strength: 11.9, evidence: ['x'] } }), 'dropped', 'just under the bar');
});

test('words with digits and path parts are no evidence (timestamps, ids, hashes)', () => {
  const f = nd.features({ id: 'x', text: 'Run 2026-09-01 id 14urw4e oplym00lqs37 touched src/quorum.mjs and zebrafish' });
  assert.ok(f.words.has('zebrafish'));
  for (const w of ['2026-09-01', '14urw4e', 'oplym00lqs37', 'quorum', 'mjs']) assert.ok(!f.words.has(w), w);
  assert.deepEqual([...f.files], ['src/quorum.mjs']);
  assert.deepEqual([...nd.features({ id: 'y', text: 'x', files: ['bin/mem.ps1', 'README'] }).files], ['bin/mem.ps1']);
});

test('a pair that is already linked (any declared link, either direction) is not derived again', () => {
  const a = row('Zebrafish quorum handshake drops the barnacle lease, see src/quorum.mjs');
  const b = row('Retry the zebrafish quorum handshake and renew the barnacle lease in src/quorum.mjs', { origin: { derived_from: [] } });
  b.entry.origin.derived_from.push(a.entry.id);
  const d = nd.derive([a, b, ...filler(600)]);
  assert.equal(d.auto.length + d.borderline.length, 0);
  assert.equal(d.linked, 1);
  const l = row('', { kind: 'causes', from: a.entry.id, to: b.entry.id }, 'link');
  delete b.entry.origin;
  const d2 = nd.derive([a, b, l, ...filler(600)]);
  assert.equal(d2.linked, 1, 'a link from the links drawer counts as well');
});

test('only content that holds: retired, closing, replaced and non-content drawers stay out', () => {
  const words = 'Zebrafish quorum handshake drops the barnacle lease in src/quorum.mjs';
  const base = [row(words), ...filler(600)];
  const variants = [
    { ...row(words), held: false },
    row(words, { closes_id: 'zzz' }),
    row(words, {}, 'source'),
    row(words, {}, 'link'),
  ];
  for (const v of variants) assert.equal(nd.derive([...base, v]).auto.length, 0, JSON.stringify(v));
  const replaced = row(words);
  const successor = row('something else entirely', { replaces_id: replaced.entry.id });
  assert.equal(nd.derive([...base, replaced, successor]).auto.length, 0, 'a replaced entry is history, not content');
  assert.equal(nd.derive([...base, row(words)]).auto.length, 1, 'POSITIVE: the same pair, both holding, is derived');
});

test('deterministic: the same rows in another order give the same answer', () => {
  const rows = [row('Zebrafish quorum handshake barnacle lease src/quorum.mjs'), row('zebrafish quorum handshake barnacle lease src/quorum.mjs'),
    row('Pelican harbour dredging overtime schedule'), row('pelican harbour dredging overtime notes'), ...filler(600)];
  const a = nd.derive(rows);
  const b = nd.derive([...rows].reverse());
  assert.deepEqual(a, b);
  assert.ok(a.auto.length + a.borderline.length >= 2);
});

test('the declared net stays what it was: derived links never enter net.build', (t) => {
  const root = tempDir('cm-netderive-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { input: '' }).status, 0);
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  for (let i = 0; i < 520; i++) memory.logEntry(root, 'learning', { title: `filler ${i}`, text: 'common words about memory' }, { now: new Date(t0 + i * 1000) });
  const a = memory.logEntry(root, 'error', { title: 'Zebrafish quorum handshake fails', text: 'barnacle lease lost in src/quorum.mjs' }, { now: new Date(t0 + 1e6) }).entry;
  const b = memory.logEntry(root, 'learning', { title: 'Zebrafish quorum handshake retry', text: 'renew the barnacle lease, src/quorum.mjs' }, { now: new Date(t0 + 2e6) }).entry;
  const cli = spawnSync(process.execPath, [MEM, 'net', '--derived', '--json', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(cli.status, 0, cli.stderr);
  const d = JSON.parse(cli.stdout);
  assert.deepEqual(d.auto.map((l) => [l.from, l.to]), [[b.id, a.id]]);
  const text = spawnSync(process.execPath, [MEM, 'net', '--derived', '--root', root], { encoding: 'utf8', input: '' }).stdout;
  assert.match(text, /auto 1 · borderline 0/);
  assert.match(text, /Zebrafish quorum handshake retry -> Zebrafish quorum handshake fails/);
  const plain = JSON.parse(spawnSync(process.execPath, [MEM, 'net', '--json', '--root', root], { encoding: 'utf8', input: '' }).stdout);
  assert.equal(plain.links, 0, 'the declared net counts no derived link');
  const dash = dashboardData.collectDashboard(root);
  assert.equal(dash.net.links, 0);
  assert.deepEqual(dash.net.derived.auto.map((l) => [l.from, l.to, l.tier]), [[b.id, a.id, 'auto']], 'the dashboard gets the same answer as the CLI');
  assert.ok(typeof net.build === 'function');
});
