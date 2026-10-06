// test/dash-run-cm.test.mjs — the request-run helper and the findings F18, F19, F20 of the audit of 2026-10-06
// (the sibling's test/dash-lauf-lm.test.mjs). Logic probes with controlled answers on the ORIGINAL functions
// out of assets/dashboard/dashboard.js (cut out, with stubs; test/fixture/dash-run-cm.mjs).
// Browser probes: test/dash-run-cm-browser.test.mjs.
// Red proof: DASH_JS=<dashboard.js of the old state 4bbca61> node --test test/dash-run-cm.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, handAnswer, tick } from './fixture/dash-run-cm.mjs';

const esc = (v) => String(v ?? '');

// ---------------------------------------------------------------- helper
test('helper: a new run aborts the old one, numbers rise, the selection is checked', () => {
  const { runStart, runCancel } = build({ functions: [], expose: ['runStart', 'runCancel'] });
  assert.equal(typeof runStart, 'function', 'the helper exists (old state: no helper)');
  const a = runStart('x');
  assert.ok(a.holds());
  const b = runStart('x');
  assert.ok(b.nr > a.nr);
  assert.ok(a.signal.aborted && !a.holds(), 'the old run is aborted and invalid');
  assert.ok(b.holds());
  assert.ok(!b.holds(() => false), 'the selection no longer matches');
  assert.ok(runStart('y').holds() && b.holds(), 'another family stays untouched');
  runCancel('x');
  assert.ok(!b.holds());
});

test('helper: deadline and request budget are separate quantities', () => {
  let now = 1000;
  const { runBudget } = build({ stubs: { Date: { now: () => now } }, expose: ['runBudget'] });
  assert.equal(typeof runBudget, 'function');
  const b = runBudget({ deadlineMs: 500, requests: 3 });
  assert.equal(b.take(), null); assert.equal(b.take(), null); assert.equal(b.take(), null);
  assert.equal(b.take(), 'budget');
  const c = runBudget({ deadlineMs: 500, requests: 100 });
  assert.equal(c.take(), null);
  now += 600;
  assert.equal(c.take(), 'deadline');
});

// ---------------------------------------------------------------- F18: message
function messageWorld() {
  const shown = [];
  const requests = [];
  const dlg = { open: false, close() { this.open = false; this.closed?.(); } };
  const stubs = {
    fetch: (url, opt) => { const h = handAnswer(opt?.signal); requests.push({ url, ...h }); return h.p; },
    esc,
    $: () => dlg,
  };
  const preamble = `
    let infoStamp = 0;
    const messages = [{ name: 'a', subject: 'Message A', from: 'f', to: 'h', state: 'open', situation: 'open' }, { name: 'b', subject: 'Message B', from: 'f', to: 'h', state: 'open', situation: 'open' }];
    const D = { inbox: { states: [] } }; const state = { readonly: true };
    const note = (t) => t; const badge = (t) => t; const btn = () => ''; const whenTime = (t) => t; const situationWord = {};
    function showInfo(title, body) { infoStamp += 1; dlg.open = true; shown.push(title + '|' + String(body).slice(0, 30)); }`;
  const api = build({ preamble, functions: ['showMessageLatest'], expose: ['showMessageLatest', 'runCancel', 'showInfo'], stubs: { ...stubs, dlg, shown } });
  return { api, shown, requests, dlg };
}
const message = (name) => ({ state: 'ok', human: 'h', message: { subject: 'Message ' + name.toUpperCase(), from: 'f', to: 'h', time: 't', state: 'open', text: 'Text ' + name }, replies: [] });
const last = (shown) => shown.at(-1);

test('F18 message: A requested, B requested, A answers last -> B stays visible', async () => {
  const w = messageWorld();
  const pa = w.api.showMessageLatest('a'); const pb = w.api.showMessageLatest('b');
  w.requests[1].answer(message('b')); await pb;
  w.requests[0].answer(message('a')); await pa.catch(() => {}); await tick();
  assert.match(last(w.shown), /Message B/, 'the late answer A overwrote B: ' + last(w.shown));
  assert.ok(!w.shown.some((t) => /Message A\|<p class="small muted">f → h · /.test(t) && !/Reading/.test(t)), 'A was never shown in full');
});
test('F18 message: answers in the order A, B -> B visible', async () => {
  const w = messageWorld();
  const pa = w.api.showMessageLatest('a'); const pb = w.api.showMessageLatest('b');
  w.requests[0].answer(message('a')); await pa.catch(() => {}); w.requests[1].answer(message('b')); await pb; await tick();
  assert.match(last(w.shown), /Message B/);
});
test('F18 message: the switch aborts the older request', async () => {
  const w = messageWorld();
  const pa = w.api.showMessageLatest('a'); void w.api.showMessageLatest('b'); await tick();
  assert.equal(w.requests[0].signal?.aborted, true, 'the older request was aborted');
  await pa; // the aborted request ends without an exception and without a new display
  assert.ok(!w.shown.some((t) => /not readable|aborted/i.test(t)), 'an abort is no error dialog: ' + w.shown.join(' / '));
});
test('F18 message: closing during the request -> nothing is redrawn', async () => {
  const w = messageWorld();
  const pa = w.api.showMessageLatest('a');
  w.dlg.closed = () => w.api.runCancel('message'); w.dlg.close();
  const before = w.shown.length;
  w.requests[0].answer(message('a')); await pa; await tick();
  assert.equal(w.shown.length, before);
});
test('F18 message: another dialog opens during the request -> the late message does not overwrite it', async () => {
  const w = messageWorld();
  const pa = w.api.showMessageLatest('a');
  w.api.showInfo('Entry X', 'Detail'); // another view takes the dialog
  w.requests[0].answer(message('a')); await pa; await tick();
  assert.match(last(w.shown), /Entry X/);
});

// ---------------------------------------------------------------- F18: loadData
function dataWorld() {
  const requests = [];
  const stubs = {
    fetch: (url, opt) => { const h = handAnswer(opt?.signal); requests.push(h); return h.p; },
    document: { hidden: true }, location: {},
  };
  const preamble = `
    let D = null, loadError = null, lastContentKey = null, refetchTimer = 0; const taken = [];
    const contentKey = (b) => JSON.stringify(b); const prepare = (b) => { D = b; taken.push(b.v); };
    const catReapply = () => {}; const projectsConfirmedApply = () => {}; const loadParts = async () => {}; const showNewDataMark = () => {}; const toast = () => {};
    const TEMPO_TEST_MS = 1; const $ = () => ({ innerHTML: '', textContent: '' }); const note = (t) => t; const btn = () => ''; const esc = (t) => t;`;
  const api = build({ preamble, functions: ['loadData', 'loadDataRun'], expose: ['loadData', 'taken'], stubs });
  return { api, requests };
}
test('F18 loadData: a late older answer does not overwrite the newer state (B before A)', async () => {
  const w = dataWorld();
  const pa = w.api.loadData({ quiet: true }); const pb = w.api.loadData({ quiet: true });
  w.requests[1].answer({ v: 'B' }); await pb; await tick();
  w.requests[0].answer({ v: 'A' }); await pa; await tick();
  assert.deepEqual(w.api.taken.at(-1), 'B', 'taken last: ' + w.api.taken.join(','));
  assert.ok(!w.api.taken.includes('A'));
});
test('F18 loadData: A before B stays B; the older call returns the result of the newer (no lost render)', async () => {
  const w = dataWorld();
  const pa = w.api.loadData(); const pb = w.api.loadData({ quiet: true });
  w.requests[0].answer({ v: 'A' }); w.requests[1].answer({ v: 'B' });
  assert.equal(await pa, true); assert.equal(await pb, true);
  assert.equal(w.api.taken.at(-1), 'B');
});

// ---------------------------------------------------------------- F19: entry list
function entriesWorld({ state, cap = 2, page = 10, clock = null, alreadyThere = false }) {
  const log = { n: 0, urls: [] };
  const fetchStub = async (url) => {
    log.n += 1; log.urls.push(url);
    if (log.n > 500) throw new Error('fixture stops');
    return { ok: true, json: async () => state(log.n) };
  };
  const preamble = `
    let D = { parts: { entries: { page: ${page} } }, cache: { built_at: 'x', source: 'q' } };
    let entriesLoad = { full: true, loaded: 0, total: 0, key: null }; let entriesLoadingFor = null; let entriesDisturbance = null; let entriesRun = 0; // entriesRun: old state only
    const partState = { entries: ${alreadyThere ? "'ok'" : 'undefined'} }, partReason = {}; let entries = [];
    const setEntries = (l) => { entries = l; }; const partLaterAgain = () => {};
    const ENTRIES_CAP = ${cap};`;
  const stubs = { fetch: fetchStub, log, ...(clock ? { Date: { now: clock } } : {}) };
  const raw = build({ preamble, functions: ['loadEntriesPart', 'entriesDisturbanceSet'], constants: ['ENTRIES_RESTARTS', 'ENTRIES_DEADLINE_MS', 'ENTRIES_STATE_TEXT', 'stateKey'], expose: ['loadEntriesPart', 'partState', 'partReason', 'entries', 'entriesLoad', 'entriesDisturbance'], stubs });
  return { raw, log };
}
const pageWith = (n, stateId, next = 1) => ({ state: 'ok', data: [{ id: 'e' + n }], state_id: stateId, next, total: 99, window: false });

test('F19: state_id changes on every second page -> bounded and visible, no mixed list', async () => {
  const w = entriesWorld({ state: (n) => pageWith(n, n % 2) });
  const r = await w.raw.loadEntriesPart();
  assert.equal(r, 'error', 'loadParts gets the end state to draw');
  assert.ok(w.log.n <= 40, `requests: ${w.log.n} (old state: unbounded)`);
  assert.equal(w.raw.partState.entries, 'error');
  assert.match(w.raw.partReason.entries, /changing|load again/i);
  assert.equal(w.raw.entries.length, 0, 'nothing mixed was taken over as the list');
  assert.match(w.raw.entriesDisturbance, /changing/, 'visible text for the surface');
});
test('F19: one single state change -> restart, then a whole list of one state', async () => {
  const w = entriesWorld({ state: (n) => (n === 2 ? pageWith(n, 'new') : pageWith(n, n < 2 ? 'old' : 'new', n >= 4 ? null : 1)), cap: 6, page: 2 });
  await w.raw.loadEntriesPart();
  assert.equal(w.raw.partState.entries, 'ok');
  const ids = w.raw.entries.map((e) => e.id);
  assert.ok(!ids.includes('e1'), 'the page of the old state is not in it: ' + ids);
});
test('F19: deadline exceeded (separate from the budget) -> end state', async () => {
  let now = 0;
  const w = entriesWorld({ state: (n) => { now += 70000; return pageWith(n, 'same'); }, cap: 30, page: 1, clock: () => now });
  await w.raw.loadEntriesPart();
  assert.equal(w.raw.partState.entries, 'error');
  assert.match(w.raw.partReason.entries, /Time limit/);
  assert.ok(w.log.n <= 3, 'requests: ' + w.log.n);
});
test('F19: a whole list is already there + a state that keeps changing -> the old list stays, notice visible', async () => {
  const w = entriesWorld({ state: (n) => pageWith(n, n % 2), alreadyThere: true });
  await w.raw.loadEntriesPart();
  assert.equal(w.raw.partState.entries, 'ok');
  assert.match(w.raw.entriesDisturbance, /changing/);
});
