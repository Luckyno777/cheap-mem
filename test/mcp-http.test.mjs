// The network door of mem-mcp.
//
// This is a real socket probe, not a unit test of `hostAllowed`: the
// sibling service had the right guard in its source and still rejected
// the right public name because the deployment path never handed the
// configured name to the process. The guarantee belongs at the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'bin', 'mem-mcp');

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, host, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        host,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.once('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function waitUntilReady(port, child, stderr) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`mem-mcp exited ${child.exitCode}: ${stderr()}`);
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
          res.resume();
          res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
        });
        req.once('error', reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`mem-mcp did not become ready: ${stderr()}`);
}

async function withServer(fn, extraEnv = {}) {
  const memory = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mcp-http-'));
  fs.mkdirSync(path.join(memory, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(memory, '.mem', 'config.json'), JSON.stringify({ version: 1 }));
  const port = await freePort();
  let errors = '';
  const child = spawn(process.execPath, [MCP, '--http'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHEAP_MEM_ROOT: memory,
      CHEAP_MEM_MCP_PORT: String(port),
      CHEAP_MEM_MCP_HOSTS: 'memory.example.org',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    await waitUntilReady(port, child, () => errors);
    await fn(port);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    fs.rmSync(memory, { recursive: true, force: true });
  }
}

const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'socket-probe', version: '1' },
  },
};

test('a non-loopback bind without a token is refused before listening', async () => {
  const port = await freePort();
  const result = spawnSync(process.execPath, [MCP, '--http'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      CHEAP_MEM_MCP_HOST: '0.0.0.0',
      CHEAP_MEM_MCP_PORT: String(port),
    },
  });
  assert.notEqual(result.status, 0, 'an unauthenticated public listener started');
  assert.match(result.stderr, /Refusing to bind.*CHEAP_MEM_MCP_TOKEN/s);
});

test('configured public Host reaches Streamable HTTP, suffix lookalike does not', async () => {
  await withServer(async (port) => {
    const good = await request(port, 'memory.example.org', initialize);
    assert.equal(good.status, 200, good.text);
    assert.match(good.headers['content-type'] ?? '', /application\/json/);
    assert.equal(JSON.parse(good.text).result.serverInfo.name, 'cheap-mem');

    const suffix = await request(port, 'memory.example.org.attacker.invalid', initialize);
    assert.equal(suffix.status, 403, 'a suffix lookalike reached the MCP transport');
  });
});

test('HTTP is read-only unless the operator explicitly chooses full access', async () => {
  await withServer(async (port) => {
    const list = await request(port, 'memory.example.org', {
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    assert.equal(list.status, 200, list.text);
    const names = JSON.parse(list.text).result.tools.map((tool) => tool.name);
    assert.ok(names.includes('mem_find'));
    assert.ok(!names.includes('mem_log'), 'HTTP exposed a writing tool by default');
  });

  await withServer(async (port) => {
    const list = await request(port, 'memory.example.org', {
      jsonrpc: '2.0', id: 3, method: 'tools/list', params: {},
    });
    assert.equal(list.status, 200, list.text);
    const names = JSON.parse(list.text).result.tools.map((tool) => tool.name);
    assert.ok(names.includes('mem_log'), 'the documented explicit full profile did not open');
  }, { CHEAP_MEM_MCP_READONLY: '0' });
});
