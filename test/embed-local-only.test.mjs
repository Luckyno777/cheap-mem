// test/embed-local-only.test.mjs — no entry text goes to an embedding vendor.
//
// Owner decision, 2026-10-13: not even masked, in both houses. Voyage and
// OpenAI are gone; the one embedding path left is a model on THIS machine
// (ollama on a loopback address). This file proves:
//
//   1. an old voyage/openai setup makes NO network call, says so out
//      loud, and the search falls back to lexical search (never silent)
//   2. ollama on a loopback address works; ollama on any other host is
//      refused before a socket is opened
//   3. a rail: a new network adapter in src/embed/ turns a test red
//
// Red proof (BUILDING.md rule 3), taken on the code BEFORE this change:
// with `.mem/embed.json` = {"provider":"voyage"} (or "openai") and a key in
// the environment, `embed.embed(root, text)` called fetch() on
// https://api.voyageai.com/v1/embeddings (resp. api.openai.com) with the
// entry text in the body and the key in the Authorization header. The
// probes below are the same calls; they now see zero.
//
// No real network, no real key: fetch/http are replaced by recorders, the
// ollama side is a stub server on 127.0.0.1, and every key-shaped value is
// built at run time.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as embed from '../src/embed/index.mjs';
import * as loopback from '../src/embed/loopback.mjs';
import * as embedHook from '../src/embed-hook.mjs';
import * as hybrid from '../src/hybrid.mjs';
import * as memory from '../src/memory.mjs';
import { buildIndex } from '../src/search.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const SENTENCE = 'external embedding providers are disabled: no entry text leaves this machine; using lexical search';

// Key-shaped values, built at run time so no literal in this file looks like a secret.
const fakeKey = (prefix) => `${prefix}-${'q'.repeat(36)}`;
const SECRET_TEXT = 'ENTRY-TEXT-THAT-MUST-STAY-HOME the customer was unhappy about invoice 4711';

function memRoot(t, embedJson = undefined) {
  const root = tempDir('cm-embed-local-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  if (embedJson !== undefined) {
    fs.writeFileSync(path.join(root, '.mem', 'embed.json'),
      typeof embedJson === 'string' ? embedJson : JSON.stringify(embedJson));
  }
  return root;
}

/**
 * Record every way text could leave this process: fetch, http(s).request/get.
 * `passHttp` lets http.request through (for the positive control and the
 * stub server), still recording it.
 */
function spyNetwork(t, { passHttp = false } = {}) {
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ via: 'fetch', url: String(url), body: String(opts?.body ?? '') }); throw new Error('network is closed in this test'); };
  const origRequest = http.request;
  const wrap = (via, orig) => (...a) => {
    const o = a[0];
    calls.push({ via, host: typeof o === 'object' && !(o instanceof URL) ? o.host ?? o.hostname : String(o) });
    if (passHttp && via === 'http.request') return orig.apply(http, a);
    throw new Error('network is closed in this test');
  };
  mock.method(http, 'request', wrap('http.request', origRequest));
  mock.method(http, 'get', wrap('http.get', http.get));
  mock.method(https, 'request', wrap('https.request', https.request));
  mock.method(https, 'get', wrap('https.get', https.get));
  t.after(() => { globalThis.fetch = savedFetch; mock.restoreAll(); });
  return calls;
}

function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

function stubOllama(t, { dim = 768 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ embedding: new Array(dim).fill(0.25) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => { server.close(r); }));
      resolve({ port: server.address().port, seen });
    });
  });
}

// --- 1. Old external setups: no network, loud, lexical -------------------

for (const provider of ['voyage', 'openai']) {
  test(`${provider}: embed() refuses, makes no network call, and keeps the key out of everything`, async (t) => {
    const root = memRoot(t, { provider });
    const key = fakeKey(provider === 'voyage' ? 'pa' : 'sk');
    withEnv(t, { VOYAGE_API_KEY: key, OPENAI_API_KEY: key });
    fs.writeFileSync(path.join(root, '.mem', 'embed.env'), `VOYAGE_API_KEY=${key}\nOPENAI_API_KEY=${key}\n`);
    const calls = spyNetwork(t);
    await assert.rejects(embed.embed(root, SECRET_TEXT), (e) => {
      assert.equal(e.code, 'EXTERNAL_DISABLED');
      assert.ok(e.message.includes(SENTENCE), e.message);
      assert.ok(!e.message.includes(key), 'the key must never appear in a message');
      return true;
    });
    assert.deepEqual(calls, [], 'text went to the network');
  });
}

test('an embed.json without a provider meant voyage once: it is refused too, not guessed', async (t) => {
  const root = memRoot(t, {});
  const calls = spyNetwork(t);
  const st = await embed.embedState(root);
  assert.equal(st.state, 'rejected');
  await assert.rejects(embed.embed(root, SECRET_TEXT), { code: 'EXTERNAL_DISABLED' });
  assert.deepEqual(calls, []);
});

test('any other provider name is refused as well (a typo or a new vendor), not "unknown"', async (t) => {
  const calls = spyNetwork(t);
  for (const provider of ['cohere', 'gemini', 'ollma', 'OLLAMA', '']) {
    const root = memRoot(t, { provider });
    const st = await embed.embedState(root);
    assert.equal(st.state, 'rejected', `provider ${JSON.stringify(provider)}`);
    assert.ok(st.message.endsWith(SENTENCE));
    await assert.rejects(embed.embed(root, SECRET_TEXT), { code: 'EXTERNAL_DISABLED' });
  }
  assert.deepEqual(calls, []);
});

test('embedState: not configured / local / rejected / broken are four different answers', async (t) => {
  const none = memRoot(t);
  assert.equal((await embed.embedState(none)).state, 'not-configured');
  assert.match((await embed.embedState(none)).message, /not configured.*lexical search/);

  const local = memRoot(t, { provider: 'ollama' });
  const st = await embed.embedState(local, { env: { OLLAMA_HOST: 'http://127.0.0.1:11434' } });
  assert.equal(st.state, 'local');
  assert.equal(st.endpoint, '127.0.0.1:11434');

  const remote = await embed.embedState(local, { env: { OLLAMA_HOST: 'http://embeddings.example.test:11434' } });
  assert.equal(remote.state, 'rejected');
  assert.equal(remote.reason, 'remote-endpoint');
  assert.ok(remote.message.endsWith(SENTENCE));
  assert.ok(remote.message.includes('embeddings.example.test'));

  const ext = await embed.embedState(memRoot(t, { provider: 'voyage' }));
  assert.equal(ext.state, 'rejected');
  assert.equal(ext.reason, 'removed-provider');

  const broken = await embed.embedState(memRoot(t, '{ not json'));
  assert.equal(broken.state, 'broken');
  assert.match(broken.message, /not valid JSON.*lexical search/);
});

test('writeConfig will not write an external provider', (t) => {
  const root = memRoot(t);
  assert.throws(() => embed.writeConfig(root, { ...embed.DEFAULTS, provider: 'voyage' }), { code: 'EXTERNAL_DISABLED' });
  assert.ok(!fs.existsSync(path.join(root, '.mem', 'embed.json')));
  embed.writeConfig(root, { ...embed.DEFAULTS, provider: 'ollama' }); // control: the local one is writable
  assert.ok(fs.existsSync(path.join(root, '.mem', 'embed.json')));
});

test('the entry hook refuses an external setup before it embeds anything', async (t) => {
  const root = memRoot(t, { provider: 'voyage' });
  const calls = spyNetwork(t);
  const r = await embedHook.embedEntry(root, path.join(root, 'global', 'learnings.jsonl'), 1,
    { id: 'x1', ts: '2026-10-13T00:00:00Z', title: 'a title', text: SECRET_TEXT });
  assert.equal(r.status, 'rejected');
  assert.ok(r.detail.endsWith(SENTENCE));
  assert.deepEqual(calls, []);
});

test('hybrid: an external setup yields no ranker and says why; a failing ranker is reported, not swallowed', async (t) => {
  const root = memRoot(t, { provider: 'openai' });
  const calls = spyNetwork(t);
  const plan = await hybrid.semanticPlan(root);
  assert.equal(plan.state, 'rejected');
  assert.equal(plan.rank, null);
  assert.equal(await hybrid.makeSemantic(root), null);
  assert.deepEqual(calls, []);

  const mem = memRoot(t);
  memory.logEntry(mem, 'learning', { title: 'redis cache for the catalog', text: 'x' });
  const idx = buildIndex(mem, { language: 'en' });
  const seen = [];
  const res = await hybrid.hybridSearch(idx, 'redis cache', {
    semantic: async () => { throw new Error('local model down'); },
    onSemanticError: (e) => seen.push(e.message),
  });
  assert.ok(res.length > 0, 'lexical results still come');
  assert.deepEqual(seen, ['local model down']);
});

// --- 2. ollama: loopback yes, anything else no --------------------------

test('ollama on a loopback address works, over a stub server (positive control: the spy sees the call)', async (t) => {
  const { port, seen } = await stubOllama(t);
  const root = memRoot(t, { provider: 'ollama' });
  withEnv(t, { OLLAMA_HOST: `http://127.0.0.1:${port}` });
  const calls = spyNetwork(t, { passHttp: true });
  const vec = await embed.embed(root, 'hello local model');
  assert.equal(vec.length, 768);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/embeddings');
  assert.equal(JSON.parse(seen[0].body).prompt, 'hello local model');
  assert.deepEqual(calls.map((c) => [c.via, c.host]), [['http.request', '127.0.0.1']]);
});

test('ollama without a scheme (host:port) is read as http', async (t) => {
  const { port, seen } = await stubOllama(t);
  const root = memRoot(t, { provider: 'ollama' });
  withEnv(t, { OLLAMA_HOST: `127.0.0.1:${port}` });
  await embed.embed(root, 'no scheme');
  assert.equal(seen.length, 1);
});

const REMOTE_HOSTS = [
  'http://embeddings.example.test:11434',
  'http://localhost.example.test:11434',
  'http://127.0.0.1.example.test:11434',
  'http://192.168.1.20:11434',
  'http://10.0.0.5:11434',
  'http://172.16.0.9',
  'http://169.254.169.254',
  'http://0.0.0.0:11434',
  'http://8.8.8.8:11434',
  'http://[::ffff:8.8.8.8]:11434',
  'http://[2001:db8::1]:11434',
  'https://127.0.0.1:11434',
  'ftp://127.0.0.1:11434',
  'http://user:pass@127.0.0.1:11434',
  'http://127.0.0.1@embeddings.example.test:11434',
  'not a url at all',
];

for (const host of REMOTE_HOSTS) {
  test(`ollama host ${JSON.stringify(host)} is refused: no socket, no text, loud`, async (t) => {
    const root = memRoot(t, { provider: 'ollama' });
    withEnv(t, { OLLAMA_HOST: host });
    const calls = spyNetwork(t);
    await assert.rejects(embed.embed(root, SECRET_TEXT), (e) => {
      assert.equal(e.code, 'EXTERNAL_DISABLED');
      assert.ok(e.message.includes(SENTENCE), e.message);
      assert.ok(!e.message.includes('pass@'), 'credentials must not be echoed');
      return true;
    });
    assert.deepEqual(calls, [], 'a socket was opened');
    assert.equal((await embed.embedState(root)).state, 'rejected');
  });
}

test('loopback.isLoopbackAddress: the whole 127/8, ::1 and mapped forms; nothing else', () => {
  for (const a of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:0:0:1']) {
    assert.equal(loopback.isLoopbackAddress(a), true, a);
  }
  for (const a of ['0.0.0.0', '128.0.0.1', '126.255.255.255', '10.0.0.1', '192.168.0.1', '::', '::2', '::ffff:8.8.8.8',
    '::ffff:0808:0808', '2130706433', 'localhost', '127.0.0', '']) {
    assert.equal(loopback.isLoopbackAddress(a), false, a);
  }
});

test('loopback.checkEndpoint: only the name localhost is ever resolved, and every answer must be loopback', async () => {
  let resolved = [];
  const lookup = (answer) => async (name) => { resolved.push(name); if (answer instanceof Error) throw answer; return answer; };

  let r = await loopback.checkEndpoint('http://localhost:11434', { lookup: lookup([{ address: '127.0.0.1' }]) });
  assert.deepEqual([r.ok, r.address, r.port], [true, '127.0.0.1', 11434]);

  // IPv6-only localhost is fine, and the connection goes to the address, not the name.
  r = await loopback.checkEndpoint('http://localhost', { lookup: lookup([{ address: '::1' }]) });
  assert.deepEqual([r.ok, r.address, r.port], [true, '::1', 80]);

  // A poisoned resolver: one loopback answer does not launder a second, public one.
  r = await loopback.checkEndpoint('http://localhost:11434', { lookup: lookup([{ address: '127.0.0.1' }, { address: '93.184.216.34' }]) });
  assert.equal(r.ok, false);
  r = await loopback.checkEndpoint('http://localhost:11434', { lookup: lookup([{ address: '93.184.216.34' }]) });
  assert.equal(r.ok, false);
  r = await loopback.checkEndpoint('http://localhost:11434', { lookup: lookup(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) });
  assert.equal(r.ok, false);

  // Other names are refused WITHOUT being resolved, even when they would resolve to loopback.
  resolved = [];
  for (const h of ['http://evil.example.test', 'http://localhost.', 'http://foo.localhost', 'http://LOCALHOST.evil.test']) {
    // (`http://localhost.` has a trailing dot: a different name, not trusted)
    const x = await loopback.checkEndpoint(h, { lookup: lookup([{ address: '127.0.0.1' }]) });
    assert.equal(x.ok, false, h);
  }
  assert.deepEqual(resolved, [], 'a host name other than localhost was resolved');

  // Odd spellings of 127.0.0.1 are normalised by URL parsing and accepted as what they are.
  for (const h of ['http://2130706433:11434', 'http://127.1:11434', 'http://0x7f.0.0.1:11434', 'http://[::1]:11434']) {
    const x = await loopback.checkEndpoint(h);
    assert.equal(x.ok, true, h);
  }
  // ... and the display host carries no credentials.
  const shown = await loopback.checkEndpoint('http://u:p@evil.example.test:1/x?y=z');
  assert.equal(shown.ok, false);
  assert.ok(!/u:p|\/x|y=z/.test(shown.host), shown.host);
});

test('ollama never follows a redirect: a local server cannot bounce the text elsewhere', async (t) => {
  let hits = 0;
  const target = http.createServer((_req, res) => { hits += 1; res.end('{}'); });
  await new Promise((r) => { target.listen(0, '127.0.0.1', r); });
  t.after(() => new Promise((r) => { target.close(r); }));
  const bouncer = http.createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/elsewhere` });
    res.end();
  });
  await new Promise((r) => { bouncer.listen(0, '127.0.0.1', r); });
  t.after(() => new Promise((r) => { bouncer.close(r); }));
  const root = memRoot(t, { provider: 'ollama' });
  withEnv(t, { OLLAMA_HOST: `http://127.0.0.1:${bouncer.address().port}` });
  await assert.rejects(embed.embed(root, SECRET_TEXT), /HTTP 307/);
  assert.equal(hits, 0);
});

// --- 3. The command line: loud, lexical, nothing sent ---------------------

/** A preload that records and refuses every outbound call; the log says what was tried. */
function blocker(t) {
  const dir = tempDir('cm-embed-block-', t);
  const log = path.join(dir, 'net.log');
  const file = path.join(dir, 'block.mjs');
  fs.writeFileSync(file, [
    "import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';",
    'const note = (v) => fs.appendFileSync(process.env.EMBED_NET_LOG, v + "\\n");',
    "globalThis.fetch = async (u) => { note('fetch ' + u); throw new Error('blocked'); };",
    "for (const [m, k] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect'], [tls, 'connect']]) {",
    "  m[k] = (...a) => { note(k + ' ' + JSON.stringify(a[0]?.host ?? a[0])); throw new Error('blocked'); };",
    '}',
  ].join('\n'));
  return { log, options: `--import=${pathToFileURL(file).href}` };
}

function cliWorld(t, embedJson) {
  const root = memRoot(t);
  const init = spawnSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  memory.logEntry(root, 'learning', { title: 'complaint received about invoice 4711', text: 'the customer wrote in' });
  if (embedJson !== undefined) {
    fs.writeFileSync(path.join(root, '.mem', 'embed.json'),
      typeof embedJson === 'string' ? embedJson : JSON.stringify(embedJson));
  }
  const b = blocker(t);
  const run = (argv, env = {}) => {
    const r = spawnSync('node', [MEM, '--root', root, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, VOYAGE_API_KEY: '', OPENAI_API_KEY: '', OLLAMA_HOST: '', NODE_OPTIONS: b.options, EMBED_NET_LOG: b.log, ...env },
    });
    return { ...r, all: `${r.stdout}${r.stderr}` };
  };
  const netLog = () => (fs.existsSync(b.log) ? fs.readFileSync(b.log, 'utf8') : '');
  return { root, run, netLog };
}

for (const cmd of ['find-hybrid', 'find-embed']) {
  for (const provider of ['voyage', 'openai']) {
    test(`mem ${cmd} with provider ${provider}: refused out loud on stderr, lexical hits, label says REFUSED, no network`, (t) => {
      const w = cliWorld(t, { provider });
      const r = w.run([cmd, 'complaint invoice'], { VOYAGE_API_KEY: fakeKey('pa'), OPENAI_API_KEY: fakeKey('sk') });
      assert.equal(r.status, 0, r.all);
      assert.ok(r.stderr.includes(SENTENCE), `stderr: ${r.stderr}`);
      assert.match(r.stdout, /lexical only — REFUSED: /);
      assert.match(r.stdout, /complaint received about invoice 4711/, 'the lexical hit is there');
      assert.equal(w.netLog(), '', 'something tried to reach the network');
      assert.ok(!r.all.includes(fakeKey('pa')) && !r.all.includes(fakeKey('sk')), 'a key leaked into the output');
    });
  }
}

test('mem find-hybrid with a remote ollama host: refused with the host named, no network', (t) => {
  const w = cliWorld(t, { provider: 'ollama' });
  const r = w.run(['find-hybrid', 'complaint invoice'], { OLLAMA_HOST: 'http://embeddings.example.test:11434' });
  assert.equal(r.status, 0, r.all);
  assert.ok(r.stderr.includes(SENTENCE), r.stderr);
  assert.match(r.stderr, /embeddings\.example\.test:11434/);
  assert.match(r.stdout, /lexical only — REFUSED/);
  assert.equal(w.netLog(), '');
});

test('mem find-hybrid / find-embed not configured: a different, quiet-but-visible state (no REFUSED, no stderr alarm)', (t) => {
  const w = cliWorld(t);
  for (const cmd of ['find-hybrid', 'find-embed']) {
    const r = w.run([cmd, 'complaint invoice']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /lexical only — semantic search is not configured/);
    assert.doesNotMatch(r.all, /REFUSED|disabled/);
    assert.match(r.stdout, /complaint received about invoice 4711/);
  }
  assert.equal(w.netLog(), '');
});

test('mem find-hybrid with a configured local ollama that is not running: bm25 results, the failure named', (t) => {
  const w = cliWorld(t, { provider: 'ollama' });
  // A port nobody listens on, loopback: the connect attempt is the blocked one here,
  // which is the point: the failure is reported, not turned into "no hits".
  const r = w.run(['find-hybrid', 'complaint invoice'], { OLLAMA_HOST: 'http://127.0.0.1:9' });
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /bm25 only — local semantic search failed/);
  assert.match(r.stderr, /semantic search failed/);
  assert.match(r.stdout, /complaint received about invoice 4711/);
});

test('mem embed setup --provider voyage|openai: refused, nothing written; the default is the local one', (t) => {
  const w = cliWorld(t);
  for (const p of ['voyage', 'openai']) {
    const r = w.run(['embed', 'setup', '--provider', p]);
    assert.notEqual(r.status, 0, r.all);
    assert.ok(r.all.includes('external embedding providers are disabled: no entry text leaves this machine'), r.all);
    assert.ok(!fs.existsSync(path.join(w.root, '.mem', 'embed.json')), 'a config was written for an external provider');
  }
  const ok = w.run(['embed', 'setup']);
  assert.equal(ok.status, 0, ok.all);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.root, '.mem', 'embed.json'), 'utf8')).provider, 'ollama');
  assert.equal(w.netLog(), '');
});

test('mem embed backfill with an external setup: refused, exit 2, and --force deletes nothing', (t) => {
  const w = cliWorld(t, { provider: 'voyage' });
  const db = path.join(w.root, '.mem', 'vectors.db');
  fs.writeFileSync(db, 'stand-in for vectors an external provider made earlier');
  for (const argv of [['embed', 'backfill'], ['embed', 'backfill', '--force']]) {
    const r = w.run(argv);
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /Backfill refused: .*external embedding providers are disabled/);
    assert.match(r.stderr, /nothing was deleted/);
    assert.equal(fs.readFileSync(db, 'utf8'), 'stand-in for vectors an external provider made earlier', 'the store was touched');
  }
  assert.equal(w.netLog(), '');
});

test('mem embed backfill --force with a local setup moves a store it cannot vouch for aside; it never deletes it', (t) => {
  const w = cliWorld(t, { provider: 'ollama' });
  const db = path.join(w.root, '.mem', 'vectors.db');
  fs.writeFileSync(db, 'stand-in for vectors an external provider made earlier');
  w.run(['embed', 'backfill', '--force'], { OLLAMA_HOST: 'http://127.0.0.1:9' }); // the exit code depends on whether sqlite is installed here
  assert.ok(!fs.existsSync(db), 'the old store is still in the way');
  const kept = path.join(w.root, '.mem', 'local', 'kept-vectors', 'vectors.db');
  assert.equal(fs.readFileSync(kept, 'utf8'), 'stand-in for vectors an external provider made earlier', 'the old store was not kept');
});

test('mem embed status: names the state, ignores old key variables without printing them', (t) => {
  const w = cliWorld(t, { provider: 'voyage' });
  fs.writeFileSync(path.join(w.root, '.mem', 'embed.env'), `VOYAGE_API_KEY=${fakeKey('pa')}\n`);
  const r = w.run(['embed', 'status'], { VOYAGE_API_KEY: fakeKey('pa') });
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /state:\s+rejected/);
  assert.match(r.stdout, /REFUSED:.*external embedding providers are disabled/);
  assert.match(r.stdout, /ignored:\s+VOYAGE_API_KEY is set/);
  assert.match(r.stdout, /ignored:\s+\.mem\/embed\.env exists/);
  assert.ok(!r.all.includes(fakeKey('pa')), 'the key value was printed');
  assert.equal(w.netLog(), '');
});

// --- 4. The rail: a new network adapter in src/embed/ is not quietly accepted

const EMBED_DIR = path.join(REPO, 'src', 'embed');

/** What each file in src/embed/ may do. A file not listed here may do nothing, and its existence is a finding. */
const ALLOWED = {
  'index.mjs': { imports: ['node:fs', 'node:path', './loopback.mjs'], dynamic: ['./ollama.mjs'] },
  'loopback.mjs': { imports: ['node:net', 'node:dns/promises'], dynamic: [] },
  'ollama.mjs': { imports: ['node:http', './loopback.mjs'], dynamic: [] },
  'store.mjs': { imports: ['node:fs', 'node:path', '../memory.mjs'], dynamic: ['better-sqlite3', 'sqlite-vec'] },
};

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

/** Findings in a directory of adapters; empty means clean. */
function railFindings(dir, allowed = ALLOWED) {
  const found = [];
  for (const name of fs.readdirSync(dir).filter((n) => !n.startsWith('.'))) {
    const rule = allowed[name];
    if (!rule) { found.push(`${name}: a file in src/embed/ that is not on the allowlist — a new adapter is a decision for the owner, not a drive-by`); continue; }
    const code = stripComments(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const m of code.matchAll(/\bimport\s+(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
      if (!rule.imports.includes(m[1])) found.push(`${name}: import of '${m[1]}' is not allowed here`);
    }
    for (const m of code.matchAll(/\bimport\(\s*([^)]*)\)/g)) {
      const spec = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (!rule.dynamic.includes(spec)) found.push(`${name}: dynamic import(${m[1]}) is not allowed here`);
    }
    if (/\brequire\s*\(/.test(code)) found.push(`${name}: require() is not allowed`);
    for (const pat of [/\bfetch\s*\(/, /\bWebSocket\b/, /\bXMLHttpRequest\b/, /\bEventSource\b/, /\bchild_process\b/, /\bspawn(Sync)?\s*\(/, /(?<![.\w])exec(Sync|File)?\s*\(/, /\bnavigator\.sendBeacon\b/]) {
      if (pat.test(code)) found.push(`${name}: ${pat} is not allowed in src/embed/`);
    }
    for (const m of code.matchAll(/\bhttps?:\/\/([^\s'"`/:?#$]+|\[[^\]]*\])/gi)) {
      if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(m[1])) found.push(`${name}: URL literal to host '${m[1]}'`);
    }
  }
  return found;
}

test('rail: src/embed/ holds exactly the local adapter and its helpers, none of them reaching anywhere else', () => {
  assert.deepEqual(railFindings(EMBED_DIR), []);
  assert.deepEqual(fs.readdirSync(EMBED_DIR).sort(), Object.keys(ALLOWED).sort());
  assert.deepEqual([...embed.LOCAL_PROVIDERS], ['ollama']);
  assert.deepEqual(embed.knownProviders(), ['ollama']);
});

test('rail, red proof: a planted vendor adapter, a fetch, an https import and a remote URL are each caught', (t) => {
  const dir = tempDir('cm-embed-rail-', t);
  for (const n of Object.keys(ALLOWED)) fs.copyFileSync(path.join(EMBED_DIR, n), path.join(dir, n));
  assert.deepEqual(railFindings(dir), [], 'control: the real files are clean');

  fs.writeFileSync(path.join(dir, 'cohere.mjs'), "export async function embed(t) { return fetch('https://api.cohere.example/v1/embed', { body: t }); }\n");
  let f = railFindings(dir);
  assert.ok(f.some((x) => x.startsWith('cohere.mjs: a file in src/embed/ that is not on the allowlist')), f.join('\n'));

  // The same code smuggled into an allowlisted file is caught by content.
  fs.rmSync(path.join(dir, 'cohere.mjs'));
  fs.appendFileSync(path.join(dir, 'ollama.mjs'), "\nexport const leak = (t) => fetch('https://api.cohere.example/v1/embed', { body: t });\n");
  f = railFindings(dir);
  assert.ok(f.some((x) => /fetch/.test(x)), f.join('\n'));
  assert.ok(f.some((x) => /api\.cohere\.example/.test(x)), f.join('\n'));

  fs.copyFileSync(path.join(EMBED_DIR, 'ollama.mjs'), path.join(dir, 'ollama.mjs'));
  fs.appendFileSync(path.join(dir, 'ollama.mjs'), "\nimport https from 'node:https';\nexport const h = () => import('undici');\n");
  f = railFindings(dir);
  assert.ok(f.some((x) => /node:https/.test(x)), f.join('\n'));
  assert.ok(f.some((x) => /undici/.test(x)), f.join('\n'));

  // A URL in a comment is documentation, not a destination.
  fs.copyFileSync(path.join(EMBED_DIR, 'ollama.mjs'), path.join(dir, 'ollama.mjs'));
  fs.appendFileSync(path.join(dir, 'ollama.mjs'), '\n// see https://docs.example.test/ollama\n');
  assert.deepEqual(railFindings(dir), []);
});

test('rail: no vendor endpoint is spelled anywhere in the shipped code', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/api\.voyageai\.com|api\.openai\.com/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
    }
  };
  for (const d of ['src', 'bin', 'hooks', 'install', 'assets']) walk(path.join(REPO, d));
  assert.deepEqual(hits, []);
});

test('the removed adapters are gone, not just unreferenced', () => {
  for (const n of ['voyage.mjs', 'openai.mjs']) assert.ok(!fs.existsSync(path.join(EMBED_DIR, n)), n);
});
