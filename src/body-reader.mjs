// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// body-reader.mjs — ONE bounded body reader for the writing routes of the
// dashboard server (audit F21; the sibling house's src/rumpfleser.mjs).
//
// Before, every route checked `body.length > cap` BEFORE appending the chunk
// and counted characters, not bytes: a single large chunk got past the cap
// (field validation then said 400 instead of 413), and multi-byte characters
// were torn apart at chunk borders.
//
// The contract:
//  - The cap counts BYTES and includes the current chunk.
//  - A Content-Length above the cap is refused without reading.
//  - On overflow nothing more is collected; the caller gets exactly ONE
//    `{ status: 'too-big' }` and answers 413 (no mutation).
//  - If the client goes away (aborted/close/error before the end) exactly one
//    `{ status: 'aborted' }` arrives; there is no way to answer any more and
//    the caller does nothing.
//  - Otherwise exactly one `{ status: 'ok', body }` (decoded once as UTF-8).

export const BODY_TOO_BIG = 'too-big';
export const BODY_ABORTED = 'aborted';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse|null} res only for `connection: close` and for tearing down after a 413
 * @param {number} maxBytes
 * @param {(result: {status: string, body?: string}) => void} done called exactly once
 */
export function readBoundedBody(req, res, maxBytes, done) {
  let finished = false;
  const chunks = [];
  let sum = 0;

  const end = (result) => {
    if (finished) return;
    finished = true;
    // The listeners stay attached (the 'error' listener has to stay anyway);
    // `finished` makes every further event without effect.
    chunks.length = 0;
    if (result.status === BODY_TOO_BIG && res && typeof res.once === 'function') {
      // The rest of the body does not matter: close the connection after the answer.
      try { res.setHeader('connection', 'close'); } catch { /* head already sent */ }
      res.once('finish', () => { try { req.destroy?.(); } catch { /* already closed */ } });
      res.once('close', () => { try { req.destroy?.(); } catch { /* already closed */ } });
    }
    done(result);
  };
  const tooBig = () => { end({ status: BODY_TOO_BIG }); if (typeof req.resume === 'function') req.resume(); };
  function onData(piece) {
    if (finished) return;
    const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(String(piece), 'utf8');
    if (sum + buf.length > maxBytes) { tooBig(); return; }
    sum += buf.length;
    chunks.push(buf);
  }
  function onEnd() { end({ status: 'ok', body: Buffer.concat(chunks).toString('utf8') }); }
  function onAbort() { end({ status: BODY_ABORTED }); }
  req.on('error', onAbort);

  const length = Number(req.headers?.['content-length']);
  if (Number.isFinite(length) && length > maxBytes) { tooBig(); return; }

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('aborted', onAbort);
  req.on('close', onAbort); // 'close' after 'end' meets finished=true
}
