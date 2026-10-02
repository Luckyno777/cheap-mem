// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// hookcost-cm.test.mjs — the skill offer costs nothing when there is
// nothing to offer: on a store without a released skill the prompt hook
// (`src/recallhook.mjs recall`) never imports the skill registry or the
// search module. Where a skill may be offered, the offer is unchanged.
//
// Red proof: against the fixed base commit 8397f6c the import probe is red
// (the old hook imported src/skillregistry.mjs and src/search.mjs on every
// prompt with MEM_RH_PROMPT set) and `mayOffer`/`SKILL_FILE` do not exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as reg from '../src/skillregistry.mjs';
import * as recallhook from '../src/recallhook.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const RH = path.join(REPO, 'src', 'recallhook.mjs');
const PROMPT = 'how do I publish the package for the npm release';

function world(t) {
  const root = tempDir('cm-hookcost-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { input: '' }).status, 0);
  return root;
}
const skill = (root, extra = {}, project = null) => memory.logEntry(root, 'skill',
  { title: 'Publish', text: 'Publish — body', triggers: 'publish package,npm release', ...extra }, { project }).entry;
const release = (root, id, project = null) => memory.logEntry(root, 'skill',
  { status_of: id, status: 'released', issued_by: 'owner', agent: 'test' }, { project });

// A module hook that writes every module URL the hook process loads into a file.
const LOADER = `data:text/javascript,${encodeURIComponent(`
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(\`
import fs from 'node:fs';
export async function load(url, ctx, next) {
  if (process.env.HOOKCOST_LOG && url.startsWith('file:')) fs.appendFileSync(process.env.HOOKCOST_LOG, url + '\\\\n');
  return next(url, ctx);
}\`));
`)}`;

function hookRun(t, root) {
  const log = path.join(tempDir('cm-hookcost-log-', t), 'loaded.txt');
  const r = spawnSync(process.execPath, ['--import', LOADER, RH, 'recall'], {
    input: '{"hits":[]}', encoding: 'utf8',
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RH_PROMPT: PROMPT, HOOKCOST_LOG: log },
  });
  const loaded = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : null;
  return { out: r.stdout, loaded };
}
const loads = (loaded, file) => loaded.some((u) => u.endsWith(`/src/${file}`));

test('empty store: the prompt hook loads neither the skill registry nor the search module', (t) => {
  const { out, loaded } = hookRun(t, world(t));
  assert.ok(loaded && loads(loaded, 'recallhook.mjs'), 'the probe saw no module at all — it measures nothing');
  assert.ok(!loads(loaded, 'skillregistry.mjs'), 'the registry was imported on a store without skills');
  assert.ok(!loads(loaded, 'search.mjs'), 'the search module was imported for the skill offer');
  assert.equal(out, '', 'an empty store answered something');
});

test('POSITIVE: with one released skill the same probe sees the registry and the offer goes out', (t) => {
  const root = world(t);
  release(root, skill(root).id);
  const { out, loaded } = hookRun(t, root);
  assert.ok(loads(loaded, 'skillregistry.mjs'), 'the probe does not see a registry import that happens');
  assert.match(out, /Skill publish fits \(mem_skill_fetch publish\)/);
});

test('a skill that is not released keeps the registry unloaded and offers nothing, as before', (t) => {
  const root = world(t);
  skill(root);
  const { out, loaded } = hookRun(t, root);
  assert.ok(!loads(loaded, 'skillregistry.mjs'));
  assert.equal(out, '');
});

test('the check is a superset: released in a project drawer, an escape, a released title', (t) => {
  const a = world(t);
  memory.projectInit(a, 'p1');
  const s = skill(a, {}, 'p1');
  assert.equal(recallhook.mayOffer(a), false, 'an unreleased project skill');
  release(a, s.id, 'p1');
  assert.equal(recallhook.mayOffer(a), true, 'a released skill in a project drawer was missed');

  const b = world(t);
  fs.appendFileSync(path.join(b, 'global', recallhook.SKILL_FILE), '{"id":"x","title":"\\u0072eleased?"}\n');
  assert.equal(recallhook.mayOffer(b), true, 'a \\u escape must fall back to the full check');

  const c = world(t);
  skill(c, { title: 'Get it released' });
  assert.equal(recallhook.mayOffer(c), true, 'the word anywhere opens the full check (it decides, not this)');
});

test('identical offer: wherever the check opens, the hook answers exactly what the registry answers', async (t) => {
  await reg.loadTokenizer();
  const stores = [];
  const e = world(t); stores.push(e);
  const u = world(t); skill(u); stores.push(u);
  const r1 = world(t); release(r1, skill(r1).id); stores.push(r1);
  const t2 = world(t); skill(t2, { title: 'Get it released' }); stores.push(t2);
  const two = world(t);
  release(two, skill(two).id);
  release(two, skill(two, { title: 'Publish docs', triggers: 'publish package,npm release' }).id);
  stores.push(two);
  for (const root of stores) {
    const want = reg.offer(root, PROMPT);
    assert.deepEqual(await recallhook.skillOffer(root, { MEM_RH_PROMPT: PROMPT }), want, root);
  }
});

test('one truth: the file the check reads is the skill drawer of memory.mjs', () => {
  assert.equal(recallhook.SKILL_FILE, memory.TYPES.skill);
});
