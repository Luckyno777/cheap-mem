// test/mcp-probe-close.test.mjs — audit F22: the MCP live probe closes its client in EVERY case (finally),
// with a short limit, without overwriting the original error; dedup/TTL stay (the sibling's test/mcp-probe-close.test.mjs).
// Red proof against the fixed old state 4bbca61 (git show of src/mcplive.mjs).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as live from '../src/mcplive.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '4bbca61';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mcp-close-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let OLD_LIVE = null;
try {
  fs.writeFileSync(path.join(dir, 'mcplive-old.mjs'), execFileSync('git', ['-C', REPO, 'show', `${OLD}:src/mcplive.mjs`], { encoding: 'utf8' }));
  OLD_LIVE = await import(pathToFileURL(path.join(dir, 'mcplive-old.mjs')).href);
} catch { /* no history in this checkout: the red probe skips */ }

/** A fake SDK; `behaviour` steers connect/listTools/close; `counter.close` counts. */
function fake(behaviour = {}) {
  const counter = { close: 0, get: 0 };
  const getClient = async () => {
    counter.get += 1;
    return {
      Client: class {
        async connect() { if (behaviour.connect) throw behaviour.connect; }
        async listTools() { if (behaviour.listTools) throw behaviour.listTools; return { tools: [{ name: 'a' }, { name: 'b' }] }; }
        async close() { counter.close += 1; if (behaviour.close) return behaviour.close(); return undefined; }
      },
      StreamableHTTPClientTransport: class {},
    };
  };
  return { getClient, counter };
}
const probe = (mod, f, extra = {}) => mod.probe({ env: {}, noCache: true, getClient: f.getClient, ...extra });

test('green: listTools throws -> the client is closed anyway, the original reason stays', async () => {
  const f = fake({ listTools: new Error('listTools broken') });
  const r = await probe(live, f);
  assert.equal(r.reachable, false);
  assert.equal(r.reason, 'listTools broken');
  assert.equal(f.counter.close, 1);
});

test('green: connect throws -> the client is closed, the original reason stays', async () => {
  const f = fake({ connect: new Error('connection gone') });
  const r = await probe(live, f);
  assert.equal(r.reason, 'connection gone');
  assert.equal(f.counter.close, 1);
});

test('green: if close throws too, the original error is kept (nothing thrown outwards)', async () => {
  const f = fake({ listTools: new Error('original'), close: () => { throw new Error('close broken'); } });
  assert.equal((await probe(live, f)).reason, 'original');
  const g = fake({ listTools: new Error('original2'), close: () => Promise.reject(new Error('close rejects')) });
  assert.equal((await probe(live, g)).reason, 'original2');
});

test('green: if close hangs, the probe returns after a short limit (not endlessly)', async () => {
  const f = fake({ listTools: new Error('x'), close: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await probe(live, f);
  assert.equal(r.reason, 'x');
  assert.ok(Date.now() - t0 < live.PROBE_CLOSE_LIMIT_MS + 1500, `took ${Date.now() - t0} ms`);
});

test('positive control: success -> reachable, names, exactly one close', async () => {
  const f = fake();
  const r = await probe(live, f);
  assert.equal(r.reachable, true);
  assert.deepEqual(r.names, ['a', 'b']);
  assert.equal(f.counter.close, 1);
});

test('dedup/TTL kept: a second call within the TTL uses the cache', async () => {
  live._clearCache();
  const f = fake();
  const a = await live.probe({ env: {}, now: 1000, ttlMs: 5000, getClient: f.getClient });
  const b = await live.probe({ env: {}, now: 2000, ttlMs: 5000, getClient: f.getClient });
  assert.equal(f.counter.get, 1);
  assert.deepEqual(a, b);
  await live.probe({ env: {}, now: 7000, ttlMs: 5000, getClient: f.getClient });
  assert.equal(f.counter.get, 2);
  live._clearCache();
});

test(`RED on the fixed old state (${OLD}): the old probe does NOT close the client on a listTools error`, { skip: !OLD_LIVE && 'old commit not available in this checkout' }, async () => {
  const f = fake({ listTools: new Error('listTools broken') });
  const r = await probe(OLD_LIVE, f);
  assert.equal(r.reachable, false);
  assert.equal(f.counter.close, 0);
});
