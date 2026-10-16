// hooks-harden-cm / R6 (lucky-mem e146b45ce, c0b14705c): the hook shells set NODE_COMPILE_CACHE, so every new
// node start finds the translated code of src/*.mjs again instead of compiling it from scratch.
//
// Where it differs from the sibling house: the cache lives in the USER's cache directory, never in the memory
// (a git repository that travels between machines):
//   Linux ${XDG_CACHE_HOME:-$HOME/.cache}/cheap-mem/node-cc, macOS $HOME/Library/Caches/..., Git Bash $LOCALAPPDATA/...
// A value the user set stays. A directory that cannot be made means no cache, never a silent hook. Node 20 does
// not know the variable: the hook then runs cleanly without a cache (the probes below say which half ran).
//
// RED PROOF: the old before-edit hook (test/fixture/before-edit-v1) leaves no cache directory behind; POSITIVE
// CONTROL: the current one does; MUTATION: the current one with its call removed leaves none either.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './temp-dir.mjs';
import { waitForRebuildIdle } from '../src/component-table.mjs';
import * as memory from '../src/memory.mjs';
import { REPO, OLD_HOOK_TEXT, toolDir } from './fixture/before-edit-old.mjs';

const MEM = path.join(REPO, 'bin', 'mem');
const PORTABLE = path.join(REPO, 'bin', '_portable.sh');

// Can the `node` the hook shells start (PATH, not process.execPath) keep a compile cache? Node >= 22.1.
const nodeP = (expr) => spawnSync('node', ['-p', expr], { encoding: 'utf8', timeout: 30000 });
const CAN = nodeP('typeof require("node:module").enableCompileCache === "function" ? "yes" : "no"').stdout.trim() === 'yes';
const VERSION = nodeP('process.versions.node').stdout.trim().split('.').map(Number);
const FROM_22_1 = VERSION[0] > 22 || (VERSION[0] === 22 && VERSION[1] >= 1);

/** Shell source without comment lines and without trailing `#` comments - what actually runs. */
const code = (text) => text.split('\n').filter((l) => !/^\s*(#|RUN_MEM=)/.test(l)).map((l) => l.replace(/\s#\s.*$/, '')).join('\n');

function world(t) {
  const root = tempDir('cm-cc-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  memory.logEntry(root, 'error', { class: 'unquoted-path', title: 'install/claude-code.sh does not quote the bash path', text: 'install/claude-code.sh breaks on a space' });
  return root;
}
/** A HOME in the scratch - with a space in it on purpose (D5), no XDG, no inherited cache. */
function home(t) {
  const h = path.join(tempDir('cm-cc-h-', t), 'home with space');
  fs.mkdirSync(h);
  return h;
}
function run(hookPath, root, h, extra = {}, input = null, session = `s-cc-${Math.random().toString(36).slice(2)}`) {
  const env = { ...process.env, CHEAP_MEM_ROOT: root, HOME: h, USERPROFILE: h, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '', ...extra };
  for (const k of ['NODE_COMPILE_CACHE', 'XDG_CACHE_HOME', 'LOCALAPPDATA']) if (!(k in extra)) delete env[k];
  // Git Bash reports MINGW*: its cache lives under LOCALAPPDATA, so there the scratch home gets one of its own
  // (deleting it would leave the hook no base at all - and the test nothing to look at).
  if (process.platform === 'win32' && !('LOCALAPPDATA' in extra)) env.LOCALAPPDATA = cacheBase(h);
  const r = spawnSync('bash', [hookPath], {
    input: input ?? JSON.stringify({ session_id: session, tool_name: 'Edit', tool_input: { file_path: '/p/install/claude-code.sh' } }),
    encoding: 'utf8', timeout: 60000, env,
  });
  waitForRebuildIdle(root);
  return r;
}
/** Where the hook shells put their cache base for a scratch HOME: Linux/macOS-style `.cache`, Git Bash on Windows LOCALAPPDATA. */
const cacheBase = (h) => (process.platform === 'win32' ? path.join(h, 'AppData', 'Local') : path.join(h, '.cache'));
const ccDir = (h) => path.join(cacheBase(h), 'cheap-mem', 'node-cc');
const nothingInMemory = (root) => {
  assert.equal(fs.existsSync(path.join(root, '.pipeline', 'node-cc')), false, 'a cache directory appeared in the memory');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  assert.deepEqual(walk(root).filter((f) => /node-cc|compile/i.test(f)), [], 'compile-cache files inside the memory');
};

test('the capability probe agrees with the runtime version (else it would switch the effect probes off silently)', () => {
  assert.match(VERSION.join('.'), /^\d+\.\d+\.\d+/);
  assert.equal(CAN, FROM_22_1, `node ${VERSION.join('.')}: capability ${CAN}, expected ${FROM_22_1}`);
});

test('every bash hook calls mem_compile_cache after sourcing _portable.sh and before its first node', () => {
  const hooks = ['mem-before-edit', 'mem-retrieve', 'mem-after-failure', 'mem-catch-fail', 'mem-subagent-start', 'mem-stop'];
  for (const h of hooks) {
    const src = code(fs.readFileSync(path.join(REPO, 'bin', h), 'utf8'));
    const call = src.search(/^\s*mem_compile_cache\s*$/m);
    assert.ok(call > 0, `${h}: no mem_compile_cache call in the code (a comment does not count)`);
    const sourced = src.search(/\. "\$[A-Z_]+\/_portable\.sh"/);
    assert.ok(sourced > 0 && sourced < call, `${h}: the call stands before _portable.sh is sourced`);
    const firstNode = src.search(/\bnode\b\s+("|-e|\$|\[)|\(node |capped\s+\S+\s+node\b/);
    assert.ok(firstNode > call, `${h}: the first node (${firstNode}) comes before the cache call (${call})`);
  }
  // POSITIVE CONTROL of the reader: a call that is only a comment is not seen.
  assert.equal(code('# mem_compile_cache\nx=1\n').includes('mem_compile_cache'), false);
});

test('every PowerShell twin sets it before its first node, under the user cache', () => {
  for (const h of ['mem-before-edit', 'mem-retrieve', 'mem-after-failure', 'mem-catch-fail', 'mem-subagent-start', 'mem-stop']) {
    const src = fs.readFileSync(path.join(REPO, 'bin', `${h}.ps1`), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const set = src.indexOf('$env:NODE_COMPILE_CACHE = $CcDir');
    assert.ok(set > 0, `${h}.ps1 does not set the cache`);
    assert.match(src, /if \(-not \$env:NODE_COMPILE_CACHE\)/, `${h}.ps1 would overwrite a user value`);
    assert.match(src, /cheap-mem['"]\) 'node-cc'/, `${h}.ps1: not under cheap-mem/node-cc`);
    assert.match(src, /LOCALAPPDATA/, `${h}.ps1: no Windows cache base`);
    assert.doesNotMatch(src.slice(0, set), /& node/, `${h}.ps1: node runs before the cache is set`);
    assert.doesNotMatch(src.slice(0, set), /\.pipeline/, `${h}.ps1: the cache must not live in the memory`);
  }
});

test('RED PROOF: the old hook leaves no cache behind; the current one fills the user cache (Node < 22.1: runs cleanly, nothing half-written)', (t) => {
  const root = world(t);
  const oldHook = toolDir(t, fs.readFileSync(OLD_HOOK_TEXT, 'utf8'));
  const h0 = home(t);
  const r0 = run(oldHook, root, h0);
  assert.equal(r0.status, 0, r0.stderr);
  assert.equal(fs.existsSync(cacheBase(h0)), false, 'the old hook already made a cache directory - the red proof no longer holds');

  const hook = toolDir(t, fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8'), { core: true });
  const h1 = home(t);
  const r1 = run(hook, root, h1);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /memory knows/, 'the hook must still answer');
  assert.ok(fs.statSync(ccDir(h1), { throwIfNoEntry: false })?.isDirectory(), 'no cache directory under <cache base>/cheap-mem/node-cc');
  if (CAN) assert.ok(fs.readdirSync(ccDir(h1)).length > 0, 'node wrote nothing into the cache');
  else {
    assert.doesNotMatch(r1.stderr, /node:internal|Error|ERR_|compile cache/i, r1.stderr);
    assert.deepEqual(fs.readdirSync(ccDir(h1)), [], 'Node < 22.1 knows no cache: nothing half-written may lie there');
  }
  nothingInMemory(root);
});

test('MUTATION: the hook without its call leaves no cache directory', (t) => {
  const root = world(t);
  const text = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  assert.equal(text.split(/^mem_compile_cache .*$/m).length, 2, 'the line the mutation removes moved');
  const hook = toolDir(t, text.replace(/^mem_compile_cache .*$/m, ''), { core: true });
  const h = home(t);
  const r = run(hook, root, h);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(cacheBase(h)), false, 'without the call a cache directory appeared anyway');
});

test('a value the user set stays, and our directory is not made then', (t) => {
  const root = world(t);
  const own = tempDir('cm-cc-own-', t);
  const h = home(t);
  const r = run(path.join(REPO, 'bin', 'mem-before-edit'), root, h, { NODE_COMPILE_CACHE: own });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(cacheBase(h)), false, 'a user value was overridden (our directory was made)');
  if (CAN) assert.ok(fs.readdirSync(own).length > 0, 'node should have written into the user directory');
  else assert.deepEqual(fs.readdirSync(own), []);
});

test('a directory that cannot be made: the hook answers all the same', (t) => {
  const root = world(t);
  const h = home(t);
  fs.mkdirSync(path.dirname(cacheBase(h)), { recursive: true });
  fs.writeFileSync(cacheBase(h), 'a file where a directory has to be');
  const r = run(path.join(REPO, 'bin', 'mem-before-edit'), root, h);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /memory knows/, 'the hook fell silent over a cache');
  assert.doesNotMatch(r.stderr, /compile cache|NODE_COMPILE_CACHE/i);
});

test('mem_compile_cache by platform: Linux with and without XDG_CACHE_HOME, macOS, Git Bash on Windows, no HOME', (t) => {
  const scratch = tempDir('cm-cc-fn-', t);
  const probe = (pre, env) => {
    const r = spawnSync('bash', ['-c', `${pre}\n. "${PORTABLE.replaceAll('\\', '/')}"\nmem_compile_cache\nprintf '%s' "\${NODE_COMPILE_CACHE:-}"`], {
      cwd: scratch, encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const h = path.join(scratch, 'h o m e').replaceAll('\\', '/');
  fs.mkdirSync(h);
  assert.equal(probe('uname() { echo Linux; }', { HOME: h }), `${h}/.cache/cheap-mem/node-cc`);
  const xdg = path.join(scratch, 'xdg').replaceAll('\\', '/');
  assert.equal(probe('uname() { echo Linux; }', { HOME: h, XDG_CACHE_HOME: xdg }), `${xdg}/cheap-mem/node-cc`);
  assert.equal(probe('uname() { echo Linux; }', { HOME: h, XDG_CACHE_HOME: 'relative/dir' }), `${h}/.cache/cheap-mem/node-cc`, 'a relative XDG_CACHE_HOME is ignored');
  assert.equal(probe('uname() { echo Darwin; }', { HOME: h }), `${h}/Library/Caches/cheap-mem/node-cc`);
  // Git Bash: backslashes of LOCALAPPDATA become slashes (the directory is made relative to the scratch cwd here).
  assert.equal(probe('uname() { echo MINGW64_NT-10.0; }', { HOME: h, LOCALAPPDATA: 'D:\\data\\x\\Local' }), 'D:/data/x/Local/cheap-mem/node-cc');
  assert.equal(probe('uname() { echo MINGW64_NT-10.0; }', { HOME: h }), '', 'Git Bash without LOCALAPPDATA: no cache, no error');
  assert.equal(probe('uname() { echo Linux; }', {}), '', 'no HOME: no cache, no error');
  if (process.platform !== 'win32') assert.equal((fs.statSync(`${h}/.cache/cheap-mem/node-cc`).mode & 0o077), 0, 'the cache directory must be private');
});
