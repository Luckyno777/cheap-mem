// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Second review (2026-10-12): `checkDrawers` returned at the first broken line, so the warning for lines whose list field carries
// `true` (`tags: true`, written by an older CLI) vanished exactly when the memory also had a broken line - the one moment the
// person reads the finding and fixes lines. Both are named in the one `drawers` finding now.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const cli = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a],
  { encoding: 'utf8', input: '', timeout: 90000, env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_ROOT: root } });
const line = (o) => `${JSON.stringify({ ts: '2026-10-11T22:30:00Z', v: 1, agent: 'x', authority: 'agent', ...o })}\n`;

function world(t) {
  const root = tempDir('cm-drawers-both-', t);
  assert.equal(cli(root, 'init', '--participants', 'lucky,session', '--human', 'lucky').status, 0);
  memory.logEntry(root, 'thought', { title: 'alpha one', text: 'alpha words', agent: 'lucky' });
  return root;
}

test('a broken line AND a list field carrying true: the drawers finding names both', (t) => {
  const root = world(t);
  const file = path.join(root, 'global', 'thoughts.jsonl');
  fs.appendFileSync(file, line({ id: '9legacy001', title: 'alpha legacy tags', text: 'alpha legacy', tags: true }));
  fs.appendFileSync(file, '{"this is": not json\n');
  const doc = cli(root, 'doctor').stdout;
  assert.match(doc, /drawers[^\n]*unparsable lines/, 'the broken line is not reported');
  assert.match(doc, /list field without a list/, 'the legacy list warning was hidden by the broken line');
  assert.match(doc, /9legacy001|thoughts\.jsonl:\d+/);
});

test('positive controls: only the legacy line warns (WARN), only the broken line errors, without the other note', (t) => {
  const a = world(t);
  fs.appendFileSync(path.join(a, 'global', 'thoughts.jsonl'), line({ id: '9legacy001', title: 'alpha legacy', text: 'alpha', tags: true }));
  assert.match(cli(a, 'doctor').stdout, /WARN\s+drawers\s+1 line\(s\) carry a list field without a list/);
  const b = world(t);
  fs.appendFileSync(path.join(b, 'global', 'thoughts.jsonl'), '{"this is": not json\n');
  const out = cli(b, 'doctor').stdout;
  assert.match(out, /drawers[^\n]*unparsable lines/);
  assert.doesNotMatch(out, /list field without a list/);
});
