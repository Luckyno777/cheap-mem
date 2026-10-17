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
// The ratchet below holds every entry point in bin/ and src/ to the shared test: no second inline comparison of
// argv[1] with import.meta.url. Red proof: both probes fail on 9a10bf6 (the CHANGELOG entry of CI run 1103 names it).
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

test('ratchet: no entry point in bin/ or src/ compares argv[1] with import.meta.url itself (src/ismain.mjs does)', () => {
  const files = [];
  for (const d of ['bin', 'src']) {
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(mjs|js|cjs)$/.test(e.name) || (d === 'bin' && !e.name.includes('.'))) files.push(f);
      }
    };
    walk(path.join(REPO, d));
  }
  const offenders = [];
  for (const f of files) {
    if (path.basename(f) === 'ismain.mjs') continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (/^\s*(\/\/|\*|#)/.test(l)) return;
      if (/argv\s*\[\s*1\s*\]|\bargv1\b/.test(l) && /import\.meta\.url|metaUrl/.test(l)) offenders.push(`${path.relative(REPO, f).split(path.sep).join('/')}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.ok(files.length > 50, `the walk found ${files.length} files: it looks in the wrong place`);
  assert.deepEqual(offenders, [], 'an inline entry-point test is false under a symlinked parent; use isMain from src/ismain.mjs');
});
