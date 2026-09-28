// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// mcplive.mjs — is the local MCP bridge actually serving what
// mcpprofile.mjs says it should?
//
// **The gap.** The dashboard's MCP table listed every tool from
// `src/mcpprofile.mjs`'s READING/WRITING arrays — the DEFINITION — with
// no way to tell whether the bridge that is actually running answers
// with the same set. A tool dropped from `TOOLS` in `bin/mem-mcp` while
// staying in `mcpprofile.mjs` would show "present" forever.
//
// This probe asks the LOCAL bridge (`bin/mem-mcp --http`) a real
// `tools/list`, over the MCP SDK's own HTTP client — the same transport
// a real MCP client uses — and compares the answer against the
// definition:
//
//   tool in the live answer            -> good    ("present")
//   bridge answers, tool is missing    -> error    ("missing live")
//   bridge unreachable / timed out     -> unknown, with a reason
//
// **Short timeout, a few minutes of cache.** `/dashboard.json` is polled
// often; this must never make that route wait on a network call, and a
// dashboard server with no bridge running (the common case while
// building) must never hang for it either.
export const PROBE_TIMEOUT_MS = 1500;
export const PROBE_TTL_MS = 3 * 60 * 1000;
// A property write, not a rebind of this binding across the await
// boundaries in probe() below (require-atomic-updates) -- the box
// itself never changes identity, only cache.entry does.
const cache = { entry: null }; // entry: { until: epoch-ms, result }

/** Where the local bridge should be reachable — the same variables
 *  `httpConfig()` in bin/mem-mcp reads (not imported: that module has
 *  its own startup side effects, this stays a pure function). */
export function probeConfig(env = process.env) {
  return {
    host: env.CHEAP_MEM_MCP_HOST || '127.0.0.1',
    port: Number(env.CHEAP_MEM_MCP_PORT || 8849),
    urlPath: '/mcp',
    token: env.CHEAP_MEM_MCP_TOKEN || '',
  };
}

/**
 * The probe itself. `getClient` is swappable so tests can hand in a
 * fake SDK client without a real HTTP server; in production it is the
 * MCP SDK.
 */
export async function probe({
  env = process.env, now = Date.now(), timeoutMs = PROBE_TIMEOUT_MS,
  ttlMs = PROBE_TTL_MS, noCache = false,
  getClient = null,
} = {}) {
  if (!noCache && cache.entry && cache.entry.until > now) return cache.entry.result;
  const cfg = probeConfig(env);
  let names = null;
  let reason = null;
  try {
    let Client;
    let StreamableHTTPClientTransport;
    if (getClient) {
      ({ Client, StreamableHTTPClientTransport } = await getClient());
    } else {
      ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
      ({ StreamableHTTPClientTransport } =
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js'));
    }
    const url = new URL(`http://${cfg.host}:${cfg.port}${cfg.urlPath}`);
    const client = new Client({ name: 'cheap-mem-dashboard-probe', version: '1' }, { capabilities: {} });
    const requestInit = cfg.token ? { headers: { Authorization: `Bearer ${cfg.token}` } } : {};
    const signal = AbortSignal.timeout(timeoutMs);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }), { signal });
    const { tools } = await client.listTools(undefined, { signal, timeout: timeoutMs });
    names = tools.map((t) => t.name);
    client.close().catch(() => {});
  } catch (e) {
    reason = e?.message ? String(e.message).split('\n')[0] : String(e || 'unknown error');
  }
  const result = names
    ? { reachable: true, names, checkedAt: new Date(now).toISOString() }
    : { reachable: false, reason: reason || 'bridge unreachable', checkedAt: new Date(now).toISOString() };
  // Two concurrent probe() calls racing to set this is harmless here: a
  // cache is meant to be overwritten by whichever finishes last, and
  // either outcome is a real (if momentarily stale) measurement, never
  // a correctness bug -- kickProbe()'s own "at most one in flight" latch
  // is what actually matters for cost, not this line.
  // eslint-disable-next-line require-atomic-updates
  cache.entry = { until: now + ttlMs, result };
  return result;
}

/**
 * Per defined tool name: good/error/unknown — never guessed, never a
 * dash when not measured. JSON-friendly for `/dashboard.json`.
 */
export function verdicts(result, defined) {
  const out = {};
  for (const n of defined) {
    if (!result.reachable) { out[n] = { state: 'unknown', reason: result.reason }; continue; }
    out[n] = result.names.includes(n)
      ? { state: 'good', reason: 'seen live' }
      : { state: 'error', reason: 'in the definition, but not in the bridge\'s live answer' };
  }
  return out;
}

/** Tests only: clear the cache (and any in-flight marker). */
export function _clearCache() { cache.entry = null; inFlight.promise = null; }

const inFlight = { promise: null };

/**
 * Read ONLY the cache — no network, no `await`, never a wait. A route
 * that must answer synchronously in the same tick reads this, never
 * {@link probe} directly. `null` means "nothing cached yet", not
 * "bridge dead".
 */
export function probeNow(now = Date.now()) {
  return (cache.entry && cache.entry.until > now) ? cache.entry.result : null;
}

/**
 * Kick a probe off in the background (fire-and-forget), at most one at
 * a time. The NEXT call to {@link probeNow} sees the result; this one
 * still reads "unknown".
 */
export function kickProbe(opts = {}) {
  if (inFlight.promise) return;
  inFlight.promise = probe(opts)
    .catch(() => { /* probe() catches its own errors; a residual one must not surface here */ })
    .finally(() => { inFlight.promise = null; });
}
