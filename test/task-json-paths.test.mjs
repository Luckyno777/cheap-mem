// SPDX-FileCopyrightText: 2026 Lucky H.
// Fable security run 2026-10-11, ported from lucky-mem (B11/B14): `/task.json?id=` gave the full command of a task, with the
// absolute path of the installation and of the memory root (`/home/<user>/cheap-mem/bin/mem`, `<root>/.mem/tasks/<id>/export`);
// the same for the paths inside a result. Whoever holds the token learned where the server lives and what runs there.
// Now the answer names the root as `<root>` and the code folder as `<code>`; the journal on disk keeps the full command
// (a restart and a bug hunt need it). And `export`, which decompresses the raw captures into a folder, needs a password
// session like the other kinds that write (lucky-mem B11: `export` is `nurMensch`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as tasks from '../src/tasks.mjs';
import { personCookie } from './person-session.mjs';

const { scrubServerPaths } = tasks;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const DOOR = ['probe', 'paths', String(process.pid)].join('-');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-taskpaths-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'tp', participants: ['someone'], language: 'en' }));
  return r;
}
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });
async function ended(root, id) {
  for (const t0 = Date.now(); Date.now() - t0 < 20000;) {
    const b = tasks.read(root, id);
    if (b.result !== undefined || b.cancelled) return b;
    await new Promise((ok) => { setTimeout(ok, 60); });
  }
  return tasks.read(root, id);
}
const slashes = (text) => text.replace(/\\/g, '/');
const absolute = (text, root) => [path.resolve(root), path.resolve(REPO)].filter((p) => text.includes(p));

test('tasks.read: the command, result and reason name <root> and <code>, not the server paths', async () => {
  const r = world();
  try {
    const a = tasks.start(r, 'integrity');
    const done = await ended(r, a.id);
    const text = JSON.stringify(done);
    assert.deepEqual(absolute(text, r), [], `absolute paths left in: ${text.slice(0, 500)}`);
    // The part after the mark keeps the host's own separator (`<code>\\bin\\mem` on Windows): compare it as written with `/`.
    assert.deepEqual(done.command.map(slashes), ['<code>/bin/mem', 'chain', '--json']);
    const b = tasks.start(r, 'export', {}, { user: true });
    const exp = await ended(r, b.id);
    assert.deepEqual(absolute(JSON.stringify(exp), r), []);
    assert.deepEqual(exp.command.slice(0, 4).map(slashes), ['<code>/bin/mem', 'raw', 'export', '--into']);
    assert.match(exp.command[4], /^<root>[\\/]\.mem[\\/]tasks[\\/].+[\\/]export$/);
    // the journal on disk keeps the full command: a restart and a bug hunt need it
    const journal = fs.readFileSync(tasks.statePath(r, b.id), 'utf8');
    assert.ok(journal.includes(path.resolve(r)), 'the state file itself is unchanged');
    // the overview goes through the same reader
    assert.deepEqual(absolute(JSON.stringify(tasks.overview(r)), r), []);
  } finally { gone(r); }
});

test('tasks.start: export needs a password session (it writes decompressed raw captures to a folder)', () => {
  const r = world();
  try {
    assert.equal(tasks.KINDS.export.humanOnly, true);
    assert.throws(() => tasks.start(r, 'export'), (e) => e.code === 'NOT_A_PERSON');
    assert.equal(tasks.KINDS.integrity.humanOnly, undefined, 'the read-only check stays open to the token');
  } finally { gone(r); }
});

test('GET /task.json?id= over the real server carries no absolute path', async () => {
  const r = world();
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(r, { CHEAP_MEM_SERVE_TOKEN: DOOR, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0' }, { allowWrites: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const H = { authorization: `Bearer ${DOOR}`, origin: base, 'content-type': 'application/x-www-form-urlencoded' };
    const refused = await fetch(`${base}/task`, { method: 'POST', headers: H, body: 'kind=export' });
    assert.equal(refused.status, 403, 'export with the token alone is refused');
    const began = await fetch(`${base}/task`, { method: 'POST', headers: { ...H, cookie: `${personCookie(r)}; mem_k=${DOOR}` }, body: 'kind=export' });
    assert.equal(began.status, 201);
    const { id } = await began.json();
    await ended(r, id);
    const got = await fetch(`${base}/task.json?id=${id}`, { headers: H });
    assert.equal(got.status, 200);
    const text = await got.text();
    assert.deepEqual(absolute(text, r), [], text.slice(0, 400));
    assert.match(text, /<code>/);
    const ov = await (await fetch(`${base}/task.json`, { headers: H })).text();
    assert.deepEqual(absolute(ov, r), []);
  } finally { await new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }); gone(r); }
});

// --- review 2026-10-12: a symlinked root, and paths written with the other separator -----------------------------------------

test('tasks.read: a symlinked root (the child reports the real path) and both separators are covered', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-taskpaths-real-'));
  const linkBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-taskpaths-link-'));
  const link = path.join(linkBase, 'root-link');
  try {
    fs.symlinkSync(real, link, 'dir');
  } catch { fs.rmSync(real, { recursive: true, force: true }); fs.rmSync(linkBase, { recursive: true, force: true }); return; } // no symlinks here (Windows without the right)
  try {
    fs.mkdirSync(path.join(real, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(real, '.mem', 'config.json'), JSON.stringify({ name: 'tp', participants: ['someone'], language: 'en' }));
    const realRoot = fs.realpathSync(real);
    const back = (p) => p.replace(/[\\/]/g, '\\');
    const fwd = (p) => p.replace(/[\\/]/g, '/');
    const id = 'symlinktest01';
    const file = tasks.statePath(link, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const code = path.resolve(REPO);
    fs.appendFileSync(file, `${JSON.stringify({
      event: 'started', ts: new Date().toISOString(), id, kind: 'export', pid: 1, serverEpoch: 'other',
      command: [path.join(code, 'bin', 'mem'), 'raw', 'export', '--into', path.join(realRoot, '.mem', 'tasks', id, 'export')],
    })}\n${JSON.stringify({
      event: 'result', ts: new Date().toISOString(), id, state: 'warning',
      result: { into: back(path.join(realRoot, 'x')), also: fwd(path.join(realRoot, 'y')), code: back(path.join(code, 'bin')) },
      reason: `could not write ${path.join(path.resolve(link), 'z')} nor ${back(path.join(realRoot, 'z'))}`,
    })}\n`);
    const text = JSON.stringify(tasks.read(link, id));
    for (const p of [realRoot, path.resolve(link), code]) {
      for (const form of [p, back(p), fwd(p), JSON.stringify(back(p)).slice(1, -1)]) {
        assert.ok(!text.includes(form), `${form} is still in the answer: ${text.slice(0, 600)}`);
      }
    }
    assert.match(text, /<root>/);
    assert.match(text, /<code>/);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(linkBase, { recursive: true, force: true });
  }
});

// --- Windows spellings, proven on every host with path.win32 (CI run 888: the tasks.read test failed on Windows only) ----------------

test('scrubServerPaths: a Windows root and code folder in every spelling the child may report', () => {
  const root = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cm-taskpaths-abc';
  const longRoot = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\cm-taskpaths-abc';
  const code = 'D:\\a\\cheap-mem\\cheap-mem';
  const realpaths = (dir) => (dir === root ? [root, longRoot] : [dir]);
  const folders = [[root, '<root>'], [code, '<code>']];
  const opt = { pathApi: path.win32, realpaths, caseless: true };
  const value = {
    command: [`${code}\\bin\\mem`, 'raw', 'export', '--into', `${root}\\.mem\\tasks\\t1\\export`],
    result: { a: longRoot, b: longRoot.replace(/\\/g, '/'), c: 'd:\\a\\CHEAP-MEM\\cheap-mem\\src', d: root.toLowerCase(), n: 3, nested: [`${longRoot}\\x`] },
    reason: `could not write ${longRoot}\\z and ${code.replace(/\\/g, '/')}/bin`,
  };
  const out = scrubServerPaths(value, folders, opt);
  const text = JSON.stringify(out);
  for (const leak of ['RUNNER~1', 'runneradmin', 'cheap-mem\\\\cheap-mem', 'a/cheap-mem', 'C:', 'D:', 'd:']) {
    assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `${leak} is still in: ${text}`);
  }
  assert.equal(out.command[0], '<code>\\bin\\mem');
  assert.equal(out.command[4], '<root>\\.mem\\tasks\\t1\\export');
  assert.equal(out.result.n, 3, 'a number passes unchanged');
  assert.equal(out.result.c, '<code>\\src');
  // The bare drive root is never a path to swap: that would eat every separator of every path on the drive.
  assert.deepEqual(scrubServerPaths('C:\\keep\\this', [['C:\\', '<x>']], opt), 'C:\\keep\\this');
  // Positive control: with the case-insensitive match off (a POSIX host), the lower-case spelling is NOT swapped, so the
  // case above is what the match is doing.
  assert.equal(scrubServerPaths(root.toLowerCase(), folders, { ...opt, caseless: false }), root.toLowerCase());
});

test('scrubServerPaths: POSIX hosts keep their case-sensitive match', () => {
  const out = scrubServerPaths('/srv/Mem/x and /srv/mem/x', [['/srv/Mem', '<root>']], { pathApi: path.posix, realpaths: () => [], caseless: false });
  assert.equal(out, '<root>/x and /srv/mem/x');
});
