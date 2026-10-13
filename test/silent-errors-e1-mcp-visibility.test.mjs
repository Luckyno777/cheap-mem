// test/silent-errors-e1-mcp-visibility.test.mjs - E1 of the silent-errors plan (port of lucky-mem
// `stille-fehler` E1, d0c5cd4fb): an unreadable MCP visibility journal is NOT "no client was ever seen".
//
// House rule (CLAUDE.md, commitment 2): missing, empty and broken are three states, and a read that
// FAILED is a fourth. `read()` used to answer `{ rows: [], broken: 0 }` for every read error, so a
// permission problem looked exactly like "nobody connected yet" on the dashboard.
//
// Red proof, pinned to a FIXED commit (never `git merge-base`, see the agent frame): at f4a3540 the
// unreadable and the missing journal give the same answer and `sightings()` does not exist. The proof
// runs the OLD module inside this test; its positive control is a readable row, which the old module
// reads too (so the proof cannot be red merely because the old module is broken altogether).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as vis from '../src/mcpvisibility.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = 'f4a3540';
const ROW = { ts: '2026-10-10T10:00:00.000Z', method: 'tools/call', tool: 'mem_find', client: 'probe' };

function root(t) {
  const r = tempDir('cm-e1-vis-', t);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'e1vis', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  fs.mkdirSync(path.join(r, '.pipeline'), { recursive: true });
  return r;
}
const journal = (r) => path.join(r, vis.LOG);
const put = (r, text) => fs.writeFileSync(journal(r), text);

test('POSITIVE CONTROL: one readable row is state "good" and is the newest sighting of its tool', (t) => {
  const r = root(t);
  put(r, `${JSON.stringify(ROW)}\n`);
  assert.equal(vis.read(r).state, 'good');
  assert.equal(vis.read(r).rows.length, 1);
  const s = vis.sightings(r);
  assert.equal(s.state, 'good');
  assert.equal(s.map.get('mem_find').client, 'probe');
  assert.equal(vis.latestPerTool(r).get('mem_find').client, 'probe', 'latestPerTool keeps its Map');
});

test('missing, empty and broken are three states, each on its own', (t) => {
  const r = root(t);
  assert.equal(vis.read(r).state, 'missing');
  assert.equal(vis.sightings(r).state, 'missing');
  put(r, '\n');
  assert.equal(vis.read(r).state, 'empty');
  put(r, 'not json\n{"x":1}\n');
  const b = vis.read(r);
  assert.equal(b.state, 'broken');
  assert.equal(b.broken, 2);
  assert.ok(b.reason, 'a broken journal says why');
  // one broken line next to a usable row: the journal is good, the line is still counted
  put(r, `not json\n${JSON.stringify(ROW)}\n`);
  const g = vis.read(r);
  assert.equal(g.state, 'good');
  assert.equal(g.broken, 1);
});

test('a failed read (a directory where the journal should be: EISDIR, also as root) is "unreadable" with a reason, not "empty"', (t) => {
  const r = root(t);
  fs.mkdirSync(journal(r));
  const g = vis.read(r);
  assert.equal(g.state, 'unreadable');
  assert.equal(g.reason, 'EISDIR');
  assert.deepEqual(g.rows, []);
  const s = vis.sightings(r);
  assert.equal(s.state, 'unreadable');
  assert.equal(s.map.size, 0);
  assert.equal(vis.latestPerTool(r).size, 0, 'the Map-only caller still gets a Map, never a throw');
});

test('the reason carries an error code, never a path of this machine', (t) => {
  const r = root(t);
  fs.mkdirSync(journal(r));
  assert.ok(!String(vis.read(r).reason).includes(r), 'the reason names the memory path');
});

test('RED PROOF at f4a3540: the old module answers the same for an unreadable and a missing journal (positive control: it reads a row)', async (t) => {
  const tmp = tempDir('cm-e1-old-', t);
  exportCommit(REPO, OLD, ['src', 'package.json'], tmp);
  const old = await import(`${pathToFileURL(path.join(tmp, 'src', 'mcpvisibility.mjs')).href}?t=${Math.random()}`);
  const ok = root(t); put(ok, `${JSON.stringify(ROW)}\n`);
  assert.equal(old.read(ok).rows.length, 1, 'positive control: the old module reads a readable row');
  const missing = root(t);
  const unreadable = root(t); fs.mkdirSync(path.join(unreadable, old.LOG));
  assert.deepEqual(old.read(unreadable), old.read(missing), 'the old module told the two apart');
  assert.equal('state' in old.read(unreadable), false);
  assert.equal(typeof old.sightings, 'undefined');
  // and today they differ
  assert.notEqual(vis.read(unreadable).state, vis.read(missing).state);
});

// --- /dashboard.json: the field the page reads ---

async function dashboardMcp(r) {
  const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?t=${Math.random()}`);
  const { server } = await mod.serve(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/dashboard.json`);
    assert.equal(res.status, 200);
    return (await res.json()).catalog.mcp;
  } finally { server.closeAllConnections?.(); await new Promise((done) => server.close(done)); }
}

test('/dashboard.json: good shows the sighting, missing says "missing", unreadable says "unreadable" with the code', { timeout: 30000 }, async (t) => {
  const good = root(t);
  vis.record(good, { method: 'tools/list', tool: 'mem_board', client: 'probe-client' });
  const a = await dashboardMcp(good);
  assert.equal(a.clientVisible.mem_board.client, 'probe-client', 'positive control: the sighting is shown');
  assert.equal(a.clientVisibleState.state, 'good');

  const m = await dashboardMcp(root(t));
  assert.equal(m.clientVisible.mem_board, null);
  assert.equal(m.clientVisibleState.state, 'missing');

  const un = root(t); fs.mkdirSync(journal(un));
  const u = await dashboardMcp(un);
  assert.equal(u.clientVisible.mem_board, null, 'no sighting can be claimed from an unreadable journal');
  assert.equal(u.clientVisibleState.state, 'unreadable');
  assert.equal(u.clientVisibleState.reason, 'EISDIR');
});

test('the page tells "journal unreadable" apart from "not seen yet"', () => {
  const src = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
  const at = src.indexOf('function mcpPage');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /clientVisibleState/);
  assert.match(body, /unreadable/);
  assert.match(body, /not seen yet/, 'the ordinary word stays for the healthy case');
});
