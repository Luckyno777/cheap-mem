// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * loopback — the one gate between an entry's text and a network socket.
 *
 * Owner decision, 2026-10-13: NO entry text goes to an embedding vendor,
 * not even masked. The only embedding path left is a model on this
 * machine, and "on this machine" is decided HERE, once, not by whoever
 * writes the next adapter.
 *
 * What counts as loopback:
 *   - an IPv4 literal in 127.0.0.0/8
 *   - the IPv6 literal ::1, or an IPv4-mapped ::ffff:127.x.x.x
 *   - the exact name `localhost`, and only if the system resolver
 *     returns loopback addresses for it and nothing else
 *
 * What does NOT count, however innocent it looks: any other host name.
 * It is refused WITHOUT being resolved. A name that resolves to
 * 127.0.0.1 today can resolve elsewhere tomorrow (DNS rebinding, a
 * hosts-file edit, a wildcard record), so a name is never proof. 0.0.0.0,
 * private ranges (10/8, 192.168/16, a LAN ollama box) and link-local are
 * not loopback either: that text would cross a wire.
 *
 * The caller gets back an address to connect to (`address`) and must use
 * THAT, not the name again, so the check and the connection cannot
 * disagree.
 */

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** Is this IP literal (no brackets) a loopback address? */
export function isLoopbackAddress(addr) {
  const a = String(addr).toLowerCase();
  const kind = isIP(a);
  if (kind === 4) return a.split('.')[0] === '127';
  if (kind !== 6) return false;
  if (a === '::1') return true;
  // IPv4-mapped, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1, which
  // is what the WHATWG URL parser normalises the dotted form to).
  const dotted = /^(?:0{0,4}:){2,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) return isLoopbackAddress(dotted[1]);
  const hex = /^(?:0{0,4}:){2,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) return (parseInt(hex[1], 16) >> 8) === 127;
  // Fully expanded ::1
  if (/^(?:0{1,4}:){7}0{0,3}1$/.test(a)) return true;
  return false;
}

/**
 * Check an endpoint URL. Never throws.
 *
 * @param {string} raw      the configured URL (OLLAMA_HOST)
 * @param {object} [opts]
 * @param {Function} [opts.lookup]  async (name) => [{address}], injectable
 * @returns {Promise<{ok: true, address: string, port: number, host: string}
 *   | {ok: false, reason: string, host: string}>}
 *   `host` is for display: no credentials, no path, no query.
 */
export async function checkEndpoint(raw, { lookup = null } = {}) {
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(raw)) ? String(raw) : `http://${raw}`); }
  catch { return { ok: false, reason: 'not a valid URL', host: '(unparseable)' }; }
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  const shown = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  if (url.protocol !== 'http:') {
    return { ok: false, reason: `scheme '${url.protocol.slice(0, -1)}' is not allowed (http to a loopback address only)`, host: shown };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials in the URL are not allowed', host: shown };
  }
  const port = url.port ? Number(url.port) : 80;
  if (isIP(bare)) {
    return isLoopbackAddress(bare)
      ? { ok: true, address: bare, port, host: shown }
      : { ok: false, reason: 'not a loopback address', host: shown };
  }
  if (bare.toLowerCase() !== 'localhost') {
    // Not resolved on purpose: see the header.
    return { ok: false, reason: 'not a loopback address (a host name other than localhost is never trusted)', host: shown };
  }
  let found;
  try {
    found = lookup ? await lookup('localhost') : await dnsLookup('localhost', { all: true });
  } catch (e) {
    return { ok: false, reason: `localhost did not resolve (${e.code ?? e.message})`, host: shown };
  }
  const addrs = (Array.isArray(found) ? found : [found]).map((f) => f.address);
  if (addrs.length === 0 || !addrs.every(isLoopbackAddress)) {
    return { ok: false, reason: 'localhost resolves to a non-loopback address here', host: shown };
  }
  // Prefer IPv4: it is what ollama binds by default.
  const address = addrs.find((x) => isIP(x) === 4) ?? addrs[0];
  return { ok: true, address, port, host: shown };
}
