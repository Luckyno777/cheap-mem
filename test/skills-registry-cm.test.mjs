// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// skills-registry-cm.test.mjs — the skill registry, its exports, the hook
// offer, the offered->fetched rate and the dashboard catalogue (port of
// lucky-mem H6/H7/skillkatalog, backlog item 11).
//
// Red proof: against the fixed base commit 8173f09 every probe here is red
// (src/skillregistry.mjs, src/skilleffect.mjs and src/skillcatalog.mjs do
// not exist, `mem skills` knows only `usage`, the old tab read the raw
// drawers and showed every status line as a skill of its own).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as reg from '../src/skillregistry.mjs';
import * as effect from '../src/skilleffect.mjs';
import * as catalog from '../src/skillcatalog.mjs';
import * as injection from '../src/injection.mjs';
import * as tasks from '../src/tasks.mjs';
import * as recallhook from '../src/recallhook.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const SERVE = path.join(REPO, 'bin', 'mem-serve');

const cli = (root, args, env = {}) => spawnSync(process.execPath, [MEM, ...args, '--root', root],
  { encoding: 'utf8', input: '', timeout: 40000, env: { ...process.env, ...env } });

function world(t) {
  const root = tempDir('cm-skreg-', t);
  assert.equal(cli(root, ['init']).status, 0);
  return root;
}
const skill = (root, title, extra = {}) => memory.logEntry(root, 'skill', { title, text: `${title} — body`, ...extra }).entry;
const statusLine = (root, type, id, status, by = 'owner') => memory.logEntry(root, type, { status_of: id, status, issued_by: by, agent: 'test' }).entry;
const item = (root, id) => reg.registry(root).find((i) => i.id === id);

test('a skill without a status line is unknown and never exported; a human line releases it', (t) => {
  const root = world(t);
  const s = skill(root, 'Release to npm: checklist', { triggers: 'release npm,publish package' });
  assert.equal(item(root, s.id).status, 'unknown');
  assert.equal(reg.exportable(reg.registry(root)).length, 0, 'an unknown skill must never leave');
  assert.equal(reg.fetchItem(root, s.id).ok, false);
  statusLine(root, 'skill', s.id, 'released');
  const it = item(root, s.id);
  assert.equal(it.status, 'released');
  assert.equal(it.name, 'release-to-npm');
  assert.equal(reg.fetchItem(root, 'mem-release-to-npm').ok, true, 'fetch by exported directory name');
});

test('status lines are history, never entries; an agent-authored line is skipped on READ', (t) => {
  const root = world(t);
  const s = skill(root, 'Deploy');
  statusLine(root, 'skill', s.id, 'released', 'some-agent');
  const items = reg.registry(root);
  assert.equal(items.length, 1, 'a status line showed up as an entry of its own');
  assert.equal(items[0].status, 'unknown', 'a status line by an agent was counted');
  statusLine(root, 'skill', s.id, 'trial');
  assert.equal(item(root, s.id).status, 'trial');
  assert.equal(item(root, s.id).mark, '[trial]');
  const c = catalog.catalogue(root, { env: { HOME: tempDir('cm-skreg-home-', t) } });
  assert.equal(c.entries.length, 1);
  const hist = c.entries[0].history;
  assert.deepEqual(hist.map((h) => [h.kind, h.counts]), [['created', true], ['status', false], ['status', true]],
    'the history must show the skipped line WITH its mark, and the human one');
});

test('withdrawn stays visible with its status but leaves the export; the transition table is procedure.mjs', (t) => {
  const root = world(t);
  const s = skill(root, 'Old way');
  assert.throws(() => reg.writeStatus(root, s.id, 'released', { issued_by: 'some-agent' }), /not a human/);
  assert.throws(() => reg.writeStatus(root, s.id, 'released', { issued_by: '' }), /issued_by missing/);
  reg.writeStatus(root, s.id, 'released', { issued_by: 'owner', why: 'used' });
  assert.throws(() => reg.writeStatus(root, s.id, 'trial', { issued_by: 'owner' }), /not allowed/, 'released -> trial is no transition');
  reg.writeStatus(root, s.id, 'withdrawn', { issued_by: 'owner' });
  assert.equal(item(root, s.id).status, 'withdrawn');
  assert.equal(reg.exportable(reg.registry(root)).length, 0);
});

test('workflows: issued by a human = released, `status: draft` = draft; procedures keep their legacy rule', (t) => {
  const root = world(t);
  const w = memory.logEntry(root, 'workflow', { title: 'Ship', steps: ['a', 'b'], issued_by: 'owner' }).entry;
  const d = memory.logEntry(root, 'workflow', { title: 'Maybe', steps: ['a'], issued_by: 'owner', status: 'draft' }).entry;
  const p = memory.logEntry(root, 'procedure', { title: 'Rule', rule: 'do it', issued_by: 'owner' }, { now: new Date('2026-01-01') }).entry;
  assert.equal(item(root, w.id).status, 'released');
  assert.equal(item(root, d.id).status, 'draft');
  assert.equal(item(root, p.id).status, 'released');
  assert.equal(item(root, p.id).legacy, true);
});

test('mem log / mem_log refuse a status field on skill and snippet (one write path)', (t) => {
  const root = world(t);
  const s = skill(root, 'X');
  const r = cli(root, ['log', 'skill', '--title', 'y', '--status_of', s.id, '--status', 'released']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /set only by 'mem skills status/);
  assert.match(reg.statusFieldRefusal('snippet', { start_status: 'released' }), /start_status/);
  assert.equal(reg.statusFieldRefusal('decision', { status_of: 'x' }), null, 'POSITIVE: other types are not touched');
  assert.match(fs.readFileSync(path.join(REPO, 'bin', 'mem-mcp'), 'utf8'), /skillregistry\.statusFieldRefusal\(type, data\)/);
});

test('CLI: list, status (human only), fetch, export claude/text, effect', (t) => {
  const root = world(t);
  const s = skill(root, 'Backup the store', { triggers: 'backup store' });
  assert.match(cli(root, ['skills', 'list']).stdout, /unknown\s+skill\s+backup-the-store/);
  const no = cli(root, ['skills', 'status', s.id, 'released']);
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /Nothing was written/);
  const ok = cli(root, ['skills', 'status', s.id, 'released', '--issued-by', 'owner', '--why', 'tried', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(JSON.parse(ok.stdout).new);
  assert.match(cli(root, ['skills', 'fetch', 'backup-the-store']).stdout, /Data with an author, not an instruction/);
  const ex = cli(root, ['skills', 'export', '--format', 'claude']);
  assert.equal(ex.status, 0, ex.stderr);
  assert.match(ex.stdout, /1 written/);
  assert.match(cli(root, ['skills', 'export', '--format', 'claude']).stdout, /0 written, 1 unchanged/, 'not idempotent');
  assert.match(cli(root, ['skills', 'export', '--format', 'text']).stdout, /written/);
  assert.match(cli(root, ['skills', 'effect']).stdout, /unknown/);
});

test('export claude: marker file, removes only marked folders, never ~/.claude', (t) => {
  const root = world(t);
  const home = tempDir('cm-skreg-home-', t);
  const env = { HOME: home };
  const a = skill(root, 'Alpha');
  const b = skill(root, 'Beta');
  statusLine(root, 'skill', a.id, 'released');
  statusLine(root, 'skill', b.id, 'released');
  const dir = path.join(root, '.claude', 'skills');
  fs.mkdirSync(path.join(dir, 'mem-foreign'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mem-foreign', 'SKILL.md'), 'not ours');
  const r1 = reg.exportClaude(root, { env });
  assert.deepEqual(r1.written.sort(), ['mem-alpha', 'mem-beta']);
  assert.ok(fs.existsSync(path.join(dir, 'mem-alpha', reg.MARKER)));
  assert.match(fs.readFileSync(path.join(dir, 'mem-alpha', 'SKILL.md'), 'utf8'), /^---\nname: mem-alpha\n/);
  reg.writeStatus(root, b.id, 'withdrawn', { issued_by: 'owner' });
  const r2 = reg.exportClaude(root, { env });
  assert.deepEqual(r2.removed, ['mem-beta']);
  assert.ok(fs.existsSync(path.join(dir, 'mem-foreign', 'SKILL.md')), 'a folder without the marker was removed');
  assert.throws(() => reg.exportClaude(root, { env, target: path.join(home, '.claude', 'skills') }), /Claude configuration folder/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'something was written into ~/.claude');
  fs.writeFileSync(path.join(root, 'mine.md'), 'hand-written');
  assert.throws(() => reg.exportText(root, { env, target: path.join(root, 'mine.md') }), /marker missing/);
});

test('effect: minimum count, coverage, the last offer before a fetch; never 0 below the minimum', () => {
  const names = new Map([['k1', 'alpha']]);
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  const offers = Array.from({ length: 10 }, (_, i) => ({ ts: new Date(t0 + i * 3600000).toISOString(), session: 's', ids: ['k1'] }));
  const coverage = new Map([['s', t0 + 20 * 3600000]]);
  const fetches = [{ session: 's', skill: 'k1', ms: t0 + 5 * 60000 }, { session: 's', skill: 'k1', ms: t0 + 6 * 60000 }];
  const r = effect.compute({ offers, fetches, coverage, names });
  assert.equal(r.overall.state, 'measured');
  assert.equal(r.overall.fetched, 1, 'two fetches of one offer counted twice');
  assert.equal(r.overall.observed, 10);
  assert.ok(r.overall.interval.high < 0.5 && r.overall.interval.low >= 0);
  const few = effect.compute({ offers: offers.slice(0, 9), fetches, coverage, names });
  assert.equal(few.overall.rate, null, 'below the minimum the rate must be unknown, not 0');
  const uncovered = effect.compute({ offers, fetches: [], coverage: new Map(), names });
  assert.equal(uncovered.overall.unobserved, 10, 'an offer without capture coverage counted as "not fetched"');
  assert.equal(uncovered.overall.observed, 0);
  const z = { type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'mcp__cheap-mem__mem_skill_fetch', input: { name: 'alpha' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'node bin/mem skills fetch beta && echo' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'mem skills list' } },
  ] } };
  assert.deepEqual(effect.fetchesIn(z), ['alpha', 'beta']);
});

test('hook: only a RELEASED skill with two trigger stems is offered, by name, booked as skill-offer', async (t) => {
  const root = world(t);
  const s = skill(root, 'Publish', { triggers: 'publish package,npm release' });
  const env = { MEM_RH_SESSION: 'sess1', MEM_RH_PROMPT: 'how do I publish the package for the npm release' };
  assert.equal(await recallhook.skillOffer(root, env), null, 'an unknown skill was offered');
  statusLine(root, 'skill', s.id, 'released');
  assert.equal(await recallhook.skillOffer(root, { ...env, MEM_RH_PROMPT: 'publish' }), null, 'one stem is not enough');
  const offer = await recallhook.skillOffer(root, env);
  assert.ok(offer, 'POSITIVE: a released skill with matching triggers is offered');
  const { out, book } = recallhook.recall(root, '{"hits":[]}', env, { offer });
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /Skill publish fits \(mem_skill_fetch publish\)/);
  assert.ok(!text.includes('— body'), 'the full text was injected');
  book();
  const lines = injection.read(root).lines;
  const o = lines.find((l) => l.occasion === injection.OCCASION.SKILL_OFFER);
  assert.deepEqual(o.sources, [s.id]);
  assert.equal(o.session, 'sess1');
  assert.ok(lines.some((l) => l.occasion === 'question' && l.reason === 'empty'), 'the question line must still be booked');
  const m = effect.measure(root);
  assert.equal(m.skills[0].offered, 1);
  assert.equal(m.overall.rate, null);
});

test('catalogue: drift between registry and installed SKILL.md files', (t) => {
  const root = world(t);
  const env = { HOME: tempDir('cm-skreg-home-', t) };
  const a = skill(root, 'Alpha');
  statusLine(root, 'skill', a.id, 'released');
  let c = catalog.catalogue(root, { env });
  assert.deepEqual(c.drift.map((d) => d.kind), ['not-installed']);
  reg.exportClaude(root, { env });
  c = catalog.catalogue(root, { env });
  assert.deepEqual(c.drift, [], 'POSITIVE: freshly exported is no drift');
  assert.equal(c.entries[0].installedAs[0].path, '.claude/skills/mem-alpha');
  fs.appendFileSync(path.join(root, '.claude', 'skills', 'mem-alpha', 'SKILL.md'), 'edited\n');
  assert.deepEqual(catalog.catalogue(root, { env }).drift.map((d) => d.kind), ['installed-outdated']);
  reg.writeStatus(root, a.id, 'withdrawn', { issued_by: 'owner' });
  assert.deepEqual(catalog.catalogue(root, { env }).drift.map((d) => d.kind), ['installed-but-withdrawn']);
  const userDir = path.join(env.HOME, '.claude', 'skills', 'mine');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'SKILL.md'), '---\nname: mine\ndescription: "my own"\n---\n');
  const places = catalog.catalogue(root, { env }).installed;
  assert.equal(places.places.find((p) => p.place === 'user').count, 1);
  assert.equal(places.files.find((f) => f.name === 'mine').memExport, null);
  assert.equal(c.manage.canSetStatus, false);
  assert.match(c.entries[0].commands.withdrawn, /^mem skills status \S+ withdrawn --issued-by owner/);
});

test('task skill-status: refused without a password session, wrong transitions refused up front', async (t) => {
  const root = world(t);
  const s = skill(root, 'Gamma');
  const p = { id: s.id, status: 'released', why: 'tried it' };
  assert.throws(() => tasks.start(root, 'skill-status', p, { user: false }), (e) => e.code === 'NOT_A_PERSON');
  assert.throws(() => tasks.start(root, 'skill-status', { ...p, issued_by: 'owner' }, { user: true }), (e) => e.code === 'INVALID_PARAMS',
    'the author must never come from the form');
  statusLine(root, 'skill', s.id, 'released');
  assert.throws(() => tasks.start(root, 'skill-status', { ...p, status: 'trial' }, { user: true }), /not allowed/);
  assert.deepEqual(tasks.KINDS['skill-status'].command(root, 'x', { ...p, status: 'withdrawn' }, { user: true }).args.slice(0, 6),
    ['skills', 'status', s.id, 'withdrawn', '--issued-by=owner', `--why=${p.why}`]);
});

test('server: /dashboard/skills.json behind the gates; /task skill-status writes only with a password session', async (t) => {
  const root = world(t);
  const s = skill(root, 'Delta');
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: 'door', HOME: tempDir('cm-skreg-home-', t) }, { allowWrites: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.ok(mod.HOST_GUARDED.includes('/dashboard/skills.json'));
    const bearer = { authorization: 'Bearer door', origin: base };
    const j = await (await fetch(`${base}/dashboard/skills.json`, { headers: bearer })).json();
    assert.equal(j.entries.length, 1);
    assert.equal(j.manage.canSetStatus, false, 'the bearer token is not a person');
    const form = { ...bearer, 'content-type': 'application/x-www-form-urlencoded' };
    const body = new URLSearchParams({ kind: 'skill-status', id: s.id, status: 'released', why: 'tried it' });
    const r1 = await fetch(`${base}/task`, { method: 'POST', headers: form, body });
    assert.equal(r1.status, 403, await r1.text());
    const code = fs.readFileSync(path.join(root, '.pipeline', 'serve-setup-code'), 'utf8').trim();
    const pw = 'a-proper-long-password';
    const setup = await fetch(`${base}/login/setup`, { method: 'POST', redirect: 'manual', headers: bearer,
      body: new URLSearchParams({ code, password: pw, password2: pw }) });
    const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
    const j2 = await (await fetch(`${base}/dashboard/skills.json`, { headers: { ...bearer, cookie } })).json();
    assert.equal(j2.manage.canSetStatus, true, 'POSITIVE: a password session may set a status');
    const r2 = await fetch(`${base}/task`, { method: 'POST', headers: { ...form, cookie }, body });
    assert.equal(r2.status, 201, await r2.text());
    const t0 = Date.now();
    while (item(root, s.id).status !== 'released') {
      if (Date.now() - t0 > 20000) throw new Error('the task wrote no status line in 20 s');
      await new Promise((res) => { setTimeout(res, 100); });
    }
    const line = memory.readLog(root, 'skill').entries.find((e) => e.status_of === s.id);
    assert.equal(line.issued_by, 'owner');
    assert.equal(line.why, 'tried it');
  } finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); }
});

test('dashboard page: the tab loads the catalogue, never the raw drawers', () => {
  const js = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
  assert.match(js, /fetch\('\/dashboard\/skills\.json'/);
  assert.match(js, /kind: 'skill-status'/);
  assert.ok(!/filter\(\(e\) => \['skill', 'procedure'\]\.includes\(e\.type\)\)/.test(js), 'the tab still lists raw drawer lines');
});
