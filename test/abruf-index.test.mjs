// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// abruf-stamm-cm, step 3: one memory, one index language - the recall paths no longer take turns rebuilding the cache.
//
// The finding. The index cache is kept per language; a cache of another language is `stale` (rebuilt, rewritten).
// `mem find` asks for the language of the memory's config. The SubagentStart block, the short-prompt check of the hook
// (`recallhook.signal`), the content-word shortening of a long question (`retrievalQuery`) and a dozen readers asked for
// nothing, which meant 'en'. On a memory configured for another language each of those calls rebuilt the cache that the
// next `mem find` rebuilt again: `cacheStatus` read `stale` on every alternate load, on the path of every turn.
// (The answers of the two indexes were the same on the probe corpus below; the cost was the rebuild.)
//
// The proof counts rebuilds: a rebuild replaces the cache DIRECTORY (one atomic rename), so its inode changes.
//   A. the state: `cacheStatus` of an unnamed-language load next to a named one;
//   B. each recall path leaves the cache alone (and a positive control: a real language change rebuilds);
//   C. red proof: the same paths at the base rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BASE = 'dc6b69d58cbc90e35827f62381897bc3abe8fee6';
const TOPICS = ['Datenbankmigration', 'Zahlungsabwicklung', 'Sicherungskopie', 'Rechnungsstellung', 'Kundenverwaltung'];
const LONG = 'wir haben gestern lange ueber die Datenbankmigration und die Entscheidung daran gesprochen und wollen sie nun wirklich so machen';

function world(t, language = 'de') {
  const root = tempDir('cm-ai-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { input: '' }).status, 0);
  const cfgPath = path.join(root, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.language = language;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  for (let i = 0; i < 30; i += 1) {
    memory.logEntry(root, 'decision', { id: `ai-${i}`, topic: `${TOPICS[i % 5]} Stufe ${i}`, choice: `wir fuehren die ${TOPICS[i % 5]} nachts aus, Variante ${i}`, why: 'weil die Last dann niedrig ist' });
  }
  memory.logEntry(root, 'error', { id: 'ai-err', class: 'wrong-cause', title: 'Datenbankmigration quokka bricht ab', text: 'die Datenbankmigration bricht bei quokka ab' });
  return root;
}
const cacheId = (root) => {
  const st = fs.statSync(path.join(root, search.CACHE_DIR));
  return `${st.ino}:${st.birthtimeMs}`;
};
/** Warm the cache the way `mem find` leaves it. */
const warm = (tree, root) => {
  const r = spawnSync(process.execPath, [path.join(tree, 'bin', 'mem'), '--root', root, 'find', 'Datenbankmigration', '--top', '1', '--json'], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: '' } });
  assert.equal(r.status, 0, r.stderr);
};

/** The recall paths that load the index without naming a language, as a function of a tree. */
const PATHS = {
  'find --content-words, long question': async (tree, root) => {
    const r = spawnSync(process.execPath, [path.join(tree, 'bin', 'mem'), '--root', root, 'find', LONG, '--content-words', '--top', '1', '--json'], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: '' } });
    assert.equal(r.status, 0, r.stderr);
  },
  'SubagentStart task query': async (tree, root) => {
    const m = await import(pathToFileURL(path.join(tree, 'src', 'subagenttask.mjs')).href);
    await m.forTask(root, { prompt: 'Fix the Datenbankmigration quokka crash please.' }, { env: { MEM_RETRIEVE_MIN: '0.1' } });
  },
  'short-prompt check of the hook': async (tree, root) => {
    const m = await import(pathToFileURL(path.join(tree, 'src', 'recallhook.mjs')).href);
    const v = await m.signal(root, 'quokka', {});
    assert.equal(v.search, true, 'precondition: the rare word is what decides, so the index was opened');
  },
};

// --- A. the state ---------------------------------------------------------------

test('A: next to a load that names the memory\'s language, an unnamed load is a hit, not stale', (t) => {
  const root = world(t);
  assert.equal(search.loadIndex(root, { language: 'de' }).cacheStatus, 'miss');
  assert.equal(search.loadIndex(root).cacheStatus, 'hit', 'the unnamed load takes the memory\'s language');
  assert.equal(search.loadIndex(root, { language: 'de' }).cacheStatus, 'hit');
  // positive control: a real change of language IS stale, so "hit" above is not a blind spot
  assert.equal(search.loadIndex(root, { language: 'en' }).cacheStatus, 'stale');
  // control: an English memory behaves as before
  const en = world(t, 'en');
  assert.equal(search.loadIndex(en).cacheStatus, 'miss');
  assert.equal(search.loadIndex(en).cacheStatus, 'hit');
});

test('A2: a memory without a readable config falls back to English, as before', (t) => {
  const root = tempDir('cm-ai-nocfg-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{ not json');
  assert.equal(search.loadIndex(root).language, 'en');
});

// --- B. the paths ----------------------------------------------------------------

for (const [name, run] of Object.entries(PATHS)) {
  test(`B: ${name} leaves the cache of a German memory alone`, async (t) => {
    const root = world(t);
    warm(REPO, root);
    const before = cacheId(root);
    await run(REPO, root);
    assert.equal(cacheId(root), before, 'the path rebuilt the cache');
    warm(REPO, root);
    assert.equal(cacheId(root), before, 'and so does the next mem find');
  });
}

// --- C. red proof at the base ------------------------------------------------------

test('C: at the base each of those paths rebuilds the cache of a German memory (the probes above would fail there)', async (t) => {
  const old = tempDir('cm-ai-base-', t);
  exportCommit(REPO, BASE, ['bin', 'src', 'package.json'], old);
  for (const [name, run] of Object.entries(PATHS)) {
    const root = world(t);
    warm(old, root);
    const before = cacheId(root);
    await run(old, root);
    assert.notEqual(cacheId(root), before, `base: ${name} did not rebuild - the probe measures nothing`);
  }
});

// --- D. one load per question -----------------------------------------------------------

/** How many times the index was asked for: the in-process memo (a warm server's) counts every load. */
const loads = (searchMod) => { const i = searchMod.processMemoInfo(); return i.builds + i.hits + i.appends; };

async function loadsOfOneQuestion(tree, root, flags) {
  const searchMod = await import(pathToFileURL(path.join(tree, 'src', 'search.mjs')).href);
  const { COMMANDS } = await import(pathToFileURL(path.join(tree, 'src', 'cli', 'commands', 'search.mjs')).href);
  const shell = await import(pathToFileURL(path.join(tree, 'src', 'cli', 'shell.mjs')).href);
  searchMod.setProcessMemo(true);
  try {
    const before = loads(searchMod);
    await shell.captureOutput(() => COMMANDS.find({ rest: [LONG], args: { root, json: true, top: '1', ...flags } }));
    return loads(searchMod) - before;
  } finally { searchMod.setProcessMemo(false); }
}

test('D: `find --content-words` on a long question opens the index once', async (t) => {
  const root = world(t);
  assert.equal(await loadsOfOneQuestion(REPO, root, { 'content-words': true }), 1);
  // controls: the plain search opens it once as well; the old double load is real at the base
  assert.equal(await loadsOfOneQuestion(REPO, root, {}), 1);
  const old = tempDir('cm-ai-base-', t);
  exportCommit(REPO, BASE, ['bin', 'src', 'package.json'], old);
  assert.equal(await loadsOfOneQuestion(old, root, { 'content-words': true }), 2, 'base: one load for the shortening, one for the search');
});
