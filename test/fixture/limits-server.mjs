// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A small HTTP server in a CHILD process for test/http-limits.test.mjs.
//
// Call: node limits-server.mjs '<json>'   with { module: <absolute path of http-limits.mjs | null>, opt: {...} }
// Prints "PORT <n>" and listens until the parent ends it (SIGTERM, or the handle's kill on Windows).
//
// Why a child: the probes put TIME limits of the SERVER on trial. In the test's own loop it would stand still with the
// test (a synchronous call, a loaded machine) and the limit would cut a request the test never sent slowly. The server
// is hardened by `hardenServer` from src/http-limits.mjs - or, as the control, on purpose not at all (`module: null`).
// Loopback only.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// No argument is no probe run (a gate may start every script under test/fixture once with nothing): end cleanly at once.
if (!process.argv[2]) process.exit(0);
const { module: modulePath, opt } = JSON.parse(process.argv[2]);

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
  if (url.pathname === '/heads') {
    const n = String(Object.keys(req.headers).length);
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': n.length }).end(n);
    return;
  }
  if (url.pathname === '/long') {
    // An answer that takes longer than every limit on RECEIVING the request: `chunks` events 500 ms apart. With
    // `abort=<ms>` the server cuts it itself - the control that the probe sees an abort at all.
    const n = Number(url.searchParams.get('chunks') || 4);
    const abort = Number(url.searchParams.get('abort') || 0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    let i = 0;
    const beat = setInterval(() => {
      if (i < n) { res.write(`data: ${i}\n\n`); i += 1; } else { clearInterval(beat); res.end('data: end\n\n'); }
    }, 500);
    if (abort > 0) setTimeout(() => { clearInterval(beat); res.destroy(); }, abort).unref();
    res.on('close', () => clearInterval(beat));
    return;
  }
  // Everything else: read the body and say "read" (the POST way).
  req.on('error', () => { /* connection cut by the server */ });
  req.resume();
  req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }).end('read'); });
});

if (modulePath) {
  const m = await import(pathToFileURL(modulePath).href);
  m.hardenServer(server, opt || {});
}
server.listen(0, '127.0.0.1', () => { process.stdout.write(`PORT ${server.address().port}\n`); });
process.on('SIGTERM', () => process.exit(0));
