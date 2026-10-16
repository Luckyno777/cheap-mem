// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/headless-start.test.mjs - an unattended job never starts `claude -p` open.
//
// **The finding (tool-trust review, 2026-10).** Without `--bare`, `claude -p` runs the hooks of the
// `.claude/settings.json` of the folder it starts in and connects the servers of its `.mcp.json`, in a
// folder nobody trusted, with no dialog (Claude Code docs, "What runs before you trust a folder"). The
// digest and the mail handler started IN the memory, the reflector in the host session's repository.
// Whoever could push into the memory could plant a hook and have the next tick run it.
//
// **No real claude here, ever.** A stand-in `claude.mjs` records its argv and cwd and models the ONE
// documented behaviour that matters: without `--setting-sources user` it "runs" the project hook of its
// working directory (writes a canary file). The positive control proves the stand-in fires; the red
// proofs run the BASE scripts (pinned commit, never `git merge-base`) and see the canary; the green
// runs do not. `FAKE_MODE=old` is a claude that does not know `--setting-sources`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { oldBinCopy } from './helpers/old-source-copy.mjs';
import * as hl from '../src/headless.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '9ee34416b4bc8ac452ec39bcac8ce3c1c56e96f6'; // origin/kette/cm when this was built; a FIXED hash
const bin = (n) => path.join(REPO, 'bin', n);
const baseFile = (rel) => execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: REPO, encoding: 'utf8' });

// The stand-in. MEM_*_CMD is split on whitespace, so it has to live under a path without a space.
const FAKE = `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const out = process.env.FAKE_OUT;
const rec = { argv, cwd: process.cwd(), root: process.env.CHEAP_MEM_ROOT ?? null, fired: [] };
const si = argv.indexOf('--setting-sources');
// Documented behaviour (permissions.md): no --setting-sources, or one naming 'project', reads the project's files.
const sources = si >= 0 ? String(argv[si + 1]).split(',') : ['user', 'project', 'local'];
if (process.env.FAKE_MODE === 'old' && si >= 0) {
  console.error("error: unknown option '--setting-sources'");
  rec.refused = true;
  fs.appendFileSync(out, JSON.stringify(rec) + '\\n');
  process.exit(1);
}
if (sources.includes('project')) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.claude', 'settings.json'), 'utf8'));
    if (s.canary) { fs.writeFileSync(s.canary, 'hook ran'); rec.fired.push('settings.json'); }
  } catch { /* none */ }
  if (!argv.includes('--strict-mcp-config')) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.mcp.json'), 'utf8'));
      if (m.canary) { fs.writeFileSync(m.canary, 'server connected'); rec.fired.push('.mcp.json'); }
    } catch { /* none */ }
  }
}
fs.appendFileSync(out, JSON.stringify(rec) + '\\n');
console.log('fake model: ran');
`;

/** A base directory without whitespace (the command line is word-split; Windows user names may have a space). */
function scratchBase() {
  const t = os.tmpdir();
  if (!/\s/.test(t)) return t;
  const alt = path.join(path.parse(t).root, 'cm-headless-test');
  fs.mkdirSync(alt, { recursive: true });
  return alt;
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(scratchBase(), 'cm-hl-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const fakeDir = path.join(dir, 'fakebin');
  fs.mkdirSync(fakeDir);
  fs.writeFileSync(path.join(fakeDir, 'claude.mjs'), FAKE);
  const fake = path.join(fakeDir, 'claude.mjs');
  const out = path.join(dir, 'fake-out.jsonl');
  const s = {
    dir, home, fake, out, fakeDir,
    cmd: `node ${fake.replace(/\\/g, '/')} -p`,
    calls: () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    env: (extra = {}) => ({
      ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, '.cache'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'), FAKE_OUT: out, MEM_HEADLESS: '', MEM_HOOK_OFF: '', ...extra,
    }),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  return s;
}

/** A memory with one raw capture (so a digest is due) and, planted in it, what a hostile push would add. */
function hostileMemory(s, name = 'memory') {
  const root = path.join(s.dir, name);
  fs.mkdirSync(root);
  const mem = (...a) => spawnSync('node', [bin('mem'), ...a], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(mem('init').status, 0);
  const transcript = path.join(root, 'transcript.txt');
  fs.writeFileSync(transcript, 'user: hello\nassistant: hi there, this is enough bytes to count as material.\n'.repeat(50));
  assert.equal(mem('raw-capture', '--transcript', transcript, '--min-bytes', '0').status, 0);
  const canary = path.join(s.dir, 'CANARY-settings');
  const canaryMcp = path.join(s.dir, 'CANARY-mcp');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ canary }));
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ canary: canaryMcp }));
  return { root, canary, canaryMcp };
}

const real = (p) => fs.realpathSync(p);
const inside = (child, parent) => { const r = path.relative(real(parent), real(child)); /* rel-ok: containment only, compared with '..' */ return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function runDigest(script, s, root, extra = {}) {
  return spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 120000, cwd: root,
    env: s.env({ CHEAP_MEM_ROOT: root, MEM_DIGEST_VOLUME_NOW_KB: '0', MEM_DIGEST_CMD: s.cmd, MEM_DIGEST_TIMEOUT: '60', MEM_GOLD_DAILY: 'no', ...extra }),
  });
}
function runHandler(script, s, root, extra = {}) {
  // bin/mem-watch starts the handler with the memory as its working directory.
  return spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 120000, cwd: root,
    env: s.env({ CHEAP_MEM_ROOT: root, MEM_WATCH_WHO: 'worker', MEM_HEADLESS: 'watcher', MEM_HANDLER_CMD: s.cmd, ...extra }),
  });
}
function runReflect(script, s, root, project, extra = {}) {
  const transcript = path.join(s.dir, 'session.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ role: 'user', text: 'hello' })}\n`.repeat(20));
  return spawnSync('bash', [script], {
    input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8', timeout: 120000, cwd: project,
    env: s.env({ CHEAP_MEM_ROOT: root, MEM_REFLECT_THRESHOLD_BYTES: '1', MEM_REFLECT_CMD: s.cmd, MEM_REFLECT_TIMEOUT: '60', ...extra }),
  });
}
/** The host session's repository: hostile, too (the reflector starts wherever the Stop hook was called). */
function hostileProject(s) {
  const p = path.join(s.dir, 'project');
  fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
  const canary = path.join(s.dir, 'CANARY-project');
  fs.writeFileSync(path.join(p, '.claude', 'settings.json'), JSON.stringify({ canary }));
  return { project: p, canary };
}

function assertIsolated(call, root, s) {
  const a = call.argv;
  const i = a.indexOf('--setting-sources');
  assert.ok(i >= 0 && a[i + 1] === 'user', `--setting-sources user missing: ${JSON.stringify(a)}`);
  assert.ok(a.includes('--strict-mcp-config'), `--strict-mcp-config missing: ${JSON.stringify(a)}`);
  assert.equal(call.fired.length, 0, `the planted ${call.fired.join(' + ')} ran`);
  assert.ok(!inside(call.cwd, root), `the session started inside the memory: ${call.cwd}`);
  assert.ok(inside(call.cwd, s.home), `the session did not start in the neutral directory under the cache: ${call.cwd}`);
}

// ---- the stand-in itself --------------------------------------------------------------------------

test('POSITIVE CONTROL: the stand-in runs the project hook and the .mcp.json server when started open', () => {
  const s = scratch();
  try {
    const { root, canary, canaryMcp } = hostileMemory(s);
    const r = spawnSync('node', [s.fake, '-p', 'x'], { cwd: root, env: s.env(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(canary), 'the settings hook did not fire - the red proofs below would prove nothing');
    assert.ok(fs.existsSync(canaryMcp), 'the .mcp.json server did not connect');
    fs.rmSync(canary); fs.rmSync(canaryMcp);
    const g = spawnSync('node', [s.fake, '-p', 'x', ...hl.ISOLATION_FLAGS], { cwd: root, env: s.env(), encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
    assert.ok(!fs.existsSync(canary) && !fs.existsSync(canaryMcp), 'with the flags the stand-in must stay quiet');
  } finally { s.done(); }
});

// ---- src/headless.mjs ----------------------------------------------------------------------------

test('which commands count as claude', () => {
  const yes = ['claude', 'claude -p', '/usr/local/bin/claude -p --model x', 'CLAUDE.CMD -p', 'claude.exe',
    'C:\\Program Files\\Claude\\claude.exe', 'node /x/claude.mjs -p',
    'node /a/node_modules/@anthropic-ai/claude-code/cli.js -p'];
  const no = ['', 'node ./fake-model.mjs', 'fake.sh', 'claudette -p', 'codex exec', 'chatgpt', 'gemini', 'mistral -p', 'node'];
  for (const c of yes) assert.equal(hl.isClaudeCommand(c), true, `${c} is claude`);
  for (const c of no) assert.equal(hl.isClaudeCommand(c), false, `${c} is not claude`);
});

test('the plan: flags exactly, --add-dir LAST (it takes a list), neutral cwd outside the memory', () => {
  const s = scratch();
  try {
    const root = path.join(s.dir, 'mem');
    fs.mkdirSync(root);
    const p = hl.planHeadless({ cmd: 'claude -p', root, env: s.env() });
    assert.equal(p.isolated, true);
    assert.deepEqual(p.args, ['--setting-sources', 'user', '--strict-mcp-config', '--add-dir', root]);
    assert.ok(!inside(p.cwd, root));
    assert.ok(fs.statSync(p.cwd).isDirectory(), 'the neutral directory is made');
    assert.deepEqual(fs.readdirSync(p.cwd), [], 'and it is empty');
    const q = hl.planHeadless({ cmd: 'claude -p', root, addDir: false, env: s.env() });
    assert.deepEqual(q.args, [...hl.ISOLATION_FLAGS]);
    // Not claude: left as configured.
    assert.deepEqual(hl.planHeadless({ cmd: 'node ./fake-model.mjs', root, env: s.env() }), { isolated: false, args: [], cwd: null });
  } finally { s.done(); }
});

test('a cache directory that lies INSIDE the memory is not used as the neutral directory', () => {
  const s = scratch();
  try {
    const root = path.join(s.dir, 'mem');
    fs.mkdirSync(root);
    const env = s.env({ XDG_CACHE_HOME: path.join(root, 'cache'), LOCALAPPDATA: path.join(root, 'local') });
    const cwd = hl.neutralDir({ root, env, home: path.join(root, 'h'), tmp: s.dir });
    assert.ok(cwd && !inside(cwd, root), `neutral directory ${cwd} is inside the memory`);
    assert.equal(hl.neutralDir({ root, env, home: path.join(root, 'h'), tmp: path.join(root, 't') }), null,
      'no place outside the memory: no directory, and planHeadless then throws');
    assert.throws(() => hl.planHeadless({ cmd: 'claude -p', root, env, home: path.join(root, 'h'), tmp: path.join(root, 't') }),
      /neutral working directory/);
  } finally { s.done(); }
});

test('an old claude is recognised by its refusal, and ordinary failures are not mistaken for it', () => {
  const yes = ["error: unknown option '--setting-sources'", "Error: Unrecognized option --setting-sources", 'unexpected argument --strict-mcp-config found',
    "error: unknown option '--setting-sources'\n(Did you mean --settings?)"];
  const no = ['', 'API Error: 529 overloaded', "error: unknown option '--frobnicate'", 'timeout: failed to run command', 'the setting-sources flag is great'];
  for (const t of yes) assert.equal(hl.looksLikeOldClaude(t), true, t);
  for (const t of no) assert.equal(hl.looksLikeOldClaude(t), false, t);
});

test('the command line: plan prints lines, old-claude reads a file, bad use exits 2', () => {
  const s = scratch();
  try {
    const root = path.join(s.dir, 'mem');
    fs.mkdirSync(root);
    const run = (...a) => spawnSync('node', [bin('mem-headless.mjs'), ...a], { encoding: 'utf8', env: s.env() });
    const r = run('plan', '--cmd', 'claude -p', '--root', root);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], 'isolated=1');
    assert.match(lines[1], /^cwd=/);
    assert.deepEqual(lines.slice(2), ['arg=--setting-sources', 'arg=user', 'arg=--strict-mcp-config', 'arg=--add-dir', `arg=${root}`]);
    assert.equal(run('plan', '--cmd', 'node x.mjs', '--root', root).stdout, 'isolated=0\n');
    assert.equal(run('plan', '--cmd', 'claude -p').status, 2, 'no root: refused');
    assert.equal(run('plan', '--bogus').status, 2);
    assert.equal(run().status, 2);
    const f = path.join(s.dir, 'o.txt');
    fs.writeFileSync(f, "error: unknown option '--setting-sources'\n");
    const o = run('old-claude', f);
    assert.equal(o.status, 0);
    assert.match(o.stdout, /does not know --setting-sources/);
    fs.writeFileSync(f, 'all fine\n');
    assert.equal(run('old-claude', f).status, 1);
  } finally { s.done(); }
});

// ---- RED on the base: the three scripts start the session open --------------------------------------

test('RED on the base: the digest, the mail handler and the reflector let a planted hook run', () => {
  const s = scratch();
  const copies = [];
  try {
    const { root, canary, canaryMcp } = hostileMemory(s);
    const d = oldBinCopy(REPO, 'mem-digest', baseFile('bin/mem-digest'), ['_portable.sh', 'mem']); copies.push(d);
    const h = oldBinCopy(REPO, 'mem-handle-post', baseFile('bin/mem-handle-post'), ['_portable.sh']); copies.push(h);
    const r = oldBinCopy(REPO, 'mem-reflect', baseFile('bin/mem-reflect'), ['_portable.sh', 'mem-mask-copy.mjs']); copies.push(r);

    runDigest(d.script, s, root);
    assert.ok(fs.existsSync(canary) && fs.existsSync(canaryMcp), 'base digest: the planted settings hook and .mcp.json server run');
    fs.rmSync(canary); fs.rmSync(canaryMcp);
    assert.equal(s.calls().at(-1).cwd, real(root), 'base digest starts IN the memory');
    assert.ok(!s.calls().at(-1).argv.includes('--setting-sources'));

    runHandler(h.script, s, root);
    assert.ok(fs.existsSync(canary), 'base handler: the planted hook runs');
    fs.rmSync(canary); fs.rmSync(canaryMcp, { force: true });

    const { project, canary: pc } = hostileProject(s);
    const rr = runReflect(r.script, s, root, project);
    assert.equal(rr.status, 0, rr.stderr);
    assert.ok(fs.existsSync(pc), 'base reflector: the hook of the host repository runs');
  } finally { for (const c of copies) fs.rmSync(c.dir, { recursive: true, force: true }); s.done(); }
});

// ---- GREEN: every start carries the flags and starts in the neutral directory -------------------------

test('GREEN digest: flags after the prompt, --add-dir last, neutral cwd, nothing planted runs', () => {
  const s = scratch();
  try {
    const { root, canary, canaryMcp } = hostileMemory(s);
    const r = runDigest(bin('mem-digest'), s, root);
    assert.notEqual(r.status, 2, `${r.stderr}\n${r.stdout}`);
    const calls = s.calls();
    assert.equal(calls.length, 1, `exactly one model call, got ${calls.length}\n${r.stdout}`);
    const c = calls[0];
    assert.equal(c.argv[0], '-p', 'the configured words come first');
    assert.match(c.argv[1], /You are the digest/, 'then the prompt');
    assert.deepEqual(c.argv.slice(2), ['--output-format', 'json', '--setting-sources', 'user', '--strict-mcp-config', '--add-dir', root.replace(/\\/g, '/')]);
    assertIsolated(c, root, s);
    assert.equal(c.root, root, 'the session finds the memory by its environment, not its working directory');
    assert.match(c.argv[1], /Your working directory is NOT the memory/);
    assert.match(c.argv[1], new RegExp(`git -C ${root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.ok(!fs.existsSync(canary) && !fs.existsSync(canaryMcp));
  } finally { s.done(); }
});

test('GREEN mail handler: started in the memory (as bin/mem-watch does), the session is not', () => {
  const s = scratch();
  try {
    const { root, canary, canaryMcp } = hostileMemory(s);
    const r = runHandler(bin('mem-handle-post'), s, root);
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    const calls = s.calls();
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.match(c.argv[1], /You are the 'worker' role/);
    assert.deepEqual(c.argv.slice(2), ['--setting-sources', 'user', '--strict-mcp-config', '--add-dir', root.replace(/\\/g, '/')]);
    assertIsolated(c, root, s);
    assert.ok(!fs.existsSync(canary) && !fs.existsSync(canaryMcp));
  } finally { s.done(); }
});

test('GREEN reflector: the host repository\'s hook does not run, and no --add-dir (it never reads the memory as files)', () => {
  const s = scratch();
  try {
    const { root } = hostileMemory(s);
    const { project, canary } = hostileProject(s);
    const r = runReflect(bin('mem-reflect'), s, root, project);
    assert.equal(r.status, 0, r.stderr);
    const calls = s.calls();
    assert.equal(calls.length, 1, `the reflector did not call the model: ${r.stderr}`);
    const c = calls[0];
    assert.deepEqual(c.argv.slice(2), ['--setting-sources', 'user', '--strict-mcp-config']);
    assert.ok(!inside(c.cwd, project) && !inside(c.cwd, root));
    assert.ok(inside(c.cwd, s.home));
    assert.ok(!fs.existsSync(canary));
  } finally { s.done(); }
});

test('a command that is not claude is left exactly as configured (cwd, no flags)', () => {
  const s = scratch();
  try {
    const { root } = hostileMemory(s);
    const model = path.join(s.fakeDir, 'other-model.mjs');
    fs.copyFileSync(s.fake, model);
    const r = runDigest(bin('mem-digest'), s, root, { MEM_DIGEST_CMD: `node ${model.replace(/\\/g, '/')} -p` });
    assert.notEqual(r.status, 2, r.stderr);
    const c = s.calls()[0];
    assert.equal(c.argv.length, 4, JSON.stringify(c.argv));
    assert.deepEqual(c.argv.slice(2), ['--output-format', 'json']);
    assert.equal(c.cwd, real(root), 'unchanged: it starts in the memory, as before');
    assert.doesNotMatch(c.argv[1], /Your working directory is NOT the memory/);
  } finally { s.done(); }
});

test('the default command `claude` on PATH is isolated too (POSIX; Windows has no extensionless shim, the form above covers it)', () => {
  const s = scratch();
  try {
    const { root } = hostileMemory(s);
    if (process.platform === 'win32') {
      // Honest platform branch: Git Bash does not find `claude.cmd` by the bare name, so there is no PATH test to run.
      assert.equal(hl.isClaudeCommand('claude -p'), true);
      return;
    }
    const shim = path.join(s.fakeDir, 'claude');
    fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec node "${s.fake}" "$@"\n`, { mode: 0o755 });
    const r = runHandler(bin('mem-handle-post'), s, root, { MEM_HANDLER_CMD: '', PATH: `${s.fakeDir}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    assertIsolated(s.calls()[0], root, s);
  } finally { s.done(); }
});

// ---- an old claude: refuse with a sentence, never start open ---------------------------------------------

test('an old claude: the digest says why, once, and does not start it without the flag', () => {
  const s = scratch();
  try {
    const { root } = hostileMemory(s);
    const r = runDigest(bin('mem-digest'), s, root, { FAKE_MODE: 'old' });
    assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /does not know --setting-sources \(too old\)/);
    const log = fs.readFileSync(path.join(root, '.mem', 'digest.log'), 'utf8');
    assert.match(log, /Update claude/);
    const calls = s.calls();
    assert.equal(calls.length, 1, 'one start, refused by the old claude itself');
    assert.ok(calls.every((c) => c.argv.includes('--setting-sources')), 'no start without the flag');
    assert.deepEqual(calls.filter((c) => c.fired.length), []);
  } finally { s.done(); }
});

test('an old claude: the mail handler exits non-zero with the sentence on stderr; the reflector exits 0 and says it', () => {
  const s = scratch();
  try {
    const { root } = hostileMemory(s);
    const h = runHandler(bin('mem-handle-post'), s, root, { FAKE_MODE: 'old' });
    assert.notEqual(h.status, 0);
    assert.match(h.stderr, /does not know --setting-sources \(too old\)/);
    const { project } = hostileProject(s);
    const r = runReflect(bin('mem-reflect'), s, root, project, { FAKE_MODE: 'old' });
    assert.equal(r.status, 0, 'a Stop hook never blocks the host session');
    assert.match(r.stderr, /does not know --setting-sources \(too old\)/);
    assert.ok(s.calls().every((c) => c.argv.includes('--setting-sources')), 'never started without the flag');
  } finally { s.done(); }
});

// ---- no safe start: no start --------------------------------------------------------------------------------

test('no neutral directory can be made: all three scripts REFUSE and start nothing', () => {
  const s = scratch();
  try {
    const { root } = hostileMemory(s);
    const { project } = hostileProject(s);
    // Every candidate is a regular file, so mkdir under/at it fails: the cache bases, and the one in the OS temp directory.
    const blocker = path.join(s.dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const tmp = path.join(s.dir, 'tmp');
    fs.mkdirSync(tmp);
    const user = (() => { try { return os.userInfo().username; } catch { return 'user'; } })().replace(/[^A-Za-z0-9_.-]/g, '_');
    fs.writeFileSync(path.join(tmp, `cheap-mem-headless-cwd-${user}`), 'x');
    const noDir = { XDG_CACHE_HOME: blocker, LOCALAPPDATA: blocker, HOME: blocker, USERPROFILE: blocker, TMPDIR: tmp, TEMP: tmp, TMP: tmp };

    const probe = spawnSync('node', [bin('mem-headless.mjs'), 'plan', '--cmd', 'claude -p', '--root', root], { encoding: 'utf8', env: s.env(noDir) });
    assert.equal(probe.status, 2, `the plan must fail closed: ${probe.stdout}${probe.stderr}`);
    assert.match(probe.stderr, /neutral working directory/);

    const d = runDigest(bin('mem-digest'), s, root, noDir);
    assert.equal(d.status, 1, `${d.stderr}\n${d.stdout}`);
    assert.match(d.stdout, /REFUSED: no safe way to start the model session/);
    const h = runHandler(bin('mem-handle-post'), s, root, noDir);
    assert.equal(h.status, 1, h.stderr);
    assert.match(h.stderr, /REFUSED - no safe way to start the model session/);
    const r = runReflect(bin('mem-reflect'), s, root, project, noDir);
    assert.equal(r.status, 0, 'a Stop hook never blocks the host session');
    assert.match(r.stderr, /REFUSED - no safe way to start the model session/);
    assert.equal(s.calls().length, 0, 'nothing was started, by any of the three');
  } finally { s.done(); }
});

// ---- the ratchet: no claude launch outside the starter --------------------------------------------------------

const SCAN_DIRS = ['bin', 'src', 'install', 'hooks', 'eval'];
const SCAN_EXT = /\.(mjs|js|sh|ps1)$|^[^.]+$/;
/** Files that may start a claude WITHOUT going through the starter, each with the reason. */
const ALLOWED = {
  'src/cli/commands/setup.mjs': 'management commands only: `claude --version` and `claude mcp add` (no session starts)',
  'eval/model-call.mjs': 'the measuring tool: starts in an empty directory of its own (emptyWorkdir) with --restricted and --strict-mcp-config, never in a memory',
};

function listFiles(rel) {
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'runs' ? [] : listFiles(r);
    return SCAN_EXT.test(e.name) ? [r] : [];
  });
}
const stripComments = (file, text) => {
  const hash = /\.(sh|ps1)$/.test(file) || !/\./.test(path.basename(file));
  return text.split('\n').map((l) => (hash ? (/^\s*#/.test(l) ? '' : l) : (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))).join('\n');
};

/**
 * The launches in a source text that the starter must cover. Returns `[reason, line]` pairs.
 *  - a node spawn/exec of claude, codex or gemini (literal command name)
 *  - a shell/PowerShell line that starts one of them at a command position
 *  - the configured-command launches (`$CMD "$PROMPT"`, `& $exe @argList`, `Start-Process -FilePath $Cmd`) that do not carry the
 *    starter's arguments on the same line
 */
export function findLaunches(file, text) {
  const t = stripComments(file, text);
  const found = [];
  const lines = t.split('\n');
  const AGENT = '(?:claude|codex|gemini)';
  const nodeSpawn = new RegExp(`\\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\\(\\s*['"\`]${AGENT}['"\`]`);
  const nodeCmd = new RegExp(`\\bcommand\\s*=\\s*['"]${AGENT}['"]`);
  const shellCmd = new RegExp(`(?:^|[|;&(]|\\$\\(|\\bexec\\s|\\bthen\\s|\\bdo\\s|\\b(?:capped|timeout|gtimeout|nohup|nice|time)\\s+(?:[0-9]+[smhd]?\\s+|-\\S+\\s+)*)\\s*${AGENT}(?:\\.exe|\\.cmd)?\\s+(?:-|[a-z]+\\b)`);
  const psCmd = new RegExp(`(?:^\\s*&\\s*|Start-Process\\s+(?:-FilePath\\s+)?)['"]?${AGENT}\\b`, 'i');
  lines.forEach((l, i) => {
    const where = `${file}:${i + 1}`;
    if (nodeSpawn.test(l) || nodeCmd.test(l)) found.push(['node launch', where]);
    else if (/\.(sh|ps1)$/.test(file) || !/\./.test(path.basename(file))) {
      if (shellCmd.test(l) && !/^\s*(echo|printf|note|Write-)/.test(l) && !/["'].*\b(?:claude|codex|gemini)\b.*["']\s*>&?2?\s*$/.test(l)) found.push(['shell launch', where]);
      if (psCmd.test(l)) found.push(['powershell launch', where]);
    }
    // The configured command: its launch line must carry the starter's arguments.
    if (/\$CMD\s+"\$PROMPT"|"\$\{MEM_START\[@\]\}"\s+"\$PROMPT"/.test(l) && !/MEM_HL_ARGS/.test(l)) found.push(['configured command without the starter arguments', where]);
    if (/Start-Process\s+-FilePath\s+\$Cmd\b/.test(l) && !/\$StartArgs/.test(l)) found.push(['configured command without the starter arguments', where]);
  });
  if (/&\s*\$exe\s+@argList/.test(t) && !/\$argList\s*\+=\s*\$plan\.Args/.test(t)) found.push(['configured command without the starter arguments', `${file}`]);
  return found;
}

test('RATCHET: no claude (codex, gemini) launch in bin/src/install/hooks/eval outside the starter', () => {
  const all = SCAN_DIRS.flatMap(listFiles);
  assert.ok(all.length > 150, `only ${all.length} files scanned - the walker no longer fits`);
  const bad = [];
  for (const f of all) {
    const hits = findLaunches(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
    if (hits.length && !(f in ALLOWED)) bad.push(...hits.map(([why, where]) => `${where}: ${why}`));
  }
  assert.deepEqual(bad, [], 'A model session must be started through bin/mem-headless.mjs (mem_headless_plan / Get-HeadlessPlan), '
    + 'so it carries --setting-sources user --strict-mcp-config and a neutral working directory.');
});

test('RATCHET: the three jobs launch through the starter, and the allowlist is not stale', () => {
  const need = {
    'bin/mem-digest': /mem_headless_plan/, 'bin/mem-handle-post': /mem_headless_plan/, 'bin/mem-reflect': /mem_headless_plan/,
    'bin/mem-digest.ps1': /Get-HeadlessPlan/, 'bin/mem-handle-post.ps1': /Get-HeadlessPlan/, 'bin/mem-reflect.ps1': /Get-HeadlessPlan/,
  };
  for (const [f, re] of Object.entries(need)) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.match(text, re, `${f} does not ask the starter`);
    // The refusal is part of it: a plan that failed must end in a refusal, never in an open start.
    assert.match(text, /REFUSED/, `${f} has no refusal path`);
  }
  for (const f of Object.keys(ALLOWED)) {
    assert.ok(fs.existsSync(path.join(REPO, f)), `${f} is on the allowlist but gone`);
    assert.ok(findLaunches(f, fs.readFileSync(path.join(REPO, f), 'utf8')).length > 0, `${f} is on the allowlist but starts nothing any more - remove it`);
  }
  const mc = fs.readFileSync(path.join(REPO, 'eval/model-call.mjs'), 'utf8');
  assert.match(mc, /cwd = emptyWorkdir\(\)/, 'the eval tool must keep starting in its own empty directory');
  assert.match(mc, /'--strict-mcp-config'/);
  const setup = fs.readFileSync(path.join(REPO, 'src/cli/commands/setup.mjs'), 'utf8');
  for (const m of setup.matchAll(/spawnSync\('claude', \[([^\]]*)/g)) {
    assert.match(m[1], /^\s*'(--version|mcp)'/, `setup.mjs starts claude with something other than --version or mcp: ${m[1]}`);
  }
});

test('RATCHET mutants: a launch added anywhere, or the starter\'s arguments dropped, is found', () => {
  // The scanner finds nothing in the real files (above); these are the shapes it must catch.
  const mutants = [
    ['src/new.mjs', "import { spawnSync } from 'node:child_process';\nspawnSync('claude', ['-p', prompt]);\n"],
    ['src/new.mjs', "const r = spawn(\"codex\", ['exec', p]);\n"],
    ['bin/new-job', '#!/usr/bin/env bash\nclaude -p "$PROMPT" > out\n'],
    ['bin/new-job', '#!/usr/bin/env bash\nif x; then timeout 5 claude -p "$P"; fi\n'],
    ['bin/new-job', '#!/usr/bin/env bash\nfoo | claude -p\n'],
    ['bin/new-job.ps1', '& claude -p $prompt\n'],
    ['bin/new-job.ps1', 'Start-Process -FilePath claude -ArgumentList $a\n'],
    ['bin/new-job', '#!/usr/bin/env bash\ncapped 5 $CMD "$PROMPT" >/dev/null\n'],
    ['bin/new-job.ps1', 'Start-Process -FilePath $Cmd -ArgumentList ($CmdArgs + @($Prompt))\n'],
    ['eval/new.mjs', "export function f(command = 'gemini') {}\n"],
  ];
  for (const [file, text] of mutants) assert.ok(findLaunches(file, text).length > 0, `not found: ${text}`);
  // Drop the starter's arguments from the real digest, handler and reflector: each is found.
  for (const f of ['bin/mem-digest', 'bin/mem-handle-post', 'bin/mem-reflect']) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.deepEqual(findLaunches(f, text), [], `${f} is clean as it stands`);
    const mutant = text.replace(/\$\{MEM_HL_ARGS\[@\]\+"\$\{MEM_HL_ARGS\[@\]\}"\}/g, '');
    assert.notEqual(mutant, text);
    assert.ok(findLaunches(f, mutant).length > 0, `${f}: dropping MEM_HL_ARGS goes unnoticed`);
  }
  for (const f of ['bin/mem-digest.ps1', 'bin/mem-handle-post.ps1', 'bin/mem-reflect.ps1']) {
    assert.deepEqual(findLaunches(f, fs.readFileSync(path.join(REPO, f), 'utf8')), [], `${f} is clean as it stands`);
  }
  const ps = fs.readFileSync(path.join(REPO, 'bin/mem-handle-post.ps1'), 'utf8').replace('$argList += $plan.Args', '');
  assert.ok(findLaunches('bin/mem-handle-post.ps1', ps).length > 0, 'dropping $plan.Args in the PowerShell handler goes unnoticed');
  const dg = fs.readFileSync(path.join(REPO, 'bin/mem-digest.ps1'), 'utf8').replace('-ArgumentList $StartArgs', '-ArgumentList ($CmdArgs + @($Prompt))');
  assert.ok(findLaunches('bin/mem-digest.ps1', dg).length > 0, 'dropping $StartArgs in the PowerShell digest goes unnoticed');
});

test('PowerShell twins: same flags and the same refusal wording as the shell side (text check; no PowerShell on this machine)', () => {
  const ps = fs.readFileSync(path.join(REPO, 'bin/_headless.ps1'), 'utf8');
  assert.match(ps, /mem-headless\.mjs/, 'the PowerShell helper asks the same node starter');
  assert.doesNotMatch(stripComments('bin/_headless.ps1', ps), /setting-sources|strict-mcp-config/, 'the flags live in ONE place: src/headless.mjs');
  const sh = fs.readFileSync(path.join(REPO, 'bin/_portable.sh'), 'utf8');
  assert.match(sh, /mem-headless\.mjs/);
  assert.doesNotMatch(stripComments('bin/_portable.sh', sh.slice(sh.indexOf('MEM_HL_HELPER='))), /--setting-sources|strict-mcp-config/);
  const src = fs.readFileSync(path.join(REPO, 'src/headless.mjs'), 'utf8');
  assert.match(src, /ISOLATION_FLAGS = Object\.freeze\(\['--setting-sources', 'user', '--strict-mcp-config'\]\)/);
  assert.ok(pathToFileURL(REPO).href.length > 0);
});
