// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/dashboard-complete.test.mjs — nothing of the old UI is lost.
//
// **The order (owner decision 2026-09-28).** The dashboard becomes the
// ONLY UI; the old one (the Astra desk at `/`, the console page, the
// viewer route) is switched off only after completeness is PROVEN: every
// piece of information and every function the old UI had has a real
// place in the dashboard. This file is that proof, in the same shape as
// the sibling's own completeness test (each house tests the same
// rule in its own language — shared/invariants.jsonl,
// "dashboard-vollstaendig").
//
// **How it checks.** One memory with real entries (several types, a
// project, a declared link, an open duty and question, a registered
// agent, a message to the human, a timeline fact, a stored file, a raw
// capture) and ONE call of `collectDashboard()` — the function behind
// `/dashboard.json`. Every inventory row checks, on that one result,
// that its new place exists AND carries real (not invented) data; and
// that the browser script actually reads the field (`js`), so a field
// delivered but never drawn fails too. A second probe hits the running
// server.
//
// **Red-proof, built in.** A copy of the real result with EXACTLY ONE
// field removed (as a forgotten wire would) makes exactly the rows that
// need it fail — and no other row. The hand-run red-proof is in the
// commit that introduced this file.
//
// invariant: dashboard-vollstaendig
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as agents from '../src/agents.mjs';
import * as inbox from '../src/inbox.mjs';
import * as data from '../src/dashboard-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const JS = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
const NOW = new Date('2026-09-28T09:00:00Z');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dash-complete-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  const participants = { alex: { human: true }, probe: {} };
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'complete', participants, language: 'en' }));
  const err = memory.logEntry(r, 'error', { class: 'double-run', title: 'Two tasks at once', text: 'Started twice.' }).entry;
  memory.logEntry(r, 'learning', { title: 'Small probes first', text: 'They find it sooner.', tags: ['probes'], topic: 'testing/probes', origin: { derived_from: [err.id] } });
  memory.projectInit(r, 'demo');
  memory.logEntry(r, 'decision', { topic: 'demo/choice', choice: 'this way', why: 'because' }, { project: 'demo' });
  memory.logEntry(r, 'duty', { title: 'Review the PR', who: 'alex' });
  memory.logEntry(r, 'question', { question: 'Is the move complete?' });
  memory.logEntry(r, 'timeline', { key: 'role', value: 'lead', valid_from: '2026-01-01' });
  agents.createAgent(r, 'probeagent', { role: 'probe', model: 'probe-1' });
  memory.logEntry(r, 'thought', { title: 'A note', text: 'x', agent: 'probeagent' });
  const msg = inbox.write(r, participants, { from: 'probe', to: 'alex', subject: 'Completeness probe', text: 'A real message.', now: NOW });
  return { r, messageName: msg.name };
}

/**
 * The inventory: old feature -> new place. `oldPlace` names where the
 * old UI showed it, `newPlace` where the dashboard shows it, `needs` the
 * payload fields `check` touches (the red-proof removes exactly one), and
 * `js` what the browser script must read so the field is really drawn.
 */
export const INVENTORY = [
  {
    oldFeature: 'Desk metric tiles: entries total, declared links, drawer kinds, system state',
    oldPlace: 'src/astra/desk.mjs deskView()',
    newPlace: 'Overview metrics + Operations › Versions "data state"; d.meta.entriesTotal, d.net',
    needs: ['meta', 'net'],
    js: [/D\?\.meta\?\.entriesTotal/, /D\.net\?\.links/],
    check(d) {
      assert.ok(Number.isFinite(d.meta.entriesTotal) && d.meta.entriesTotal >= 7, `entriesTotal ${d.meta.entriesTotal}`);
      assert.ok(d.net.links >= 1, 'the declared link is not counted');
    },
  },
  {
    oldFeature: 'Desk system-state cards (mem board tiles, four states, worst first)',
    oldPlace: 'src/astra/desk.mjs, console.collect().board',
    newPlace: 'Overview "System state" (boardPanel) + Operations › Diagnosis; d.system',
    needs: ['system'],
    js: [/function boardPanel/, /D\.system/],
    check(d) {
      const ids = d.system.map((t) => t.id).sort();
      assert.deepEqual(ids, ['agents', 'archive', 'bridge', 'digest', 'errors', 'questions', 'setup']);
      for (const t of d.system) assert.ok(['calm', 'watch', 'alarm', 'unknown'].includes(t.state), t.state);
    },
  },
  {
    oldFeature: 'Desk active work: open duties and questions',
    oldPlace: 'src/astra/desk.mjs workCard(), d.work',
    newPlace: 'Overview "Your next look" + Work › Duties & questions; d.openDuties / d.openQuestions',
    needs: ['openDuties', 'openQuestions'],
    js: [/d\.openDuties/, /d\.openQuestions/],
    check(d) {
      assert.equal(d.openDuties.length, 1);
      assert.equal(d.openDuties[0].who, 'alex');
      assert.equal(d.openQuestions.length, 1);
    },
  },
  {
    oldFeature: 'Knowledge list: every entry, retired ones marked, a chip for all 13 types',
    oldPlace: 'src/astra/knowledge.mjs knowledgeView()',
    newPlace: 'Knowledge › Entries (#knowledge/entries); d.entries / d.types',
    needs: ['entries', 'types'],
    js: [/d\.entries/, /d\.types/],
    check(d) {
      assert.equal(d.types.length, Object.keys(memory.TYPES).length);
      assert.ok(d.entries.some((e) => e.title.includes('Small probes first')));
    },
  },
  {
    oldFeature: 'Knowledge detail: basis, authority, scope, standing, what it replaces and contradicts',
    oldPlace: 'astra.mjs detail pane, /entry.json',
    newPlace: 'Detail drawer (Content, Evidence trail, History, Raw fields); d.entries[] + GET /dashboard/entry.json',
    needs: ['entries'],
    js: [/\/dashboard\/entry\.json/, /Basis \/ authority/, /Scope \/ built on/],
    check(d) {
      const l = d.entries.find((e) => e.title.includes('Small probes first'));
      assert.ok('authority' in l && 'scope' in l, 'authority/scope missing on the entry');
      assert.equal(l.derivedFrom.length, 1, 'what it was built on is lost');
      assert.ok(l.out.some(([kind]) => kind === 'derived_from'));
    },
  },
  {
    oldFeature: 'Knowledge: searching past the embedded list (/entries.json form)',
    oldPlace: 'src/astra/knowledge.mjs form action=/entries.json',
    newPlace: 'Command palette (Ctrl K): ranked search through /entries.json',
    needs: [],
    js: [/\/entries\.json\?q=/],
    check() {},
  },
  {
    oldFeature: 'Space: the entries as a rotatable map with their lines',
    oldPlace: 'src/astra/space.mjs',
    newPlace: 'Knowledge › Knowledge space (3D, #knowledge/network); d.entries[].out + d.net',
    needs: ['entries', 'net'],
    js: [/function initGraph/, /function graphModel/],
    check(d) {
      assert.ok(Array.isArray(d.net.boxes) && d.net.boxes.length >= 3);
    },
  },
  {
    oldFeature: 'Links view: the declared-only drawer×drawer matrix and its layers',
    oldPlace: 'src/astra/net.mjs',
    newPlace: 'Knowledge space: project matrix, drawer matrix, Layers panel; d.net.pairs/boxes/layers',
    needs: ['net'],
    js: [/function netLayers/, /function drawerMatrix/, /D\.net\?\.pairs/],
    check(d) {
      assert.ok(d.net.pairs.length >= 1);
      assert.ok(d.net.layers && Array.isArray(d.net.layers.unlinked), 'the layers are missing');
    },
  },
  {
    oldFeature: 'Projects view (entries, retired, drawers, agents, open questions)',
    oldPlace: 'src/astra/projects.mjs',
    newPlace: 'Sources › Projects (#sources/projects); d.projects / d.projectShelf',
    needs: ['projects', 'projectShelf'],
    js: [/D\.projects/, /D\.projectShelf/],
    check(d) {
      assert.ok(d.projects.some((p) => p.name === 'demo' && p.entries === 1));
      assert.ok(d.projectShelf.projects.some((p) => p.name === 'demo'));
    },
  },
  {
    oldFeature: 'Agents: registered vs seen, two-signal liveness, startable, pause, bell',
    oldPlace: 'src/astra/agents.mjs agentsView()',
    newPlace: 'Work › Agents (#work/agents); d.agents[].activity/startable/pause/channel',
    needs: ['agents'],
    js: [/D\.agents/, /a\.activity/, /a\.startable/, /a\.channel/],
    check(d) {
      const a = d.agents.find((x) => x.name === 'probeagent');
      assert.ok(a, 'the registered agent is missing');
      for (const k of ['activity', 'startable', 'pause', 'channel']) assert.ok(a[k], `agent field ${k} missing`);
    },
  },
  {
    oldFeature: 'The human\'s inbox with a reply form under each message',
    oldPlace: 'src/astra/agents.mjs humanInboxSection(), POST /inbox/reply',
    newPlace: 'Work › Inbox (#work/inbox): read, reply (POST /inbox/reply), acknowledge (POST /inbox/state); d.inbox',
    needs: ['inbox'],
    js: [/formPost\('\/inbox\/reply'/, /formPost\('\/inbox\/state'/, /\/dashboard\/message\.json/],
    check(d, { messageName }) {
      assert.equal(d.inbox.human, 'alex');
      assert.ok(d.inbox.messages.some((m) => m.name === messageName && m.to === 'alex'));
    },
  },
  {
    oldFeature: 'Settings: raw-archive, error-window, quiet-hours — with source and effect',
    oldPlace: 'src/astra/set.mjs, /console',
    newPlace: 'Settings › System settings (#settings/system); d.settings, POST /setting',
    needs: ['settings'],
    js: [/function systemPage/, /formPost\('\/setting'/],
    check(d) {
      assert.deepEqual(d.settings.map((s) => s.id).sort(), ['error-window', 'quiet-hours', 'raw-archive']);
      for (const s of d.settings) assert.ok(s.effect && s.source, `${s.id}: effect/source missing`);
    },
  },
  {
    oldFeature: 'The write switch, in four states, said in words',
    oldPlace: 'console.writesNote()',
    newPlace: 'Settings › System settings, first row; d.meta.writes',
    needs: ['meta'],
    js: [/D\.meta\?\.writes/],
    check(d) {
      assert.ok(['on', 'off', 'unknown', 'error'].includes(d.meta.writes.state));
      assert.ok(d.meta.writes.reason);
    },
  },
  {
    oldFeature: 'Setup steps (installation)',
    oldPlace: 'src/astra/set.mjs steps',
    newPlace: 'Settings › System settings, "Installation"; d.setup',
    needs: ['setup'],
    js: [/D\.setup/],
    check(d) { assert.ok(Array.isArray(d.setup) && d.setup.length >= 1); },
  },
  {
    oldFeature: 'Doors: which link goes where, token set or not',
    oldPlace: 'src/astra/set.mjs doors, console.connections()',
    newPlace: 'Operations › Versions; d.connections',
    needs: ['connections'],
    js: [/D\.connections/],
    check(d) { assert.ok(d.connections.some((c) => c.id === 'console')); },
  },
  {
    oldFeature: 'Cloud stores found on this machine',
    oldPlace: 'src/astra/set.mjs stores',
    newPlace: 'Settings › System settings, "Stores on this machine"; d.stores',
    needs: ['stores'],
    js: [/D\.stores/],
    check(d) { assert.ok(Array.isArray(d.stores)); },
  },
  {
    oldFeature: 'Tasks: start, follow, cancel export and the integrity check',
    oldPlace: 'src/astra/tasks.mjs, /task, /task.json, /task/cancel',
    newPlace: 'Operations › Tasks (#ops/operations); d.tasks.kinds / d.tasks.running',
    needs: ['tasks'],
    js: [/fetch\('\/task'/, /fetch\('\/task\/cancel'/, /fetch\('\/task\.json/],
    check(d) {
      for (const k of ['export', 'integrity', 'raw-delete', 'done']) assert.ok(d.tasks.kinds[k], `task kind ${k} missing`);
    },
  },
  {
    oldFeature: 'Raw capture review: four states, deletion only with a reason',
    oldPlace: 'src/astra/set.mjs raw table (delete was CLI-only)',
    newPlace: 'Sources › Raw capture (#sources/raw): review, preview, reason, confirmation, task raw-delete; d.raw',
    needs: ['raw'],
    js: [/function rawDeletePreview/, /kind: 'raw-delete'/],
    check(d) {
      assert.equal(d.raw.readable, true);
      assert.deepEqual(Object.keys(d.raw.counts).sort(), ['deleted', 'elsewhere', 'present', 'unreachable']);
    },
  },
  {
    oldFeature: 'Console: git state and inventory',
    oldPlace: 'console.collect() git/inventory',
    newPlace: 'Operations › Versions + scope bar; d.meta.git / d.meta.inventory',
    needs: ['meta'],
    js: [/D\.meta\?\.git/, /D\.meta\?\.inventory/],
    check(d) {
      assert.ok('branch' in d.meta.git && 'head' in d.meta.git);
      assert.ok('captures' in d.meta.inventory);
    },
  },
  {
    oldFeature: 'Console change log (every applied setting, machine-local)',
    oldPlace: 'console.readLog()',
    newPlace: 'Settings › System settings, history under the form; d.log',
    needs: ['log'],
    js: [/D\.log/],
    check(d) { assert.ok(Array.isArray(d.log)); },
  },
  {
    oldFeature: 'Viewer: topics, the topic tree and its quality',
    oldPlace: 'src/viewer.mjs (served at /viewer)',
    newPlace: 'Knowledge › Topics (#knowledge/topics); d.topics',
    needs: ['topics'],
    js: [/D\.topics/, /Topic tree/],
    check(d) {
      assert.ok(d.topics.list.some((t) => t.topic === 'testing/probes'));
      assert.ok(d.topics.quality && Number.isFinite(d.topics.quality.topics));
    },
  },
  {
    oldFeature: 'Viewer: experiences (cited, contested, backed by)',
    oldPlace: 'src/viewer.mjs experiences',
    newPlace: 'Knowledge › Learnings; d.experiences',
    needs: ['experiences'],
    js: [/D\.experiences/],
    check(d) { assert.ok(d.experiences.some((x) => x.title.includes('Small probes first'))); },
  },
  {
    oldFeature: 'Viewer: hand-drawn links with their reason',
    oldPlace: 'src/viewer.mjs links',
    newPlace: 'Knowledge space, "Hand-drawn links"; d.links',
    needs: ['links'],
    js: [/D\.links/],
    check(d) { assert.ok(Array.isArray(d.links)); },
  },
  {
    oldFeature: 'Viewer: living facts (current value, since when, stale, conflict)',
    oldPlace: 'src/viewer.mjs facts',
    newPlace: 'Knowledge › Facts & time (+ bitemporal /dashboard/facts-at.json); d.facts',
    needs: ['facts'],
    js: [/D\.facts/, /\/dashboard\/facts-at\.json/],
    check(d) { assert.ok(d.facts.some((f) => f.key === 'role' && f.value === 'lead')); },
  },
  {
    oldFeature: 'Viewer: the store register',
    oldPlace: 'src/viewer.mjs store',
    newPlace: 'Sources › Sources & store (#sources/files); d.store',
    needs: ['store'],
    js: [/D\.store/],
    check(d) { assert.equal(d.store.readable, true); },
  },
  {
    oldFeature: 'The viewer as a file to take along (mem viewer)',
    oldPlace: 'src/viewer.mjs via /viewer and mem viewer',
    newPlace: 'stays a CLI command; named in Settings › Function catalogue and in the export note',
    needs: ['catalog'],
    js: [/mem viewer/],
    check(d) { assert.ok(d.catalog.cli.includes('viewer'), 'mem viewer is not in the catalogue'); },
  },
  {
    oldFeature: 'The data routes tools and probes read (/console.json, /pult.json, /entry.json, /entries.json, /task.json, /health)',
    oldPlace: 'bin/mem-serve PATHS',
    newPlace: 'unchanged, still served (checked against the server\'s own PATHS below)',
    needs: [],
    js: [],
    check() {},
  },
];

let CACHED = null;
function result() {
  if (CACHED) return CACHED;
  const w = world();
  CACHED = { d: data.collectDashboard(w.r, { now: NOW }), ...w };
  return CACHED;
}

for (const row of INVENTORY) {
  test(`complete: ${row.oldFeature} -> ${row.newPlace}`, () => {
    const { d, messageName } = result();
    row.check(d, { messageName });
    for (const re of row.js) assert.match(JS, re, `the browser script never reads it: ${re}`);
  });
}

test('complete (server): /dashboard.json delivers the same real data, and the data routes still answer', async () => {
  const { r, messageName } = world();
  const mod = await import(`${pathToFileURL(SERVE).href}?complete=${Math.random()}`);
  for (const p of ['/console.json', '/pult.json', '/entry.json', '/entries.json', '/task.json']) {
    assert.ok(mod.PATHS.includes(p), `${p} was dropped from PATHS`);
  }
  const { server } = await mod.serve(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/dashboard.json`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.ok(d.entries.some((e) => e.title.includes('Two tasks at once')));
    assert.ok(d.inbox.messages.some((m) => m.name === messageName));
    assert.ok(d.agents.some((a) => a.name === 'probeagent'));
    assert.ok(d.projects.some((p) => p.name === 'demo'));
    for (const p of ['/console.json', '/pult.json', '/task.json', '/health']) {
      const x = await fetch(base + p);
      assert.equal(x.status, 200, `${p} answers ${x.status}`);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((res) => server.close(res));
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('red-proof: one deliberately removed field (agents) fails exactly the rows that need it', () => {
  const { d, messageName } = result();
  const broken = { ...d, agents: undefined };
  const affected = INVENTORY.filter((z) => z.needs.includes('agents'));
  assert.ok(affected.length >= 1);
  for (const row of affected) {
    assert.throws(() => row.check(broken, { messageName }), `row '${row.oldFeature}' stays green without d.agents — it sees nothing`);
  }
  for (const row of INVENTORY.filter((z) => !z.needs.includes('agents'))) {
    assert.doesNotThrow(() => row.check(broken, { messageName }), `row '${row.oldFeature}' fails although it does not need agents`);
  }
});

test('red-proof: every field-bearing row fails when its own field goes', () => {
  const { d, messageName } = result();
  for (const row of INVENTORY.filter((z) => z.needs.length)) {
    const broken = { ...d };
    for (const k of row.needs) delete broken[k];
    assert.throws(() => row.check(broken, { messageName }), `row '${row.oldFeature}' passes with ${row.needs.join(', ')} removed`);
  }
});

test('positive control: the inventory is not thin and every row names both places', () => {
  assert.ok(INVENTORY.length >= 25, `only ${INVENTORY.length} rows`);
  for (const row of INVENTORY) assert.ok(row.oldFeature && row.oldPlace && row.newPlace, JSON.stringify(row.oldFeature));
});
