// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// abruf-stamm-cm, step 1 (what was left): the SubagentStart block is asked under the `env` it is GIVEN.
//
// `forTask(root, j, { env })` read its bar (`MEM_RETRIEVE_MIN`) and its off switch from `env`, but the query of the
// assignment went through `retrievalQuery()`, which read the request-frame switch (`MEM_RETRIEVE_REQUEST_FRAME`) from the
// PROCESS: one call, two environments. (`mem find` and the warm server were made to answer under the caller's switches
// on kette/cm, recall-server-env; this is the same rule for the third recall door.)
//
// Red proof: at BASE the process decides, the given `env` is ignored for the frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as subagenttask from '../src/subagenttask.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BASE = 'dc6b69d58cbc90e35827f62381897bc3abe8fee6';
const TASK = 'Explain relativity';

function world(t) {
  const root = tempDir('cm-sge-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { input: '' }).status, 0);
  for (let i = 0; i < 6; i += 1) {
    memory.logEntry(root, 'error', { id: `sge-filler-${i}`, class: 'wrong-cause', title: `unrelated crash ${i}`, text: `the cache crashed in round ${i}` });
  }
  memory.logEntry(root, 'error', { id: 'sge-explain', class: 'wrong-cause', title: 'The explain page broke', text: 'the explain page broke when it was built' });
  memory.logEntry(root, 'error', { id: 'sge-relativity', class: 'wrong-cause', title: 'The relativity module crashed', text: 'the relativity module crashed on load' });
  return root;
}
const idsOf = (r) => (r ? r.ids : []);

async function ask(mod, root, env) {
  // the PROCESS holds the opposite setting while the call is handed `env`
  const saved = process.env.MEM_RETRIEVE_REQUEST_FRAME;
  process.env.MEM_RETRIEVE_REQUEST_FRAME = env.MEM_RETRIEVE_REQUEST_FRAME === '0' ? '' : '0';
  try { return idsOf(await mod.forTask(root, { prompt: TASK }, { env: { MEM_RETRIEVE_MIN: '0.1', ...env } })); } finally {
    if (saved === undefined) delete process.env.MEM_RETRIEVE_REQUEST_FRAME; else process.env.MEM_RETRIEVE_REQUEST_FRAME = saved;
  }
}

test('the request frame follows the given env, not the process', async (t) => {
  const root = world(t);
  const kept = await ask(subagenttask, root, { MEM_RETRIEVE_REQUEST_FRAME: '0' });
  const dropped = await ask(subagenttask, root, {});
  assert.ok(kept.includes('sge-explain'), `frame kept: "explain" is a subject word (${kept})`);
  assert.ok(!dropped.includes('sge-explain') && dropped.includes('sge-relativity'), `frame dropped: only the subject is asked (${dropped})`);
});

test('red proof: at the base the process decides', async (t) => {
  const root = world(t);
  const old = tempDir('cm-sge-base-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], old);
  const mod = await import(pathToFileURL(path.join(old, 'src', 'subagenttask.mjs')).href);
  const kept = await ask(mod, root, { MEM_RETRIEVE_REQUEST_FRAME: '0' });
  const dropped = await ask(mod, root, {});
  assert.ok(!kept.includes('sge-explain'), `base: the process says "drop", the given env is ignored (${kept})`);
  assert.ok(dropped.includes('sge-explain'), `base: the process says "keep" (${dropped})`);
});
