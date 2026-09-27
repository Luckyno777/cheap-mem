// test/astra-tasks.test.mjs — E1.7 (cheap-mem): the "long jobs" panel.
//
// `src/tasks.mjs` and the `/task` routes existed before this probe, but
// only as JSON: nothing on the desk showed that a task could be started,
// whether one ran, or how the last one ended. Built but out of reach —
// the class this project keeps finding. These probes check the panel
// that closes that gap, against the real `collect()` → `renderHtml()`
// path and the real server, not a hand-built fixture:
//   1. the data: `dashboard.collect()` carries both kinds and their
//      latest state, read through `tasks.overview()` (no second source);
//   2. the markup: the Settings view shows one card per kind, with a
//      no-JS start form, a cancel form only while something runs, and
//      honest words for "never started" and "no longer tracked";
//   3. read-only: every button disabled, and the page says why;
//   4. the form round trip: a browser POST with `from=/` gets a 303 back
//      to the desk rather than raw JSON, while the JSON contract for
//      callers without `from` is unchanged;
//   5. brand: the panel carries nothing of the sibling project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as dashboard from '../src/dashboard.mjs';
import * as astra from '../src/astra.mjs';
import * as tasks from '../src/tasks.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-astra-tasks-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.mkdirSync(path.join(r, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'tasks', participants: ['someone'], language: 'en' }));
  return r;
}
function gone(r) { fs.rmSync(r, { recursive: true, force: true }); }

/** Only the Settings view's section of the page. */
function setSection(html) {
  const m = /<section id="v-set"[\s\S]*?<\/section>/.exec(html);
  assert.ok(m, 'the page has no Settings section');
  return m[0];
}

/** A finished task written the way `tasks.start()` writes one. */
function writeTask(root, id, lines) {
  fs.mkdirSync(path.join(root, '.mem', 'tasks'), { recursive: true });
  fs.writeFileSync(tasks.statePath(root, id), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('collect() carries both kinds and their latest state (null = never started)', () => {
  const r = world();
  try {
    const d = dashboard.collect(r);
    assert.ok(d.tasks, 'collect() has no tasks field');
    assert.deepEqual(d.tasks.kinds.map((k) => k.kind).sort(), Object.keys(tasks.KINDS).sort());
    for (const k of d.tasks.kinds) {
      assert.equal(k.title, tasks.KINDS[k.kind].title, 'title retyped instead of read from KINDS');
      assert.equal(d.tasks.latest[k.kind], null);
    }
  } finally { gone(r); }
});

test('the Settings view shows one card per kind, each with a start form', () => {
  const r = world();
  try {
    const { html } = astra.build(r, { title: 'desk' });
    const s = setSection(html);
    assert.match(s, /Long jobs/);
    for (const [kind, spec] of Object.entries(tasks.KINDS)) {
      assert.ok(s.includes(spec.title), `no card for ${kind}`);
      assert.match(s, new RegExp(`<form[^>]*action="/task"[\\s\\S]*?name="kind" value="${kind}"`),
        `no start form for ${kind}`);
    }
    assert.match(s, /never started/);
    // Nothing runs, so there is nothing to cancel.
    assert.doesNotMatch(s, /action="\/task\/cancel"/);
  } finally { gone(r); }
});

test('a finished task shows its state, its time and its reason — a warning stays a warning', () => {
  const r = world();
  try {
    writeTask(r, 'aaaaaaaaaaaaaaaa', [
      { event: 'started', kind: 'integrity', ts: '2026-09-27T08:00:00.000Z', serverEpoch: 'x', command: ['mem', 'chain'] },
      { event: 'result', ts: '2026-09-27T08:00:02.000Z', state: 'warning', reason: 'no seal has ever been written', result: {} },
    ]);
    const d = dashboard.collect(r);
    assert.equal(d.tasks.latest.integrity.state, 'warning');
    const s = setSection(astra.renderHtml(d, { title: 'desk' }));
    assert.match(s, /warning/);
    assert.match(s, /no seal has ever been written/);
    assert.match(s, /2026-09-27T08:00:02/);
  } finally { gone(r); }
});

test('a task left behind by a restarted server reads "no longer tracked", never "running"', () => {
  const r = world();
  try {
    writeTask(r, 'bbbbbbbbbbbbbbbb', [
      { event: 'started', kind: 'export', ts: '2026-09-27T08:00:00.000Z', serverEpoch: 'an-old-server', command: ['mem'] },
    ]);
    const s = setSection(astra.build(r, { title: 'desk' }).html);
    assert.match(s, /no longer tracked/);
    assert.doesNotMatch(s, /action="\/task\/cancel"/);
  } finally { gone(r); }
});

test('read only: every task button is disabled and the panel says why', () => {
  const r = world();
  try {
    const s = setSection(astra.build(r, { title: 'desk', writable: false }).html);
    const panel = s.slice(s.indexOf('Long jobs'));
    const buttons = panel.match(/<button[^>]*>/g) || [];
    assert.ok(buttons.length >= 2, 'the probe found no buttons — it measures nothing');
    for (const b of buttons) assert.match(b, /disabled/, `enabled in read-only mode: ${b}`);
    assert.match(panel, /READ ONLY/);
  } finally { gone(r); }
});

test('brand: the panel carries nothing of the sibling project', () => {
  const r = world();
  try {
    const s = setSection(astra.build(r, { title: 'desk' }).html);
    assert.ok(s.includes('Long jobs'), 'no panel — this probe would pass on nothing');
    const panel = s.slice(s.indexOf('Long jobs'));
    assert.doesNotMatch(panel, /lucky|vorgang|marke\.mjs/i);
  } finally { gone(r); }
});

// --- the form round trip ------------------------------------------------

const DOOR = ['probe', 'door', String(process.pid)].join('-');
const WITH_DOOR = { authorization: `Bearer ${DOOR}` };

// Writing is off by default since 2026-09-27 (`src/writegate.mjs`);
// this file probes the form round trip BEHIND the switch, so it turns
// the switch on for its run. The switch itself is probed in
// test/writegate.test.mjs.
async function serve(root) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0',
  }, { allowWrites: true });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}

async function waitEnded(base) {
  const t0 = Date.now();
  for (;;) {
    const o = await (await fetch(`${base}/task.json`, { headers: WITH_DOOR })).json();
    if (o.running.integrity && o.running.integrity.running !== true) return o;
    if (Date.now() - t0 > 20000) throw new Error('timed out');
    await new Promise((ok) => { setTimeout(ok, 60); });
  }
}

test('a form POST with from=/ is answered with 303 back to the desk, not raw JSON', async () => {
  const r = world();
  const s = await serve(r);
  try {
    const res = await fetch(`${s.base}/task`, {
      method: 'POST', redirect: 'manual',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=integrity&from=%2F',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    await waitEnded(s.base);
    // An unknown kind from the form is a short HTML page, not JSON.
    const bad = await fetch(`${s.base}/task`, {
      method: 'POST', redirect: 'manual',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=nope&from=%2F',
    });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type'), /text\/html/);
    // `from` is a closed list: anything else keeps the JSON contract.
    const other = await fetch(`${s.base}/task`, {
      method: 'POST', redirect: 'manual',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=integrity&from=https%3A%2F%2Fevil.example',
    });
    assert.equal(other.status, 201);
    assert.equal((await other.json()).state, 'ok');
    await waitEnded(s.base);
  } finally { await s.stop(); gone(r); }
});
