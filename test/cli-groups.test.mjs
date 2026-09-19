/**
 * The split command table stays whole.
 *
 * **What this is for.** On 2026-09-18 `bin/mem` went from 4503 lines to
 * 223: the sixty command handlers moved into six modules under
 * `src/cli/commands/`, and `bin/mem` merges them. A split like that has
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
  const ERWARTET = [
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
  const fehlt = ERWARTET.filter((n) => !da.has(n));
  assert.deepEqual(fehlt, [], `lost in the split: ${fehlt.join(', ')}`);
  assert.equal(ERWARTET.length, 60);
});

test('every command the CLI offers is reachable through the merge', () => {
  // Not through the modules — through the real program, so a broken
  // merge or a bad import path is caught here and not only at runtime.
  const hilfe = execFileSync('node', [path.join(REPO, 'bin/mem')], { encoding: 'utf8' });
  assert.match(hilfe, /cheap-mem CLI/);
  // `log` and `find` are the two the whole thing exists for. If the help
  // text stops naming them, something is very wrong.
  for (const n of ['log', 'find', 'doctor', 'inbox']) {
    assert.match(hilfe, new RegExp(`\\b${n}\\b`), `help text no longer mentions '${n}'`);
  }
});

test('SABOTAGE: a duplicate name across two groups is refused, not resolved', () => {
  // The merge throws. If it did not, the second definition would win by
  // import order and the first would be dead code that still looks live.
  const zwei = { a: { doppelt: 1, x: 2 }, b: { doppelt: 3 } };
  const merge = () => {
    const raus = {};
    for (const [gruppe, tabelle] of Object.entries(zwei)) {
      for (const [name, h] of Object.entries(tabelle)) {
        if (name in raus) throw new Error(`two groups define \`mem ${name}\`: ${gruppe} and one before it`);
        raus[name] = h;
      }
    }
    return raus;
  };
  assert.throws(merge, /two groups define/);
  // And the real merge in bin/mem must be the same shape — if someone
  // replaces it with a spread, this test still passes while the
  // guarantee is gone. So check the source says so.
  const quelle = fs.readFileSync(path.join(REPO, 'bin/mem'), 'utf8');
  assert.match(quelle, /if \(name in COMMANDS\)/,
    'bin/mem no longer refuses duplicates — a spread merge would silently drop one');
});

test('bin/mem stays small enough to be read in one sitting', () => {
  // The whole reason for the split. Without a number here, the file
  // grows back one convenient handler at a time, and the next person to
  // notice is the one who cannot find anything in it.
  const zeilen = fs.readFileSync(path.join(REPO, 'bin/mem'), 'utf8').split('\n').length;
  assert.ok(zeilen < 400,
    `bin/mem is ${zeilen} lines. It was 4503 before the split and 223 after; `
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
  const dateien = fs.readdirSync(path.join(REPO, 'src/cli/commands'))
    .filter((f) => f.endsWith('.mjs'));
  const kaputt = [];
  let gesehen = 0;
  for (const datei of dateien) {
    const voll = path.join(REPO, 'src/cli/commands', datei);
    const quelle = fs.readFileSync(voll, 'utf8');
    for (const m of quelle.matchAll(/await import\('([^']+)'\)/g)) {
      const ziel = m[1];
      if (!ziel.startsWith('.')) continue;   // ein Paket, nicht unser Pfad
      gesehen += 1;
      const aufgeloest = path.resolve(path.dirname(voll), ziel);
      if (!fs.existsSync(aufgeloest)) kaputt.push(`${datei}: ${ziel}`);
    }
  }
  // POSITIVE: a probe that finds no lazy imports at all passes forever.
  assert.ok(gesehen >= 8,
    `only ${gesehen} lazy imports found across the groups — the probe stopped matching them`);
  assert.deepEqual(kaputt, [], `\n${kaputt.join('\n')}\n`);
});
