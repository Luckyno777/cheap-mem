// The CLI contract, held against the real PROCESS, not the modules.
//
// **Why this file exists.** Four defects shipped after `bin/mem` split
// into six group modules on 2026-09-18, and every one of them is
// invisible to a test that imports the handler and calls it in-process:
//
//   1. `mem serve` died with "Cannot find module ... mem-serve" — the
//      dynamic import in setup.mjs pointed next to itself instead of at
//      `bin/mem-serve`. test/console.test.mjs and test/dashboard.test.mjs
//      import bin/mem-serve DIRECTLY and never go through `mem serve`,
//      so the path the CLI actually takes had zero coverage.
//   2. `mem status --json` returned exit 0 on a broken root — a `return`
//      inside the `if (args.json)` branch skipped the exit-code logic
//      below it. Nothing that calls `setup.check()` in-process would
//      ever see that: it is a defect in the COMMAND, not in setup.mjs.
//   3. `mem init --help` created `.mem/config.json` on a fresh root —
//      there was no isHelp() guard on `init` at all.
//   4. `mem correction --help` and `mem inbox --help` both failed
//      instead of showing help (agents.mjs/write.mjs had no isHelp()
//      guard on those two either), and `whoami`/`init`/`version --help`
//      printed their normal output instead of help.
//
// All four need a process boundary to fail, so this file only ever
// spawns `bin/mem` as a child process. It never imports the command
// tables to call a handler directly — only to read off the 60 names,
// which is data, not a shortcut around the process boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const GROUPS = ['write', 'search', 'capture', 'agents', 'setup', 'admin'];

async function allCommands() {
  const names = [];
  for (const g of GROUPS) {
    const m = await import(pathToFileURL(
      path.join(REPO, 'src/cli/commands', `${g}.mjs`)).href);
    names.push(...Object.keys(m.COMMANDS));
  }
  return names;
}

/** A directory listing deep enough to notice a stray file two levels
 * down (e.g. `.mem/config.json`), shallow enough not to choke on a
 * real memory tree. Sorted, so two listings compare by content, not by
 * whatever order readdir happened to return. */
function snapshot(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(path.join(abs, name));
      out.push(`${relPath}${st.isDirectory() ? '/' : ` ${st.size}b`}`);
      if (st.isDirectory()) walk(relPath);
    }
  };
  walk('');
  return out;
}

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-contract-'));
}

test('POSITIVE: the command list itself is not empty (vacuity check)', async () => {
  const names = await allCommands();
  assert.equal(names.length, 60, `expected 60 commands, found ${names.length}: ${names.join(',')}`);
});

test('every command: --help exits 0, prints something, and leaves no file behind', async () => {
  const names = await allCommands();
  const failures = [];
  for (const name of names) {
    const root = freshRoot();
    const before = snapshot(root);
    const env = { ...process.env };
    delete env.CHEAP_MEM_ROOT;
    const r = spawnSync(process.execPath, [MEM, name, '--help', '--root', root], {
      encoding: 'utf8',
      cwd: root,
      env,
    });
    const after = snapshot(root);
    if (r.status !== 0) {
      failures.push(`${name}: exit ${r.status} (stderr: ${r.stderr.trim().slice(0, 200)})`);
      continue;
    }
    if (!r.stdout.trim()) {
      failures.push(`${name}: --help printed nothing`);
      continue;
    }
    if (before.join('\n') !== after.join('\n')) {
      failures.push(`${name}: --help left files behind: `
        + `before=[${before.join(', ')}] after=[${after.join(', ')}]`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}\n`);
});

test('mem status --json: same exit code as the text form, healthy root', () => {
  const root = freshRoot();
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  const text = spawnSync(process.execPath, [MEM, 'status', '--root', root], { encoding: 'utf8' });
  const json = spawnSync(process.execPath, [MEM, 'status', '--json', '--root', root], { encoding: 'utf8' });
  assert.equal(text.status, 0, `text form: ${text.stdout}${text.stderr}`);
  assert.equal(json.status, 0, `json form: ${json.stdout}${json.stderr}`);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.broken, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mem status --json: same exit code as the text form, BROKEN root (defect 2)', () => {
  const root = freshRoot();
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{ this is not json');

  const text = spawnSync(process.execPath, [MEM, 'status', '--root', root], { encoding: 'utf8' });
  const json = spawnSync(process.execPath, [MEM, 'status', '--json', '--root', root], { encoding: 'utf8' });

  assert.notEqual(text.status, 0, `text form should fail on a broken config:\n${text.stdout}`);
  assert.equal(json.status, text.status,
    `--json exited ${json.status} while the text form exited ${text.status} for the same broken root — `
    + `payload: ${json.stdout}`);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.broken, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mem init --help does not create a memory (defect 3)', () => {
  const root = freshRoot();
  const r = spawnSync(process.execPath, [MEM, 'init', '--help', '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /mem init/);
  assert.ok(!fs.existsSync(path.join(root, '.mem')),
    '.mem/ was created by --help — the guard against side effects during --help is gone');
  fs.rmSync(root, { recursive: true, force: true });
});

test('mem correction --help shows help instead of dying (defect 4a)', () => {
  const r = spawnSync(process.execPath, [MEM, 'correction', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /mem correction/);
});

test('mem inbox --help shows help, with no `mem whoami` set (defect 4b)', () => {
  const root = freshRoot();
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  const r = spawnSync(process.execPath, [MEM, 'inbox', '--help', '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /mem inbox/);
  assert.doesNotMatch(r.stdout, /Who is this install in the channel/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mem whoami --help shows help, not the current identity', () => {
  const root = freshRoot();
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  spawnSync(process.execPath, [MEM, 'whoami', 'user', '--root', root], { encoding: 'utf8' });
  const r = spawnSync(process.execPath, [MEM, 'whoami', '--help', '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /^whoami: user/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mem version --help shows help, not the version', () => {
  const r = spawnSync(process.execPath, [MEM, 'version', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /^cheap-mem \d/);
});

test('mem serve actually starts and binds a real port, as a process (defect 1)', async () => {
  const root = freshRoot();
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });

  const child = spawn(process.execPath, [MEM, 'serve', '--port', '0', '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const consoleLine = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `'mem serve' printed no Console line within 5s.\nstdout: ${stdout}\nstderr: ${stderr}`)), 5000);
    child.stdout.on('data', (b) => {
      stdout += b.toString();
      const m = stdout.match(/Console: (http:\/\/[^\s]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`'mem serve' exited early (code ${code}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  try {
    // The one request that proves it is not just a printed line: a real
    // socket, answering. This is exactly the request bin/mem-serve's
    // missing-module crash never let anyone make.
    const res = await fetch(`${consoleLine}health`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, 'ok');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
