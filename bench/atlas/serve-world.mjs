// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/serve-world.mjs — a throwaway dashboard server on a scratch
// memory, and a browser to look at it, for the `dashboard` and `net-tempo`
// phases.
//
// **Not a copy of the viewer.** The server is `bin/mem-serve` itself, started
// as its own child process (the way bench/board-tempo.mjs starts it), on a free
// loopback port, with the login and the token off (`CHEAP_MEM_SERVE_LOGIN=off`,
// `CHEAP_MEM_SERVE_LOCAL_NO_TOKEN=1`: the loopback-only switch the viewer
// documents) and the recall service off. Nothing here talks to a real memory:
// the root is a scratch folder made by the caller.
//
// **Counting inside the server.** With `reads: true` the child loads
// bench/atlas/io-counter.mjs, which appends one line per process (and per
// worker thread: the full build runs in a worker) when the child ends. The child
// is ended with a `stop` message over an IPC channel (works on Windows too) and
// with SIGTERM as the fallback; a wrapper turns both into `process.exit(0)` so the
// counter's exit hook runs. Where neither gets through (Windows kills a process
// outright on a signal) the file stays empty: an empty file is a counter that never
// wrote, so `stop()` says `null` and the caller reports `not-measured`, never zero.
//
// **The browser** is Playwright's Chromium with software GL, found the way
// test/fixture/browser.mjs finds it (the module, then /opt/pw-browsers). No
// Chromium is `{ browser: null, reason }`, never an exception.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO } from './core.mjs';
import { readRows } from './call-counter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IO_COUNTER = path.join(HERE, 'io-counter.mjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

/**
 * Start `bin/mem-serve` on `root`.
 * @param {string} root a scratch memory
 * @param {{ reads?: boolean, env?: object, outDir: string }} opt `outDir`: a scratch folder for the counter file
 * @returns {Promise<{ base: string, pid: number, stderr: () => string, stop: () => Promise<{ rows: object[]|null }> }>}
 */
export async function startServer(root, { reads = false, env = {}, outDir } = {}) {
  const port = await freePort();
  const out = path.join(outDir, `io-${port}.txt`);
  fs.writeFileSync(out, '');
  const childEnv = {
    ...process.env,
    CHEAP_MEM_SERVE_LOGIN: 'off',
    CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1',
    CHEAP_MEM_SERVE_PORT: String(port),
    CHEAP_MEM_SERVE_HOST: '127.0.0.1',
    MEM_RECALL_SERVER: '0',
    ...env,
  };
  delete childEnv.CHEAP_MEM_SERVE_TOKEN;
  const counterUrl = `${pathToFileURL(IO_COUNTER).href}?root=${encodeURIComponent(root)}&out=${encodeURIComponent(out)}`;
  const code = `process.on('SIGTERM', () => process.exit(0));\n`
    + `process.on('message', (m) => { if (m === 'stop') process.exit(0); });\n`
    + `import(${JSON.stringify(pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href)}).then((m) => m.serve(${JSON.stringify(root)}, process.env));`;
  const child = spawn(process.execPath, [...(reads ? [`--import=${counterUrl}`] : []), '-e', code], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let err = '';
  child.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
  let exited = false;
  const gone = new Promise((r) => child.on('exit', () => { exited = true; r(); }));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 600 && !exited; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(50);
  }
  if (!up) {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    throw new Error(`the server did not come up: ${err.slice(-300)}`);
  }
  return {
    base,
    pid: child.pid,
    stderr: () => err,
    async stop() {
      if (!exited) {
        // The IPC message ends the child through its exit hook on every platform; SIGTERM is the fallback.
        try { child.send('stop'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
        await Promise.race([gone, sleep(15000)]);
        if (!exited) { try { child.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([gone, sleep(5000)]); }
      }
      return { rows: reads ? rowsOrNull(readRows(out)) : null };
    },
  };
}

/** The counter file is made empty before the child starts, so "no rows" means the counter never wrote: not a zero. */
export function rowsOrNull(rows) { return rows === null || rows === undefined || rows.length === 0 ? null : rows; }

/** Playwright's Chromium with software GL, or `{ browser: null, reason }`. */
export async function startBrowser() {
  let pw = null;
  for (const b of [import.meta.url, '/opt/node22/lib/node_modules/']) {
    try { pw = createRequire(b)('playwright'); break; } catch { /* next place */ }
  }
  if (!pw) return { browser: null, reason: 'playwright is not installed' };
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  let browser = null;
  try { browser = await pw.chromium.launch({ args }); } catch { /* fall back below */ }
  if (!browser) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) { try { browser = await pw.chromium.launch({ executablePath: exe, args }); } catch { /* none */ } }
  }
  return browser ? { browser, reason: null } : { browser: null, reason: 'no Chromium starts here' };
}

/** Sum a counter file's rows: lines of the entry logs read, bytes of them, bytes of everything else. */
export function sumReads(rows) {
  if (rowsOrNull(rows) === null) return null;
  const t = { lines: 0, corpusBytes: 0, otherBytes: 0, rows: rows.length };
  for (const r of rows) {
    t.lines += r.linesRead ?? 0;
    t.corpusBytes += r.corpusBytesRead ?? 0;
    t.otherBytes += r.otherBytesRead ?? 0;
  }
  return t;
}
