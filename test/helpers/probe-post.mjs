// test/helpers/probe-post.mjs - one POST to a local service, for probes that send a body ABOVE a limit.
//
// A service that refuses an over-limit body answers 413 at once and may cut the connection while the client is still
// writing. On a loopback socket the reset then lands in one of two places: on the REQUEST before any answer arrived, or on
// the RESPONSE after the status line came in. A helper that resolves at the response's 'end' and has no 'error' listener on
// the response hangs on the second case, or node:test reports "asynchronous activity after the test ended" and the file
// turns red although every assertion passed (seen once in 16 runs under load in the sibling house).
//
// Rules of this helper:
//   - it settles when the REQUEST is closed, never earlier;
//   - the status line that arrived is the answer; a reset after it is part of that answer (`resetAfterAnswer`);
//   - a failure before any answer is `{ status: null, code }`; the code is NOT interpreted (it differs per platform);
//   - the response's 'error' is always listened to;
//   - a hard time limit settles a probe whose connection hangs (`code: 'timeout'`).
import http from 'node:http';

/**
 * @param {http.RequestOptions} options  as for http.request
 * @param {(q: http.ClientRequest) => unknown} send  writes the body and ends the request (may be async)
 * @returns {Promise<{ status: number|null, code: string|null, resetAfterAnswer: boolean }>}
 */
export function probePost(options, send, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let status = null;
    let code = null;
    let resetAfterAnswer = false;
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, code: status === null ? (code ?? 'closed') : code, resetAfterAnswer });
    };
    const q = http.request({ method: 'POST', ...options }, (r) => {
      status = r.statusCode;
      r.on('aborted', () => { resetAfterAnswer = true; });
      r.on('error', (e) => { resetAfterAnswer = true; code = e.code ?? 'unknown'; });
      r.resume();
    });
    timer = setTimeout(() => { code = 'timeout'; q.destroy(); done(); }, timeoutMs);
    timer.unref();
    q.on('error', (e) => { code = e.code ?? 'unknown'; if (status !== null) resetAfterAnswer = true; });
    q.on('close', done);
    Promise.resolve().then(() => send(q)).catch(() => {});
  });
}
