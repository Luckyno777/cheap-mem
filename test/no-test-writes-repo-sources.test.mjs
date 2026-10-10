// No test may write to this repo's own sources (bin/, src/, hooks/).
//
// **Why.** `node --test` runs test FILES in parallel, and most of them
// spawn `bin/mem` or `bin/mem-mcp` from this checkout. A test that
// patches a live source, even for a second and even restoring it in a
// `finally`, opens a window in which every other `mem` process started
// from the same checkout imports an empty, half-written or sabotaged
// module. Measured 2026-09-27: rewriting src/cli/commands/search.mjs in
// a loop (identical bytes, exactly what a restore does) made 117 of 177
// concurrent `mem log --project alpha` runs die with `SyntaxError:
// Unexpected end of input`. test/p13-lattice-wiring.test.mjs did this
// six times per run, and the full suite went red elsewhere with "alpha
// lost its own entry 0". A crash inside the window also leaves the
// sabotage on disk for the next agent sharing the clone. The fix is a
// throwaway copy of the package in a temp directory; this probe keeps
// every test file on that side of the line.
//
// **How it decides.** A static read of each test file, no execution:
//   1. repo-root names: a binding initialised from `import.meta.url`
//      and `..` (the usual `const REPO = path.join(path.dirname(
//      fileURLToPath(import.meta.url)), '..')`);
//   2. repo-source names: a `const X = path.join(<root>, 'bin' | 'src' |
//      'hooks', ...)` at any indentation (a name made inside a test body
//      counts: that is how the live-tree writers of 2026-10-09 slipped
//      through), and anything joined onto one;
//   3. writers: the fs calls that change a file (write, append, remove,
//      rename, truncate, copy/symlink onto it), plus any function in the
//      same file that passes its own parameter to one of those (that is
//      how `withSabotage(filePath, ...)` is caught), transitively;
//   4. a violation is a writer called with a repo-source path (a name
//      from 2, or an inline `path.join(<root>, 'src', ...)`) in the
//      argument the writer writes to.
//
// **What it deliberately does not catch:** a path assembled from a
// loop variable or a string built elsewhere, and writes from a spawned
// helper script. It is a floor, not a proof; the positive control below
// keeps the floor from quietly sinking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_DIRS = ['bin', 'src', 'hooks'];

// fs method -> index of the argument it writes to (several for rename).
const FS_WRITERS = {
  writeFileSync: [0], appendFileSync: [0], writeFile: [0], appendFile: [0],
  rmSync: [0], rm: [0], unlinkSync: [0], unlink: [0], truncateSync: [0], truncate: [0],
  rmdirSync: [0], mkdirSync: [0], openSync: [], createWriteStream: [0],
  renameSync: [0, 1], rename: [0, 1],
  copyFileSync: [1], copyFile: [1], cpSync: [1], cp: [1],
  symlinkSync: [1], symlink: [1], linkSync: [1], link: [1],
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split the argument list that starts right after `open` (the index of '('). */
function splitArgs(text, open) {
  const args = [];
  let depth = 0; let start = open + 1; let quote = null;
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { args.push(text.slice(start, i).trim()); return args; }
      depth -= 1;
    } else if (c === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  return args;
}

/** Every `name(` call site in `text`, with its split arguments. */
function calls(text, name) {
  const out = [];
  const re = new RegExp(`(?<![\\w$])${escape(name)}\\s*\\(`, 'g');
  for (const m of text.matchAll(re)) {
    // Skip the definition itself: `function name(`.
    if (/function\s*$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    out.push({ index: m.index, args: splitArgs(text, m.index + m[0].length - 1) });
  }
  return out;
}

/**
 * Scan one test file's text; returns a list of human-readable
 * violations, empty when the file never writes to a repo source.
 */
function scan(text) {
  const roots = [...text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*import\.meta\.url[^;]*)/g)]
    .filter((m) => /'\.\.'|"\.\."|'\.\.\/|"\.\.\//.test(m[2]))
    .map((m) => m[1]);
  if (!roots.length) return [];
  const rootAlt = roots.map(escape).join('|');
  const dirAlt = SOURCE_DIRS.join('|');
  const inline = `path\\.(?:join|resolve)\\(\\s*(?:${rootAlt})\\s*,\\s*['"](?:${dirAlt})['"/]`;

  // Repo-source names, to a fixpoint (a name joined onto a source name is one too).
  const srcNames = new Set();
  for (let grew = true; grew;) {
    grew = false;
    const named = [...srcNames].map(escape).join('|');
    const re = new RegExp(`^[ \\t]*(?:export\\s+)?const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${inline}|path\\.(?:join|resolve)\\(\\s*(?:${named || '(?!)'})\\s*[,)])`, 'gm');
    for (const m of text.matchAll(re)) {
      if (!srcNames.has(m[1])) { srcNames.add(m[1]); grew = true; }
    }
  }
  const named = [...srcNames].map(escape).join('|');
  const isRepoSource = new RegExp(`^(?:${inline}|(?:${named || '(?!)'})(?![\\w$]))`);

  // Writers: fs methods, then local functions that hand a parameter to a writer.
  const writers = new Map(Object.entries(FS_WRITERS).map(([k, v]) => [`fs.${k}`, v]));
  for (let grew = true; grew;) {
    grew = false;
    for (const m of text.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
      if (writers.has(m[1])) continue;
      const params = m[2].split(',').map((p) => p.trim().replace(/\s*=.*$/, ''));
      const bodyStart = m.index + m[0].length;
      const bodyEnd = text.indexOf('\n}', bodyStart);
      const body = text.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
      const written = new Set();
      for (const [w, idxs] of writers) {
        for (const c of calls(body, w)) {
          for (const i of idxs) {
            const p = params.indexOf(c.args[i]);
            if (p !== -1) written.add(p);
          }
        }
      }
      if (written.size) { writers.set(m[1], [...written]); grew = true; }
    }
  }

  const found = [];
  for (const [w, idxs] of writers) {
    for (const c of calls(text, w)) {
      for (const i of idxs) {
        if (c.args[i] !== undefined && isRepoSource.test(c.args[i])) {
          const line = text.slice(0, c.index).split('\n').length;
          found.push(`line ${line}: ${w}(...) writes to repo source \`${c.args[i].replace(/\s+/g, ' ')}\``);
        }
      }
    }
  }
  return found;
}

test('positive control: the scanner flags the pre-2026-09-27 P13 shape (withSabotage on a live source)', () => {
  const sample = [
    "const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "const CLI_SEARCH_FILE = path.join(REPO, 'src', 'cli', 'commands', 'search.mjs');",
    'function withSabotage(filePath, transform, fn) {',
    "  const original = fs.readFileSync(filePath, 'utf8');",
    '  fs.writeFileSync(filePath, transform(original));',
    '  try { return fn(); } finally { fs.writeFileSync(filePath, original); }',
    '}',
    "withSabotage(CLI_SEARCH_FILE, (s) => s.replace('a', 'b'), () => 1);",
    "fs.appendFileSync(path.join(REPO, 'bin', 'mem'), '// x');",
    "fs.copyFileSync('/tmp/x', path.join(REPO, 'hooks', 'pre-commit'));",
  ].join('\n');
  const found = scan(sample);
  assert.equal(found.length, 3, `expected 3 violations, got ${found.length}: ${found.join('; ')}`);
  assert.ok(found.some((f) => f.includes('withSabotage') && f.includes('CLI_SEARCH_FILE')), found.join('; '));
});

test('positive control: a repo-source name made INSIDE a test body is caught (the 2026-10-09 shape)', () => {
  const sample = [
    "const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "test('x', async () => {",
    "  const tmpScript = path.join(REPO, 'bin', `.old-mem-serve-${process.pid}.mjs`);",
    "  fs.writeFileSync(tmpScript, 'x');",
    "  const baseline = path.join(REPO, 'src', `__baseline_${process.pid}.mjs`);",
    "  fs.writeFileSync(baseline, 'y');",
    '});',
  ].join('\n');
  assert.equal(scan(sample).length, 2, scan(sample).join('; '));
});

test('negative control: reading a repo source, copying FROM it, or patching a temp copy is not a violation', () => {
  const sample = [
    "const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "const MEM = path.join(REPO, 'bin', 'mem');",
    "const PKG = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));",
    "const COPY = path.join(PKG, 'src', 'search.mjs');",
    'function withSabotage(filePath, t, fn) { fs.writeFileSync(filePath, t(fs.readFileSync(filePath))); return fn(); }',
    "fs.readFileSync(MEM, 'utf8');",
    "fs.copyFileSync(MEM, path.join(PKG, 'bin', 'mem'));",
    "fs.cpSync(path.join(REPO, 'src'), path.join(PKG, 'src'), { recursive: true });",
    'withSabotage(COPY, (s) => s, () => 1);',
    "spawnSync('node', [MEM, 'init']);",
  ].join('\n');
  assert.deepEqual(scan(sample), []);
});

test('no test file writes to this repo\'s own bin/, src/ or hooks/', () => {
  // This file itself is skipped: its controls above hold violating code
  // as string DATA on purpose, and a static read cannot tell data from code.
  const self = path.basename(fileURLToPath(import.meta.url));
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs') && f !== self);
  assert.ok(files.length > 100, `expected the whole test directory, saw ${files.length} files`);
  const offenders = [];
  for (const f of files) {
    for (const v of scan(fs.readFileSync(path.join(HERE, f), 'utf8'))) offenders.push(`test/${f} ${v}`);
  }
  assert.deepEqual(offenders, [],
    'a test patches a live source; copy the package to a temp directory and patch the copy '
    + '(see test/p13-lattice-wiring.test.mjs, makePackageCopy)');
});
