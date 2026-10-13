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
 * masked and packed again only when it changes. JSON documents and `text/plain` bodies (the error texts, which carry
 * `e.message`) are guarded; HTML, CSS, scripts, images and fonts pass untouched (masking a script would corrupt it).
 *
 * The field masks inside the routes may stay: they are the first layer, this is the second (layers do not replace
 * each other, see outputguard.mjs).
 */
import zlib from 'node:zlib';
import { maskOutput, maskText } from './outputguard.mjs';

const headerOf = (headers, name) => {
  if (!headers || typeof headers !== 'object') return '';
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return String(v);
  return '';
};
/** Which kind of body the headers announce: 'json', 'text' (text/plain: the error bodies), or null (not guarded). */
const kindOf = (headers) => {
  const type = headerOf(headers, 'content-type');
  if (/json/i.test(type)) return 'json';
  if (/^\s*text\/plain/i.test(type)) return 'text';
  return null;
};

// What is asked for again and again (the dashboard head, `/dashboard.json`) is masked once: a string by value, a
// Buffer (the packed gzip body the server keeps) by identity. Bounded, dropped whole when full.
const MEMO_MAX_CHARS = 16_000_000;
const memoStr = new Map();
let memoChars = 0;
const memoBuf = new WeakMap();

/**
 * Mask a body (string or Buffer, gzip or not, JSON document or plain text). An unchanged body comes back as the SAME
 * object. Throws when the body cannot be read as what it claims to be (a broken gzip): the caller must not hand out a
 * body it could not look at.
 */
export function maskBody(chunk, gz = false, kind = 'json') {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return chunk;
  const isStr = typeof chunk === 'string';
  if (isStr && memoStr.has(chunk)) return memoStr.get(chunk);
  if (!isStr && memoBuf.has(chunk)) return memoBuf.get(chunk);
  const bytes = isStr ? Buffer.from(chunk, 'utf8') : chunk;
  const plain = (gz ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
  const masked = kind === 'json' ? maskOutput(plain) : maskText(plain);
  const result = masked === plain ? chunk : (gz ? zlib.gzipSync(masked) : masked);
  if (isStr) {
    if (memoChars + chunk.length > MEMO_MAX_CHARS) { memoStr.clear(); memoChars = 0; }
    memoStr.set(chunk, result);
    memoChars += chunk.length;
  } else memoBuf.set(chunk, result);
  return result;
}

/**
 * Wrap one response; call it first thing in the request handler. Returns the same `res`.
 * The status line and headers of a guarded response are held back until `end`, so that a body which cannot be masked
 * can still turn into a bare 500 instead of going out unlooked-at.
 */
export function guardResponse(res) {
  const writeHead = res.writeHead.bind(res);
  const end = res.end.bind(res);
  let held = null; // { code, rest, kind, gz }
  res.writeHead = (code, ...rest) => {
    const at = rest.findIndex((x) => x && typeof x === 'object' && !Array.isArray(x));
    const kind = at >= 0 ? kindOf(rest[at]) : null;
    if (!kind) return writeHead(code, ...rest);
    // A masked body can differ in length: no fixed length, the answer goes out chunked.
    const copy = {};
    for (const [k, v] of Object.entries(rest[at])) if (k.toLowerCase() !== 'content-length') copy[k] = v;
    rest[at] = copy;
    held = { code, rest, kind, gz: /gzip/i.test(headerOf(copy, 'content-encoding')) };
    return res;
  };
  res.end = (chunk, ...more) => {
    if (!held) return end(chunk, ...more);
    const h = held;
    held = null;
    let body;
    try { body = maskBody(chunk, h.gz, h.kind); } catch {
      writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return end('response could not be checked', ...more.filter((x) => typeof x === 'function'));
    }
    writeHead(h.code, ...h.rest);
    return end(body, ...more);
  };
  return res;
}
