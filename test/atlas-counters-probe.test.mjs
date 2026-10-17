// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-counters-probe.test.mjs — the four counters the new atlas phases lead with
// (atlas-neue-phasen-cm) count a PLANTED program exactly, and say when they ran at all.
//
// Why this file exists: a counter that counts less than it sees reads as a good result.
// The `cost`, `digest` and `dashboard` phases print a number from each of these preloads
// and compare it with a ratchet; if the preload silently counted nothing, every ratchet
// would pass. So each counter gets a known program here, with the answer written down:
//
//   start-counter   node processes started            (bench/atlas/start-counter.mjs)
//   module-counter  modules loaded, groups among them (bench/atlas/module-counter.mjs)
//   call-counter    fs calls, opens per log, workers  (bench/atlas/call-counter.mjs)
//
// (bench/atlas/io-counter.mjs has its own probe in test/atlas-skala-identifiers-probe.test.mjs; its `watch` parameter, added for the
// cost phase, is held here.)
//
// Red proof: the mutants "counter writes nothing" for each of the three in bench/mutation.mjs
// turn the matching test red (a counter that wrote nothing would give an empty list here, and
// `null` when the preload never ran: both are asserted apart from zero).
//
// Windows: every program is a node script started with `process.execPath`; no shell, no /tmp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { readStarts } from '../bench/atlas/start-counter.mjs';
import { readModules, groupsOf } from '../bench/atlas/module-counter.mjs';
import { readRows, total } from '../bench/atlas/call-counter.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The file: URL of a counter preload with its query (an object, so every `--import` below reads `.href`). */
const spec = (file, query) => {
  const url = pathToFileURL(path.join(REPO, 'bench', 'atlas', file));
  url.search = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return url;
};

test('start-counter: a node that starts two nodes is three starts; a missing file is null, not zero', (t) => {
  const dir = tempDir('cm-atlas-sc-', t);
  const out = path.join(dir, 'starts.txt');
  fs.writeFileSync(out, '');
  const parent = path.join(dir, 'parent.mjs');
  fs.writeFileSync(parent, "import { spawnSync } from 'node:child_process';\n"
    + "spawnSync(process.execPath, ['-e', '0']);\n"
    + "spawnSync(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, SC_TAGGED: '1' } });\n");
  const r = spawnSync(process.execPath, [parent], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${spec('start-counter.mjs', { out, tag: 'SC_TAGGED' }).href}` } });
  assert.equal(r.status, 0, r.stderr);
  const rows = readStarts(out);
  assert.equal(rows.length, 3, JSON.stringify(rows));
  assert.deepEqual(rows.map((x) => x.script).sort(), ['', '', 'parent.mjs']);
  assert.equal(rows.filter((x) => x.tagged).length, 1, 'exactly the child that had the tag variable is labelled');
  assert.ok(!JSON.stringify(rows).includes(dir), 'no scratch path travels into a row');
  assert.equal(readStarts(path.join(dir, 'never-written.txt')), null, 'a counter that never ran is not an empty list');
  // Without `tag` nothing is labelled, even where the variable is set.
  fs.writeFileSync(out, '');
  spawnSync(process.execPath, ['-e', '0'], { env: { ...process.env, SC_TAGGED: '1', NODE_OPTIONS: `--import=${spec('start-counter.mjs', { out }).href}` } });
  assert.equal(readStarts(out)[0].tagged, false);
});

test('module-counter: a script and its import are listed, built-ins are not, and the groups are read off the paths', (t) => {
  const dir = tempDir('cm-atlas-mc-', t);
  const out = path.join(dir, 'modules.txt');
  fs.writeFileSync(out, '');
  fs.writeFileSync(path.join(dir, 'child.mjs'), 'export const x = 1;\n');
  const main = path.join(dir, 'main.mjs');
  fs.writeFileSync(main, "import fs from 'node:fs';\nimport { x } from './child.mjs';\nvoid fs; void x;\n");
  const r = spawnSync(process.execPath, [`--import=${spec('module-counter.mjs', { out }).href}`, main], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const urls = readModules(out);
  assert.ok(urls.some((u) => u.endsWith('/main.mjs')), JSON.stringify(urls));
  assert.ok(urls.some((u) => u.endsWith('/child.mjs')), JSON.stringify(urls));
  assert.ok(urls.every((u) => u.startsWith('file:')), 'only file: modules are listed');
  assert.equal(readModules(path.join(dir, 'never-written.txt')), null);
  assert.deepEqual(groupsOf(['file:///x/src/cli/commands/search.mjs', 'file:///x/src/search.mjs', 'file:///y/src/cli/commands/admin.mjs']), ['search', 'admin']);
  assert.deepEqual(groupsOf(null), []);
});

test('module-counter on the CLI: `mem find` loads its group, `mem --help` loads none (the control that the count moves with the work)', (t) => {
  const dir = tempDir('cm-atlas-mc2-', t);
  const root = path.join(dir, 'mem');
  fs.mkdirSync(root);
  assert.equal(spawnSync(process.execPath, [path.join(REPO, 'bin', 'mem'), 'init', '--root', root], { input: '' }).status, 0);
  const count = (args) => {
    const out = path.join(dir, `m-${args[0].replace(/\W/g, '')}.txt`);
    fs.writeFileSync(out, '');
    const r = spawnSync(process.execPath, [`--import=${spec('module-counter.mjs', { out }).href}`, path.join(REPO, 'bin', 'mem'), '--root', root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return readModules(out);
  };
  const help = count(['--help']);
  const find = count(['find', 'x']);
  assert.deepEqual(groupsOf(help), []);
  assert.deepEqual(groupsOf(find), ['search']);
  assert.ok(find.length > help.length, `${find.length} modules for find, ${help.length} for --help`);
});

test('call-counter: planted calls are counted exactly; opens are per file under the root; workers are counted; files outside the root are not named', (t) => {
  const dir = tempDir('cm-atlas-cc-', t);
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  const log = path.join(root, 'global', 'planted.jsonl');
  fs.writeFileSync(log, '{"a":1}\n');
  const other = path.join(dir, 'outside.txt');
  fs.writeFileSync(other, 'x');
  const note = path.join(root, 'note.txt'); // under the root, but not an entry log
  fs.writeFileSync(note, 'y');
  const out = path.join(dir, 'calls.txt');
  fs.writeFileSync(out, '');
  const prog = path.join(dir, 'prog.mjs');
  fs.writeFileSync(prog, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { Worker } from 'node:worker_threads';",
    'const [log, other, note] = process.argv.slice(2);',
    'fs.existsSync(log); fs.existsSync(log); fs.existsSync(other);',
    'fs.statSync(log); fs.lstatSync(log); fs.accessSync(log); fs.readdirSync(path.dirname(log));',
    'fs.readFileSync(log, "utf8"); fs.readFileSync(log);',          // two opens
    'fs.closeSync(fs.openSync(log, "r"));',                          // one open
    'fs.createReadStream(log).on("data", () => {});',                // one open
    'fs.readFileSync(other); fs.readFileSync(note);',                // opens, but not of an entry log
    'if (typeof fs.realpathSync.native !== "function") throw new Error("realpathSync.native was lost");',
    'fs.realpathSync.native(log);',
    "const w = new Worker('0', { eval: true });",
    "w.on('exit', () => {});",
  ].join('\n'));
  const r = spawnSync(process.execPath, [`--import=${spec('call-counter.mjs', { root, out }).href}`, prog, log, other, note], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = readRows(out);
  const sum = total(rows);
  assert.equal(sum.calls.existsSync, 3, JSON.stringify(sum.calls));
  assert.equal(sum.calls.statSync, 1);
  assert.equal(sum.calls.lstatSync, 1);
  assert.equal(sum.calls.accessSync, 1);
  assert.equal(sum.calls.readdirSync, 1);
  assert.equal(sum.workers, 1, 'the worker thread');
  assert.equal(sum.opens['global/planted.jsonl'], 4, `two readFileSync + openSync + createReadStream: ${JSON.stringify(sum.opens)}`);
  assert.deepEqual(Object.keys(sum.opens), ['global/planted.jsonl'], 'only files under global/ or projects/ are named: not a file under the root, not a file outside it');
  assert.ok(!JSON.stringify(rows).includes(dir), 'no scratch path travels into a row');
  assert.equal(readRows(path.join(dir, 'never-written.txt')), null, 'a counter that never ran is not an empty list');
});

test('io-counter `watch`: the bytes of ONE file are counted on their own, whatever else is read under the root', (t) => {
  const dir = tempDir('cm-atlas-io-', t);
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
  const watched = path.join(root, '.pipeline', 'journal.jsonl');
  fs.writeFileSync(watched, 'x'.repeat(1000));
  fs.writeFileSync(path.join(root, '.pipeline', 'other.txt'), 'y'.repeat(300));
  const prog = path.join(dir, 'prog.mjs');
  fs.writeFileSync(prog, "import fs from 'node:fs';\nconst [a, b] = process.argv.slice(2);\nfs.readFileSync(a); fs.readFileSync(a, 'utf8'); fs.readFileSync(b);\n");
  const run = (query) => {
    const out = path.join(dir, `io-${Object.keys(query).join('')}.txt`);
    fs.writeFileSync(out, '');
    const r = spawnSync(process.execPath, [`--import=${spec('io-counter.mjs', { root, out, ...query }).href}`, prog, watched, path.join(root, '.pipeline', 'other.txt')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return readRows(out)[0];
  };
  const withWatch = run({ watch: '.pipeline/journal.jsonl' });
  assert.equal(withWatch.watchedBytesRead, 2000, 'two reads of the watched file');
  assert.equal(withWatch.otherBytesRead, 2300, 'the watched file is still counted in its class too');
  assert.equal(run({}).watchedBytesRead, 0, 'without `watch` nothing is watched');
  assert.equal(run({ watch: '.pipeline/nothing.txt' }).watchedBytesRead, 0);
});

test('call-counter: the doctor starts its append-probe writers only with --full (the number the cost phase judges)', (t) => {
  const dir = tempDir('cm-atlas-cc2-', t);
  const root = path.join(dir, 'mem');
  fs.mkdirSync(root);
  const mem = (args, extra = []) => spawnSync(process.execPath, [...extra, path.join(REPO, 'bin', 'mem'), '--root', root, ...args], { encoding: 'utf8', input: '' });
  assert.equal(mem(['init']).status, 0);
  const workers = (args) => {
    const out = path.join(dir, `w-${args.join('')}.txt`);
    fs.writeFileSync(out, '');
    mem(args, [`--import=${spec('call-counter.mjs', { root, out }).href}`]);
    return total(readRows(out)).workers;
  };
  assert.equal(workers(['doctor', '--quiet']), 0);
  assert.ok(workers(['doctor', '--quiet', '--full']) >= 2, 'with --full the writers start');
});
