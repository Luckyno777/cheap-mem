// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Fault injection for test/z1b-start-status.test.mjs (E4). Preloaded with
// `node --import`: the N-th append (open for 'a') to a procedures.jsonl throws, like a
// full disk or a crash between two writes would.
import fs from 'node:fs';

const failAt = Number(process.env.Z1B_FAIL_APPEND_AT ?? '0');
let n = 0;
// Every append goes through `fs.openSync(path, 'a')` (src/append.mjs), whatever
// the writer around it looks like — so that is the one place to inject.
const real = fs.openSync;
fs.openSync = function patched(p, flags, ...rest) {
  if (failAt > 0 && flags === 'a' && /procedures\.jsonl$/.test(String(p))) {
    n += 1;
    if (n === failAt) throw new Error(`injected write failure (append #${n})`);
  }
  return real.call(this, p, flags, ...rest);
};
