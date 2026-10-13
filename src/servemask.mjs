// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * servemask — the output guard at the ONE exit of `mem serve`.
 *
 * Every JSON answer of the dashboard server passes through here before it leaves: the string values are masked
 * (`outputguard.maskOutput`: known key shapes become `[REDACTED:type]`), the document is re-serialised only when
 * something changed, so an answer without a key is byte for byte what the route produced. One place for all
 * routes, the ones that exist and the ones added later: a route that forgets to mask its own fields (inbox
 * subjects, message bodies, fact values, experience titles were found leaking this way) is covered anyway.
 *
 * It works on the response object, not on the routes: `writeHead` is seen to learn the content type (and to drop a
 * `content-length` that a changed body would make wrong), `end` is seen to mask the body. A gzip body is unpacked,
 * masked and packed again only when it changes. Everything that is not JSON passes untouched.
 *
 * The field masks inside the routes may stay: they are the first layer, this is the second (layers do not replace
 * each other, see outputguard.mjs).
 */
import zlib from 'node:zlib';
import { maskOutput } from './outputguard.mjs';

const isJson = (headers) => {
  if (!headers || typeof headers !== 'object') return false;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'content-type') return /json/i.test(String(v));
  return false;
};
const hasGzip = (headers) => Object.entries(headers ?? {}).some(([k, v]) => k.toLowerCase() === 'content-encoding' && /gzip/i.test(String(v)));

/** Mask a JSON body (string or Buffer, gzip or not). Unchanged body: the SAME object comes back. */
export function maskBody(chunk, gz) {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return chunk;
  try {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const plain = (gz ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
    const masked = maskOutput(plain);
    if (masked === plain) return chunk;
    return gz ? zlib.gzipSync(masked) : masked;
  } catch {
    // Not decodable as the type it claims (a broken gzip): it is not a JSON document we could have masked; pass it on.
    return chunk;
  }
}

/** Wrap one response; call it first thing in the request handler. Returns the same `res`. */
export function guardResponse(res) {
  const writeHead = res.writeHead.bind(res);
  const end = res.end.bind(res);
  let json = false;
  let gz = false;
  res.writeHead = (code, ...rest) => {
    const at = rest.findIndex((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (at >= 0 && isJson(rest[at])) {
      json = true;
      gz = hasGzip(rest[at]);
      // A masked body can differ in length: no fixed length, the answer goes out chunked.
      const copy = {};
      for (const [k, v] of Object.entries(rest[at])) if (k.toLowerCase() !== 'content-length') copy[k] = v;
      rest[at] = copy;
    }
    return writeHead(code, ...rest);
  };
  res.end = (chunk, ...more) => (json ? end(maskBody(chunk, gz), ...more) : end(chunk, ...more));
  return res;
}
