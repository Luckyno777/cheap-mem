// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/dashboard-cases.test.mjs — N23: the shared dashboard test cases,
// run against THIS house's dashboard.
//
// **Decision** (2026-09-28, "common core: option 2"): the two houses share
// the SPECIFICATION and the test cases, not the code. `shared/dashboard-cases.jsonl`
// is that specification for the dashboard: one language-neutral line per
// case (state words, tones, route roles, headers, expected answers). It is
// BYTE-IDENTICAL with lucky-mem's `geteilt/dashboard-cases.jsonl`; both
// houses pin the same sha256 below, so a change in one house turns that
// house red until the other one has the same file and the same pin.
// Each house keeps its own runner, in its own language, against its own
// code: this file is cheap-mem's.
//
// What the cases cover: four states with their own tones, unknown is not
// 0 (an unmeasurable value is null, a measured zero is 0), no CORS header
// on any route, the Host check on every read route, the content security
// policy, and an empty store that is not a problem.
//
// Known difference, deliberately NOT in the cases: an absent retrieval
// journal is 'ok' here (a fresh install), but 'warnung' in lucky-mem
// ("no retrieval journal on this machine"). The empty-store case
// therefore only rules out error and unknown.
//
// invariant: vier-zustaende-eigener-ton
// invariant: kein-cors-kopf
// invariant: host-riegel-lesewege
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import vm from 'node:vm';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as data from '../src/dashboard-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const CASES_FILE = path.join(REPO, 'shared', 'dashboard-cases.jsonl');
const JS = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.css'), 'utf8');

/** The pin: the same hash stands in lucky-mem's test/dashboard-faelle.test.mjs. */
const CASES_SHA256 = 'af8b9385f28c99cc46b398678a42e78f9b23c2c2984bbe5c2db1a0f086abb1ce';
/** The neutral topic of a case -> the id of the shared invariant it serves (this house's register). */
const INVARIANT_OF = { 'four-states': 'vier-zustaende-eigener-ton', 'no-cors': 'kein-cors-kopf', 'host-check': 'host-riegel-lesewege', 'unknown-not-zero': 'nicht-messbar-ist-nicht-null', 'empty-store': 'leer-ist-kein-bestehen' };
const KINDS = ['tone', 'tone-distinct', 'tone-distinct-all', 'css-rule', 'no-cors', 'csp', 'host', 'journal', 'empty-store'];

const cases = fs.readFileSync(CASES_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// --- this house's words for the neutral vocabulary ---------------------------
const WORD = { good: 'good', warning: 'warning', error: 'error', unknown: 'unknown', 'not-measured': 'not measured' };
const DATA_WORD = { good: 'ok', warning: 'warning', error: 'error', unknown: 'unknown' };
const ROUTE = {
  page: '/dashboard', data: '/dashboard.json', entry: '/dashboard/entry.json?id=x',
  message: '/dashboard/message.json?name=x.md', probe: '/dashboard/probe.json?question=x',
  'facts-at': '/dashboard/facts-at.json?known=2026-09-28&valid=2026-09-28',
};

function badgeFn(src = JS.slice(JS.indexOf('function badge('), JS.indexOf('// The old desk\'s four board states'))) {
  return vm.runInNewContext(`(${src.trim()})`, { esc: (v) => String(v ?? '') });
}
const toneOf = (badge, state) => /class="badge ([a-z]*)"/.exec(badge(WORD[state]))?.[1];
const rule = (css, sel) => new RegExp(`${sel.replace(/\./g, '\\.')}\\{([^}]*)\\}`).exec(css)?.[1];

function memoryRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dash-cases-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'cases', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  return r;
}
async function start(root) {
  const mod = await import(`${pathToFileURL(SERVE).href}?cases=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
  return { mod, port: server.address().port, stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}
function rawGet(port, p, host, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

/**
 * One case against this house: `null` when it holds, else the reason it
 * does not. `env` carries the things a case may need (badge function,
 * running server, memory roots) so a positive control can swap one.
 */
async function check(c, env) {
  switch (c.kind) {
    case 'tone': {
      const got = toneOf(env.badge, c.state);
      return got === c.tone ? null : `${c.id}: '${c.state}' has tone '${got}', expected '${c.tone}'`;
    }
    case 'tone-distinct':
      return toneOf(env.badge, c.a) !== toneOf(env.badge, c.b) ? null : `${c.id}: '${c.a}' and '${c.b}' share a tone`;
    case 'tone-distinct-all': {
      const tones = c.states.map((s) => toneOf(env.badge, s));
      return new Set(tones).size === c.states.length ? null : `${c.id}: tones collide: ${tones.join(',')}`;
    }
    case 'css-rule': {
      const own = rule(env.css, c.selector); const other = rule(env.css, c.differs_from);
      if (!own) return `${c.id}: no CSS rule ${c.selector}`;
      return own !== other ? null : `${c.id}: ${c.selector} has the same rule as ${c.differs_from}`;
    }
    case 'no-cors': {
      const res = await rawGet(env.server.port, ROUTE[c.route], `127.0.0.1:${env.server.port}`, { origin: c.origin });
      if (res.headers['access-control-allow-origin'] !== undefined || res.headers['access-control-allow-credentials'] !== undefined) {
        return `${c.id}: ${ROUTE[c.route]} sends a CORS header`;
      }
      return [200, 404].includes(res.status) ? null : `${c.id}: ${ROUTE[c.route]} answered ${res.status} (the route did not answer at all)`;
    }
    case 'csp': {
      const res = await rawGet(env.server.port, ROUTE.page, `127.0.0.1:${env.server.port}`);
      const dir = String(res.headers['content-security-policy']).split(';').map((s) => s.trim()).find((s) => s.startsWith(`${c.directive} `));
      return dir === `${c.directive} ${c.value}` ? null : `${c.id}: policy says '${dir}'`;
    }
    case 'host': {
      const res = await rawGet(env.server.port, ROUTE[c.route], c.host.replace('{port}', String(env.server.port)));
      if (c.status === 'not-403') return res.status !== 403 ? null : `${c.id}: loopback was refused`;
      if (res.status !== c.status) return `${c.id}: answered ${res.status}, expected ${c.status}`;
      let body = {}; try { body = JSON.parse(res.body); } catch { /* not JSON */ }
      return body.state === DATA_WORD[c.state] && body.reason === c.reason ? null : `${c.id}: body is ${res.body}`;
    }
    case 'journal': {
      const root = env.root();
      memory.logEntry(root, 'learning', { title: 'probe', text: 'x' });
      const d = c.journal === 'absent' ? data.collectDashboard(root)
        : data.collectDashboard(root, { readJournal: () => ({ present: true, lines: [], broken: 0 }) });
      if (d.recall.measurable !== c.measurable) return `${c.id}: measurable is ${d.recall.measurable}`;
      const values = d.entries.map((e) => e.recall);
      if (!values.length) return `${c.id}: no entry was measured at all`;
      return c.per_entry_metric === 'null'
        ? (values.every((v) => v === null) ? null : `${c.id}: an unmeasurable value became a number`)
        : (values.every((v) => v && v.sessions === 0) ? null : `${c.id}: a measured zero is not 0`);
    }
    case 'empty-store': {
      const d = data.collectDashboard(env.root());
      const bad = c.state_not.map((s) => DATA_WORD[s]);
      return bad.includes(d.state) ? `${c.id}: an empty store reads '${d.state}'` : null;
    }
    default: return `${c.id}: unknown kind '${c.kind}' — a case nobody runs is not a pass`;
  }
}

// --- the file itself --------------------------------------------------------

test('the shared cases are byte-identical with the sibling house (pinned sha256)', () => {
  const sha = createHash('sha256').update(fs.readFileSync(CASES_FILE)).digest('hex');
  assert.equal(sha, CASES_SHA256, 'shared/dashboard-cases.jsonl changed: update the pin here AND lucky-mem\'s copy and pin together');
});

test('the shared cases are not empty, every kind is used, every case topic leads to a real invariant', () => {
  assert.ok(cases.length >= 30, `only ${cases.length} cases`);
  for (const k of KINDS) assert.ok(cases.some((c) => c.kind === k), `kind '${k}' has no case`);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'duplicate case id');
  const invariants = new Set(fs.readFileSync(path.join(REPO, 'shared', 'invariants.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id));
  for (const c of cases) assert.ok(invariants.has(INVARIANT_OF[c.topic]), `${c.id}: topic '${c.topic}' does not lead to a known invariant`);
  for (const id of Object.values(INVARIANT_OF)) assert.ok(invariants.has(id), `invariant '${id}' is missing from shared/invariants.jsonl`);
  for (const c of cases) assert.ok(KINDS.includes(c.kind), `${c.id}: kind '${c.kind}' has no runner`);
});

// --- every case, against this dashboard ------------------------------------------

test('every shared case holds on this house\'s dashboard', async () => {
  const roots = [];
  const root = () => { const r = memoryRoot(); roots.push(r); return r; };
  const serverRoot = root();
  const server = await start(serverRoot);
  try {
    const env = { badge: badgeFn(), css: CSS, server, root };
    const failures = [];
    for (const c of cases) { const f = await check(c, env); if (f) failures.push(f); }
    assert.deepEqual(failures, [], `${failures.length} of ${cases.length} shared cases fail`);
  } finally { await server.stop(); for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); }
});

// --- positive controls: the runner really sees a broken dashboard ------------------

test('positive control: a badge that files unknown under the warning tone fails the tone cases', async () => {
  const src = JS.slice(JS.indexOf('function badge('), JS.indexOf('// The old desk\'s four board states'))
    .replace("['unknown', 'not seen'", "['__none__'").replace("'off', 'known_partial'", "'off', 'unknown', 'known_partial'");
  const env = { badge: badgeFn(src), css: CSS };
  const failed = [];
  for (const c of cases.filter((x) => ['tone', 'tone-distinct'].includes(x.kind))) if (await check(c, env)) failed.push(c.id);
  assert.ok(failed.includes('tone-unknown') && failed.includes('tone-unknown-is-not-warning'), `sabotage not seen: ${failed}`);
});

test('positive control: a CSS without the unknown rule, a wrong expectation and an unknown kind all fail', async () => {
  const env = { badge: badgeFn(), css: CSS.replace(/\.badge\.unknown\{/g, '.badge.nothing{') };
  assert.ok(await check(cases.find((c) => c.id === 'css-unknown-own-rule'), env), 'missing CSS rule not seen');
  assert.ok(await check({ ...cases.find((c) => c.id === 'tone-warning'), tone: 'good' }, { badge: badgeFn(), css: CSS }), 'a wrong expectation passed');
  assert.ok(await check({ id: 'x', kind: 'made-up' }, env), 'an unknown kind passed');
});

test('positive control: a server that sends a CORS header, or serves a foreign Host, fails the route cases', async () => {
  const fake = http.createServer((req, res) => res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/json' }).end('{}'));
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const env = { server: { port: fake.address().port } };
  try {
    assert.ok(await check(cases.find((c) => c.id === 'no-cors-data'), env), 'a CORS header was not seen');
    assert.ok(await check(cases.find((c) => c.id === 'host-data-foreign'), env), 'a foreign Host served 200 and passed');
  } finally { fake.closeAllConnections?.(); await new Promise((r) => fake.close(r)); }
});
