/**
 * The split command table stays whole.
 *
 * **What this is for.** On 2026-09-18 `bin/mem` went from 4503 lines to
 * 223: the sixty command handlers moved into six modules under
 * `src/cli/commands/`, and `bin/mem` dispatched through their merged table
 * (since cli-speed-cm it imports one group per start, by way of
 * `src/cli/command-index.mjs`; test/cli-lazy-groups.test.mjs holds that
 * index). A split like that has
 * exactly two ways to lose something quietly, and neither of them makes
 * a test fail on its own:
 *
 *   1. A command is dropped. Nothing breaks at startup; `mem <name>`
 *      simply answers "Unknown command", and unless a test names that
 *      command, no one finds out.
 *   2. Two groups define the same name. The merge resolves it by import
 *      order, silently, and one handler never runs again. That is worse
 *      than a crash: the losing code stays in the repo, is maintained,
 *      is read as live, and does nothing.
 *
 * The merge in `bin/mem` throws on the second. This file guards the
 * first, and checks that the guard against the second actually fires.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['write', 'search', 'capture', 'agents', 'setup', 'admin'];

async function tables() {
  const out = {};
  for (const g of GROUPS) {
    // As a file URL, not as a path. An ESM specifier is a URL, and on
    // Windows `D:\a\cheap-mem\src\cli\commands\write.mjs` is not one:
    // Node reads the drive letter as a scheme and refuses with
    // ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'd:'").
    // Measured on the windows-latest runner on 2026-09-19 (run 230):
    // all three tests in this file were red there, and only there.
    //
    // test/concurrent-append.test.mjs hit the identical thing on the
    // 2026-09-16 Windows runner and wrote it into its own comment. The
    // lesson stayed in that one file; test/windows-paths.test.mjs now
    // holds it for the whole tree.
    const m = await import(pathToFileURL(
      path.join(REPO, 'src/cli/commands', `${g}.mjs`)).href);
    out[g] = Object.keys(m.COMMANDS);
  }
  return out;
}

test('POSITIVE: every group module exports commands', async () => {
  // A guard that reads empty tables passes forever. This is the vacuity
  // check, and it is first on purpose.
  const t = await tables();
  for (const g of GROUPS) {
    assert.ok(t[g].length >= 3, `${g}.mjs exports only ${t[g].length} commands — did the import break?`);
  }
});

test('no command name is claimed by two groups', async () => {
  const t = await tables();
  const seen = new Map();
  const clashes = [];
  for (const g of GROUPS) {
    for (const name of t[g]) {
      if (seen.has(name)) clashes.push(`${name}: ${seen.get(name)} and ${g}`);
      seen.set(name, g);
    }
  }
  assert.deepEqual(clashes, [], `\n${clashes.join('\n')}\n`);
});

test('the sixty commands the CLI had before the split are all still there', async () => {
  // The list is written out, not derived. A count would pass while two
  // commands swapped places with two new ones; a derived list would
  // agree with whatever the code happens to say today, which is the
  // thing under test.
  const EXPECTED = [
    'onboarding', 'sources', 'component', 'broadcast', 'questions', 'answer',
    'procedures', 'guard', 'heartbeat', 'init', 'whoami', 'inbox', 'log',
    'find', 'discard', 'done', 'when', 'show', 'raw-capture', 'status',
    'serve', 'board', 'classes', 'bridge', 'raw', 'digest', 'duties',
    'thesaurus', 'embed', 'find-embed', 'find-hybrid', 'hooks', 'retrieve',
    'explain', 'epoch', 'gauges', 'shrink', 'observations', 'maintenance',
    'paths', 'net', 'teach', 'doctor', 'context', 'facts', 'browse', 'setup',
    'experiences', 'links', 'agents', 'agent', 'store', 'topic-merge',
    'topics', 'topic', 'core', 'viewer', 'project', 'correction', 'version',
  ];
  const t = await tables();
  const da = new Set(GROUPS.flatMap((g) => t[g]));
  const missing = EXPECTED.filter((n) => !da.has(n));
  assert.deepEqual(missing, [], `lost in the split: ${missing.join(', ')}`);
  assert.equal(EXPECTED.length, 60);
});

test('every command the CLI offers is reachable through the real program', () => {
  // Not through the modules — through the real program, so a broken
  // dispatch or a bad import path is caught here and not only at runtime.
  const help = execFileSync('node', [path.join(REPO, 'bin/mem')], { encoding: 'utf8' });
  assert.match(help, /cheap-mem CLI/);
  // `log` and `find` are the two the whole thing exists for. If the help
  // text stops naming them, something is very wrong.
  for (const n of ['log', 'find', 'doctor', 'inbox']) {
    assert.match(help, new RegExp(`\\b${n}\\b`), `help text no longer mentions '${n}'`);
  }
});

test('SABOTAGE: a duplicate name across two groups is refused, not resolved', async () => {
  // Since cli-speed-cm (TB4) `bin/mem` no longer merges the six tables, it
  // imports one group per start. The refusal sits where the names are all
  // still seen at once: `indexGroups` in src/cli/command-index.mjs, which
  // runs when that module loads. If it resolved by order, the first
  // definition would be dead code that still looks live. This calls the
  // REAL function with a clash.
  const idx = await import(pathToFileURL(path.join(REPO, 'src/cli/command-index.mjs')).href);
  const two = { a: ['doppelt', 'x'], b: ['doppelt'] };
  assert.throws(() => idx.indexGroups(two), /two groups define `mem doppelt`/);
  // Control: the same function accepts a clean table, so the throw above is
  // the clash and not a function that throws on everything.
  assert.equal(idx.indexGroups({ a: ['x'], b: ['y'] }).y, 'b');
  // And bin/mem must still go through the index, not around it.
  const srcText = fs.readFileSync(path.join(REPO, 'bin/mem'), 'utf8');
  assert.match(srcText, /groupOf\(head\)/, 'bin/mem no longer asks the command index');
});

test('bin/mem stays small enough to be read in one sitting', () => {
  // The whole reason for the split. Without a number here, the file
  // grows back one convenient handler at a time, and the next person to
  // notice is the one who cannot find anything in it.
  const lines = fs.readFileSync(path.join(REPO, 'bin/mem'), 'utf8').split('\n').length;
  assert.ok(lines < 400,
    `bin/mem is ${lines} lines. It was 4503 before the split and 223 after; `
    + 'if a handler landed back in here, move it to its group.');
});

test('every lazy import inside a command handler resolves', () => {
  // **The defect this exists for, made on the day of the split.** Ten
  // handlers pull a module in lazily — `await import('../src/net.mjs')`
  // and friends. Those paths were relative to `bin/`; after the move
  // they had to be relative to `src/cli/commands/`. The rewrite only
  // touched top-level imports, so all ten pointed at a directory that
  // does not exist.
  //
  // The suite caught TWO of the ten, because two of them happen to sit
  // on a tested path. The other eight would have thrown at runtime, in
  // front of whoever ran that command, and nothing here would have gone
  // red. A static import fails loudly at load; a lazy one waits until
  // someone needs it — which is exactly when you least want to find out.
  const files = fs.readdirSync(path.join(REPO, 'src/cli/commands'))
    .filter((f) => f.endsWith('.mjs'));
  const broken = [];
  let seen = 0;
  for (const file of files) {
    const whole = path.join(REPO, 'src/cli/commands', file);
    const srcText = fs.readFileSync(whole, 'utf8');
    for (const m of srcText.matchAll(/await import\('([^']+)'\)/g)) {
      const target = m[1];
      if (!target.startsWith('.')) continue;   // a package, not one of our paths
      seen += 1;
      const resolved = path.resolve(path.dirname(whole), target);
      if (!fs.existsSync(resolved)) broken.push(`${file}: ${target}`);
    }
  }
  // POSITIVE: a probe that finds no lazy imports at all passes forever.
  assert.ok(seen >= 8,
    `only ${seen} lazy imports found across the groups — the probe stopped matching them`);
  assert.deepEqual(broken, [], `\n${broken.join('\n')}\n`);
});
