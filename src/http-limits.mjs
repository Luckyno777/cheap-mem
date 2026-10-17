// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// http-limits.mjs — hard limits for every HTTP service that listens (parity A9 (a), slow-header and connection-flood
// hardening; the sibling house's src/http-grenzen.mjs).
//
// **The fault this closes.** The two HTTP services (`bin/mem-serve` behind `mem serve`, `bin/mem-mcp --http`) ran with the
// Node defaults: request headers may trickle for 60 s (in practice 90 s, because Node only checks every 30 s), a body for
// 300 s, and the number of open connections is unlimited. Whoever keeps a few hundred connections open and sends one byte
// every couple of seconds (Slowloris) occupies the service without ever finishing a request; enough silent connections
// run a service with a 1024-descriptor limit out of file descriptors and nothing connects any more. Measured numbers are
// in docs/security-model.md section 8.
//
// **One place.** `hardenServer(server, { maxConnections })` directly after `http.createServer(...)`, before `listen`. A new
// HTTP service calls it; test/http-limits.test.mjs counts the calls against the `createServer` starts, and the listener
// inventory in test/serve-token-refuse-cm.test.mjs requires it of every listed service.
//
// **What is deliberately NOT limited.** `requestTimeout` and `headersTimeout` bound only the RECEIVING of the request
// (head plus body), never the answer: a long answer or a stream comes through (test/http-limits.test.mjs, probe "long
// answer"). There is no socket idle limit (`server.timeout` stays 0).
//
// **The price of that: a stream holds a seat for good.** The MCP bridge DOES stream: `GET /mcp` (Streamable HTTP, stateless)
// opens an SSE stream that sends `: keepalive` every 15 s and never ends by itself (measured: still open after 35 s). Each
// open stream keeps one of the `maxConnections` seats until the client leaves, so a client that holds 256 streams locks
// the bridge. That needs the token (or `--local-no-token` on loopback); see docs/security-model.md, "HTTP service limits".
//
// **The check interval.** Node checks the time limits only every `connectionsCheckingInterval` (default 30 s): a 10 s limit
// would act after up to 40 s. 2 s makes it 10 to 12 s; the check walks the open connections and costs nothing at 512.
//
// **A limit that stands still.** If the event loop of the service itself hangs longer than `headersTimeoutMs` (a long
// synchronous call), Node cuts the requests that started in that time. The services work in milliseconds to seconds; whoever
// builds something long and synchronous into them has to know this.

/** The values at which the services get hard. Once here, so the probe and the documentation name the same numbers. */
export const LIMITS = Object.freeze({
  /** The whole head within this time (Node default: 60000). */
  headersTimeoutMs: 10_000,
  /** Head plus body within this time (Node default: 300000). Every body cap of the services is small (4 KiB to 1 MiB). */
  requestTimeoutMs: 30_000,
  /** Idle time between two requests on one connection. The Node default, written down on purpose. Must stay BELOW headersTimeoutMs. */
  keepAliveTimeoutMs: 5_000,
  /** At most this many header lines reach a handler (Node default: unlimited, apart from the 16 KiB head size). Node 20.x and
   *  22.x up to 22.23.1 drop the surplus lines; from 22.23.2 on (CVE-2026-58044) Node refuses such a request with 431. */
  maxHeadersCount: 100,
  /** How often Node checks the time limits (Node default: 30000). */
  checkIntervalMs: 2_000,
});

/**
 * Open connections at the same time, per service. Beyond it Node drops the connection on accept (event `drop`).
 *
 * **How the numbers are chosen.** A service unit usually has 1024 file descriptors; measured (docs/security-model.md):
 * silent connections beyond that made a service unreachable until the header limit freed them. The caps sit clearly BELOW
 * 1024 and leave room for files and child processes. They are no wall against an attacker who fills the seats (behind a
 * tunnel every connection comes from 127.0.0.1, so there is no per-peer limit): he holds them only until the header limit
 * frees them after about 12 s, instead of suffocating the service for 90 s.
 */
export const MAX_CONNECTIONS = Object.freeze({
  /** Dashboard in a browser: few users, up to 6 connections per browser, plus the watcher and hooks. */
  dashboard: 512,
  /** MCP bridge over HTTP behind a tunnel: a handful of clients, each with short requests. */
  mcp: 256,
});

/**
 * Sets the limits on an `http.Server` that does not listen yet and returns the same server.
 *
 * Leave `maxConnections` out for unlimited. NEVER pass 0: from Node 21 on a raw 0 drops EVERY connection (event `drop`),
 * Node 20 reads it as no cap at all - neither is a cap. Anything that is not a positive integer leaves the cap unset.
 *
 * The other options are for probes (small times, so a probe waits for a state and not for a long span); the services call
 * without them.
 *
 * @param {import('node:http').Server} server
 * @param {{ maxConnections?: number, headersTimeoutMs?: number, requestTimeoutMs?: number,
 *           keepAliveTimeoutMs?: number, maxHeadersCount?: number, checkIntervalMs?: number }} [opt]
 */
export function hardenServer(server, opt = {}) {
  const g = { ...LIMITS, ...opt };
  // Node wants requestTimeout >= headersTimeout (it throws on listen otherwise); both are set before anyone listens.
  // keepAliveTimeout has to stay below headersTimeout, or the idle limit tears first.
  server.requestTimeout = g.requestTimeoutMs;
  server.headersTimeout = g.headersTimeoutMs;
  server.keepAliveTimeout = g.keepAliveTimeoutMs;
  server.maxHeadersCount = g.maxHeadersCount;
  // Must stand before `listen`: Node creates the timer on listening and reads the value there.
  server.connectionsCheckingInterval = g.checkIntervalMs;
  if (Number.isInteger(g.maxConnections) && g.maxConnections > 0) server.maxConnections = g.maxConnections;
  return server;
}
