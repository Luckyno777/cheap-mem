// M10 (2026-09-30): `mem serve` as an OPTIONAL user service.
//
// Default OFF, asked in the installer, removed by the uninstall. Every
// run here uses HOME=<temp dir> and fake `systemctl`/`launchctl`/`uname`
// on PATH that only log their arguments — no real service manager and
// no real home directory is ever touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const SERVICE = path.join(CODE, 'install', 'serve-service.sh');
const LINUX = path.join(CODE, 'install', 'linux.sh');

const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// Paths written INTO a shell script use "/" (a Windows drive path with backslashes is an escape trap in
// "..." there); the PATH list uses the platform's delimiter (":" would cut `C:\...` in two).
const slash = (p) => p.split(path.sep).join('/');

/**
 * `p` as the install script itself writes it into a unit: `cd "$CHEAP_MEM_ROOT" && pwd`, through
 * the same environment variable and the same bash. On Linux that is `p`; under Git Bash on Windows
 * it is `/c/Users/...` -- the notation the script (not the host's `C:\...`) puts in the unit.
 */
function asTheScriptWritesIt(p, env) {
  const r = spawnSync('bash', ['-c', 'cd "$CHEAP_MEM_ROOT" && pwd'], { encoding: 'utf8', env: { ...env, CHEAP_MEM_ROOT: p } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function world(unameAnswer = 'Linux') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-m10-svc-'));
  made.push(base);
  const home = path.join(base, 'home');
  const root = path.join(base, 'memory');
  const fake = path.join(base, 'fakebin');
  const log = path.join(base, 'calls.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fake);
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  for (const tool of ['systemctl', 'launchctl']) {
    fs.writeFileSync(path.join(fake, tool), `#!/bin/sh\necho "${tool} $*" >> "${slash(log)}"\nexit 0\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(fake, 'uname'), `#!/bin/sh\necho ${unameAnswer}\n`, { mode: 0o755 });
  // On Windows the variable is called `Path` in the spread copy: drop every spelling, then set one,
  // or the child gets two and may take the one without the fake tools.
  const env = { ...process.env, HOME: home, CHEAP_MEM_ROOT: root };
  const realPath = process.env.PATH ?? '';
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  env.PATH = `${fake}${path.delimiter}${realPath}`;
  delete env.CHEAP_MEM_SERVE_SERVICE;
  return { base, home, root, log, env, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

const run = (file, args, env) => spawnSync('bash', [file, ...args], { encoding: 'utf8', env, input: '', timeout: 30000 });

test('Linux: install writes a systemd user unit for `mem serve`, uninstall removes it', () => {
  const w = world('Linux');
  const unit = path.join(w.home, '.config', 'systemd', 'user', 'cheap-mem-serve.service');
  const r = run(SERVICE, ['install'], w.env);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(unit, 'utf8');
  const root = asTheScriptWritesIt(w.root, w.env);
  assert.match(text, new RegExp(`bin/mem --root ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} serve`));
  assert.ok(text.includes(`Environment=CHEAP_MEM_ROOT=${root}\n`), 'the unit names the root in the same notation twice');
  assert.match(w.calls(), /systemctl --user enable --now cheap-mem-serve\.service/);
  const u = run(SERVICE, ['uninstall'], w.env);
  assert.equal(u.status, 0, u.stderr);
  assert.equal(fs.existsSync(unit), false, 'uninstall removes the unit');
  assert.match(w.calls(), /systemctl --user disable --now cheap-mem-serve\.service/);
});

test('macOS: install writes a launchd agent, uninstall removes it', () => {
  const w = world('Darwin');
  const plist = path.join(w.home, 'Library', 'LaunchAgents', 'com.cheap-mem.serve.plist');
  const r = run(SERVICE, ['install'], w.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(plist, 'utf8'), /<string>serve<\/string>/);
  assert.match(w.calls(), /launchctl bootstrap/);
  const u = run(SERVICE, ['uninstall'], w.env);
  assert.equal(u.status, 0, u.stderr);
  assert.equal(fs.existsSync(plist), false);
  assert.match(w.calls(), /launchctl bootout .*com\.cheap-mem\.serve/);
});

test('linux.sh: the serve service is OFF by default and ON only when asked', () => {
  const unitOf = (w) => path.join(w.home, '.config', 'systemd', 'user', 'cheap-mem-serve.service');
  const watchOf = (w) => path.join(w.home, '.config', 'systemd', 'user', 'cheap-mem-watch.service');

  const off = world('Linux');
  const r1 = run(LINUX, [], { ...off.env, MEM_WATCH_WHO: 'librarian' });
  assert.equal(r1.status, 0, r1.stderr);
  // Positive control: the installer really ran (the watcher unit is there).
  assert.ok(fs.existsSync(watchOf(off)), 'the watcher unit was written');
  assert.equal(fs.existsSync(unitOf(off)), false, 'no prompt answer (not a tty) -> not installed');
  assert.match(r1.stdout, /mem serve service: not installed \(default\)/);

  const no = world('Linux');
  run(LINUX, [], { ...no.env, MEM_WATCH_WHO: 'librarian', CHEAP_MEM_SERVE_SERVICE: 'no' });
  assert.equal(fs.existsSync(unitOf(no)), false);

  const yes = world('Linux');
  const r3 = run(LINUX, [], { ...yes.env, MEM_WATCH_WHO: 'librarian', CHEAP_MEM_SERVE_SERVICE: 'yes' });
  assert.equal(r3.status, 0, r3.stderr);
  assert.ok(fs.existsSync(unitOf(yes)), 'asked for -> installed');
});

test('windows.ps1: serve task is optional, off by default, removable', () => {
  const ps = fs.readFileSync(path.join(CODE, 'install', 'windows.ps1'), 'utf8');
  assert.match(ps, /\[switch\]\$ServeService/);
  assert.match(ps, /\[switch\]\$UninstallServeService/);
  assert.match(ps, /\$wantServe = \$false/, 'default is off');
  // Non-interactive runs are never asked (and therefore never install it).
  assert.match(ps, /\[Environment\]::UserInteractive -and -not \[Console\]::IsInputRedirected/);
  const uninstall = ps.slice(ps.indexOf('if ($UninstallServeService)'), ps.indexOf('if ($UninstallServeService)') + 300);
  assert.match(uninstall, /Unregister-ScheduledTask -TaskName \$ServeTaskName/);
  assert.match(uninstall, /exit 0/);
});
