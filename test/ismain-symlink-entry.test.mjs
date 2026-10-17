// test/ismain-symlink-entry.test.mjs - an entry point started through a symlinked directory still runs (CI run 1103).
//
// **The finding.** `node <dir>/bin/mem-headless.mjs plan ...` printed nothing, exit 0, whenever a directory above the
// file was a symlink: `import.meta.url` is the REAL path, `process.argv[1]` the path as typed, and src/headless.mjs
// compared the two as text. On macOS every temp dir is such a path (/var -> /private/var): the digest, the mail handler
// and the reflector read "no plan" and refused to start (`REFUSED - no safe way to start the model session`), so no
// unattended model session ever ran from a copy of the tool under a symlinked path. bin/mem-mask-copy.mjs carried the
// same comparison: no masked copy, and the reflector starts no model without one. src/ismain.mjs (2189b47) already held
// the right test - both sides as real paths - for eight entry points; these two had a copy of the old one.
//
// Measure:          output of the two entry points started through a symlink (a junction on Windows) to this checkout.
// Starting value:   nothing printed, exit 0 (base 9a10bf6; reproduced on Linux with a symlinked directory).
// Expected change:  the plan lines / the path of the masked copy, exactly as through the real path.
// Abort criterion:  an entry point that is silent through the link.
//
// The ratchet below holds every entry point in bin/ and src/ to the shared test (per file: argv[1] plus its own path
// means isMain). Red proof: both probes fail on 9a10bf6 (the CHANGELOG entry of CI run 1103 names it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A scratch folder holding `link` -> this checkout (a junction on Windows: no privilege needed) and a memory. */
function linked() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ismain-'));
  made.push(dir);
  const link = path.join(dir, 'link');
  fs.symlinkSync(REPO, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(fs.realpathSync(link), link, 'fixture: the link resolves elsewhere, else this probe measures nothing');
  const root = path.join(dir, 'mem');
  fs.mkdirSync(root);
  return { dir, link, root };
}

test('bin/mem-headless.mjs started through a symlinked directory prints its plan (as through the real path)', () => {
  const { dir, link, root } = linked();
  const env = { ...process.env, MEM_HEADLESS_CWD: path.join(dir, 'neutral') };
  const run = (base) => spawnSync(process.execPath, [path.join(base, 'bin', 'mem-headless.mjs'), 'plan', '--cmd', 'claude -p', '--root', root],
    { encoding: 'utf8', env });
  const direct = run(REPO);
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /^isolated=1\n/, 'positive control: the real path prints the plan');
  const through = run(link);
  assert.equal(through.status, 0, through.stderr);
  assert.equal(through.stdout, direct.stdout, 'through the link the starter said nothing: every unattended job refuses to start');
});

test('bin/mem-mask-copy.mjs started through a symlinked directory makes the masked copy (as through the real path)', () => {
  const { dir, link } = linked();
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ role: 'user', text: 'hello' })}\n`);
  const r = spawnSync(process.execPath, [path.join(link, 'bin', 'mem-mask-copy.mjs'), transcript], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const copy = r.stdout.trim();
  assert.ok(copy && fs.existsSync(copy), `no masked copy through the link (stdout ${JSON.stringify(r.stdout)}): the reflector starts no model`);
  assert.equal(spawnSync(process.execPath, [path.join(link, 'bin', 'mem-mask-copy.mjs'), '--clean', copy], { encoding: 'utf8' }).status, 0);
  assert.equal(fs.existsSync(copy), false, 'and --clean through the link removes it');
});

// The rule is per FILE, not per line: a test split over two lines, `import.meta.url.endsWith(entry)` and
// `import.meta.filename` all escaped a line-by-line search. A file in bin/ or src/ that reads `process.argv[1]` and
// `import.meta.url` or `import.meta.filename` must call `isMain(`; src/ismain.mjs is the one place that may compare.
const EXCEPTIONS = {
  // A `node -e` child script: argv[1] there is the memory root handed to buildTimeTracks, not the program's own path,
  // and import.meta.url only locates the module directory. No "am I the program" test is made.
  'src/timetrack.mjs': 'node -e child script: argv[1] is a data argument, not an entry-point test',
};
function sourceFiles(base) {
  const files = [];
  for (const d of ['bin', 'src']) {
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(mjs|js|cjs)$/.test(e.name) || (d === 'bin' && !e.name.includes('.'))) files.push(f);
      }
    };
    if (fs.existsSync(path.join(base, d))) walk(path.join(base, d));
  }
  return files;
}
function offenders(base) {
  const out = [];
  for (const f of sourceFiles(base)) {
    const rel = path.relative(base, f).split(path.sep).join('/');
    if (rel === 'src/ismain.mjs' || EXCEPTIONS[rel]) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (/process\.argv\s*\[\s*1\s*\]/.test(text) && /import\.meta\.(url|filename)/.test(text) && !/\bisMain\(/.test(text)) out.push(rel);
  }
  return out;
}

test('ratchet: a file in bin/ or src/ that reads argv[1] and its own path calls isMain (src/ismain.mjs decides)', () => {
  assert.ok(sourceFiles(REPO).length > 50, 'the walk found too few files: it looks in the wrong place');
  assert.deepEqual(offenders(REPO), [], 'an own entry-point test is false under a symlinked parent; use isMain from src/ismain.mjs');
  for (const [rel, why] of Object.entries(EXCEPTIONS)) {
    assert.ok(fs.existsSync(path.join(REPO, rel)) && why.length > 20, `exception ${rel}: the file is gone or the reason is empty - drop the entry`);
  }
});

test('POSITIVE CONTROL: the ratchet sees the two-line test, endsWith and import.meta.filename (scratch tree)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ismain-rat-'));
  made.push(base);
  fs.mkdirSync(path.join(base, 'src'));
  fs.mkdirSync(path.join(base, 'bin'));
  const put = (rel, text) => fs.writeFileSync(path.join(base, rel), text);
  put('src/twoline.mjs', "const direct = process.argv[1]\n  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);\n");
  put('src/endswith.mjs', 'const entry = process.argv[1];\nif (import.meta.url.endsWith(entry)) main();\n');
  put('bin/filename', '#!/usr/bin/env node\nif (process.argv[1] === import.meta.filename) main();\n');
  put('src/good.mjs', "import { isMain } from './ismain.mjs';\nif (isMain(import.meta.url)) main(process.argv[1]);\n");
  put('src/ismain.mjs', 'export const isMain = (u, a = process.argv[1]) => a === import.meta.url;\n');
  assert.deepEqual(offenders(base).sort(), ['bin/filename', 'src/endswith.mjs', 'src/twoline.mjs']);
});
