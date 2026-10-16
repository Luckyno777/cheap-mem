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
// tables to call a handler directly — only to read off the command names,
// which is data, not a shortcut around the process boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
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
  assert.equal(names.length, 88, `expected 88 commands, found ${names.length}: ${names.join(',')}`);
});

// **`--help` and `-h` are one contract.** `-h` used to be known only to
// bin/mem as the FIRST argument; after a command name it was an ordinary word,
// so `mem init -h` built a memory, `mem status -h` ran, `mem shrink -h`
// created `.pipeline/` and `mem serve -h` STARTED the server (found 2026-10-13).
for (const flag of ['--help', '-h']) {
  test(`every command: ${flag} exits 0, prints something, and leaves no file behind`, async () => {
    const names = await allCommands();
    const failures = [];
    for (const name of names) {
      const root = freshRoot();
      const before = snapshot(root);
      const env = { ...process.env };
      delete env.CHEAP_MEM_ROOT;
      const r = spawnSync(process.execPath, [MEM, name, flag, '--root', root], {
        encoding: 'utf8',
        cwd: root,
        env,
        timeout: 30000, // one command that never ends must be NAMED, not cost the whole file's 15 minutes
      });
      const after = snapshot(root);
      if (r.error?.code === 'ETIMEDOUT') {
        failures.push(`${name}: ${flag} did not end within 30 s (stdout so far: ${String(r.stdout).slice(0, 200)})`);
        continue;
      }
      if (r.status !== 0) {
        failures.push(`${name}: exit ${r.status} (stderr: ${r.stderr.trim().slice(0, 200)})`);
        continue;
      }
      if (!r.stdout.trim()) {
        failures.push(`${name}: ${flag} printed nothing`);
        continue;
      }
      if (before.join('\n') !== after.join('\n')) {
        failures.push(`${name}: ${flag} left files behind: `
          + `before=[${before.join(', ')}] after=[${after.join(', ')}]`);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.deepEqual(failures, [], `\n${failures.join('\n')}\n`);
  });
}

test('-h stands for --help wherever a switch could stand, not only first', () => {
  const root = freshRoot();
  for (const argv of [
    ['init', '-h'], ['status', '-h'], ['board', '-h'], ['shrink', '-h'],
    ['log', '-h'], ['log', 'learning', '-h'], ['find', 'x', '-h'], ['inbox', '-h', 'write'], ['project', 'init', '-h'],
  ]) {
    const r = spawnSync(process.execPath, [MEM, ...argv, '--root', root], { encoding: 'utf8', cwd: root, timeout: 30000 });
    assert.equal(r.status, 0, `${argv.join(' ')}: exit ${r.status} ${r.stderr}`);
    assert.ok(r.stdout.trim(), `${argv.join(' ')}: printed nothing`);
    assert.deepEqual(snapshot(root), [], `${argv.join(' ')} left files behind`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('mem -h as the first argument prints the overview, as before', () => {
  const r = spawnSync(process.execPath, [MEM, '-h'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^mem — cheap-mem CLI/);
});

test('mem serve -h starts nothing: it exits at once and its port stays closed', async () => {
  const root = freshRoot();
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const r = spawnSync(process.execPath, [MEM, 'serve', '-h', '--port', String(port), '--root', root],
    { encoding: 'utf8', cwd: root, timeout: 15000 });
  assert.equal(r.status, 0, `exit ${r.status} ${r.error?.code ?? ''} ${r.stderr}`);
  const open = await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    c.on('connect', () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
  assert.equal(open, false, 'a server listens on the port after `mem serve -h`');
  assert.deepEqual(snapshot(root), [], 'mem serve -h left files behind');
  fs.rmSync(root, { recursive: true, force: true });
});

test('POSITIVE: -h as the VALUE of a parameter is text, not help', () => {
  const root = freshRoot();
  const run = (argv) => spawnSync(process.execPath, [MEM, ...argv, '--root', root], { encoding: 'utf8', cwd: root, timeout: 30000 });
  assert.equal(run(['init']).status, 0);
  for (const argv of [
    ['log', 'learning', '--title', 't-one', '--text', '-h'],
    ['log', 'learning', '--title', '-h', '--text', 'body two'],
    ['log', 'learning', '--text=-h', '--title', 't-three'],
  ]) {
    const r = run(argv);
    assert.equal(r.status, 0, `${argv.join(' ')}: exit ${r.status} ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /^mem log/m, `${argv.join(' ')} printed help instead of writing`);
  }
  const learnings = fs.readFileSync(path.join(root, 'global', 'learnings.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(learnings.length, 3, `expected 3 learnings, got ${learnings.length}`);
  assert.ok(learnings.some((e) => e.text === '-h'), 'text "-h" was not written');
  assert.ok(learnings.some((e) => e.title === '-h'), 'title "-h" was not written');
  fs.rmSync(root, { recursive: true, force: true });
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

test('mem serve actually starts and binds a real port, as a process (defect 1)', { timeout: 90000 }, async () => {
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
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await gone;
    // Windows: the kill is a hard kill and `mem serve`'s own child (the recall server) is not taken with
    // it, so it may still hold the two pipes. Without this the test process keeps its event loop busy
    // on pipes nobody reads and the file never ends (a 900 s timeout on Windows node 20).
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
