// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Review of the port of the Fable run (2026-10-12): besides the search index, four more files are DERIVED from the drawers and
// valid by their file stamps: .mem/backlinks.json, .mem/component-table.json, the dashboard head and the time track of a
// drawer. Built by the code from before the read-side fix they may carry data of lines that are broken now (an object in a
// text field) and would be served as they stand. Each got a new format version, so an older file is rebuilt once. Every
// probe plants a file in the PREVIOUS format (pinned, not VERSION - 1) and checks it is not used; a current-format file is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as backlinks from '../src/backlinks.mjs';
import * as componentTable from '../src/component-table.mjs';
import * as head from '../src/dashboard-head.mjs';
import * as timetrack from '../src/timetrack.mjs';

function world(t) {
  const root = tempDir('cm-derived-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'dc', participants: ['a'], language: 'en' }));
  memory.logEntry(root, 'error', { title: 'boom in src/a.mjs', text: 'it broke', class: 'looks-right-does-nothing', file: 'src/a.mjs', agent: 'a' });
  memory.logEntry(root, 'decision', { topic: 'x', choice: 'c', why: 'w', agent: 'a' });
  return root;
}
const rewrite = (file, fn) => fs.writeFileSync(file, JSON.stringify(fn(JSON.parse(fs.readFileSync(file, 'utf8')))));

test('backlinks.json of the previous format (1) is rebuilt, one of the current format is kept', (t) => {
  const root = world(t);
  assert.ok(backlinks.BACKLINKS_VERSION > 1);
  const built = backlinks.write(root);
  const file = path.join(root, backlinks.BACKLINKS_PATH);
  rewrite(file, (d) => ({ ...d, version: 1, planted: true }));
  assert.equal(backlinks.update(root).planted, undefined, 'the old-format register was served');
  rewrite(file, (d) => ({ ...d, planted: true }));
  assert.equal(backlinks.update(root).planted, true, 'positive control: a current-format register is kept');
  assert.equal(built.version, backlinks.BACKLINKS_VERSION);
});

test('component-table.json of the previous format (1) is rebuilt, one of the current format is kept', (t) => {
  const root = world(t);
  assert.ok(componentTable.TABLE_VERSION > 1);
  componentTable.write(root);
  const file = path.join(root, componentTable.TABLE_PATH);
  rewrite(file, (d) => ({ ...d, version: 1, planted: true }));
  assert.equal(componentTable.update(root).planted, undefined, 'the old-format table was served');
  rewrite(file, (d) => ({ ...d, planted: true }));
  assert.equal(componentTable.update(root).planted, true, 'positive control: a current-format table is kept');
});

test('the dashboard head of the previous format (1) is not read, one of the current format is', (t) => {
  const root = world(t);
  head.writeHead(root, { entries: [], total: 0 }, { stamp: 'S1', builtMs: Date.now(), durationMs: 5 });
  assert.ok(head.readHead(root), 'positive control: a current-format head is read');
  rewrite(head.headPath(root), (d) => ({ ...d, version: 1 }));
  assert.equal(head.readHead(root), null, 'the old-format head was served');
});

test('a time track of the previous format (2) is broken, so the drawer is read in full', (t) => {
  const root = world(t);
  for (let i = 0; i < 300; i += 1) memory.logEntry(root, 'decision', { topic: `t${i}`, choice: 'c', why: 'w'.repeat(80), agent: 'a' });
  const drawer = memory.logPath(root, 'decision');
  timetrack.buildFile(root, drawer, { minBytes: 0, blockBytes: 4096 });
  assert.equal(timetrack.readTrack(root, drawer).status, 'valid', 'positive control: a current-format track is valid');
  rewrite(timetrack.trackPath(root, drawer), (d) => ({ ...d, version: 2 }));
  assert.equal(timetrack.readTrack(root, drawer).status, 'broken', 'the old-format track was trusted');
});
