// test/dash-later-once-cm.test.mjs - the logic half of test/dash-later-once-cm-browser.test.mjs: a new round of the
// deferred parts drops the retry still waiting from the round before (dashboard-tempo-cm, 2026-10-16), on the ORIGINAL
// functions out of assets/dashboard/dashboard.js (cut out, with stubs: test/fixture/dash-run-cm.mjs).
//
// Why a second probe of the same guarantee (CI run 1103): the browser probe needs Chromium, and the guarantees job of
// CI has none (`npm ci --omit=optional`). There it skipped, its mutant in bench/mutation.mjs looked like a survivor of
// its own suite, and the harness re-ran the WHOLE suite to find out (8 minutes): the job ran into its 25-minute limit and
// was cancelled. This probe needs no browser, so the mutant is caught where it is checked.
//
// Measure:          requests for the part after it said `ok` in the newer round.
// Starting value:   one `building` answer (retry armed), then a newer round that gets the part.
// Expected change:  no retry left waiting (partRetryTimer 0, partLater null), no further request.
// Abort criterion:  a request after the part arrived.
//
// Red proof: DASH_JS=<dashboard.js of dc6b69d, the base of the browser probe> node --test test/dash-later-once-cm.test.mjs
// asks the part a third time when the old timer runs out; the positive control below shows the timer fires at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from './fixture/dash-run-cm.mjs';

const WAIT_MS = 300; // the retry's timer in this probe (the page waits 3 s; TEMPO_TEST_MS is the page's own test knob)

function world() {
  const log = { inbox: 0, renders: 0 };
  let building = true;
  const preamble = `
    const TEMPO_TEST_MS = ${WAIT_MS}; let partRetryTimer = 0; let partLater = null; let entriesDisturbance = null;
    const partState = { inbox: 'loading' }; const partReason = {}; const partContentKey = {};
    const PART_TAB = { inbox: ['inbox'] }; const state = { tab: 'start' }; const D = { parts: { inbox: { count: 1 } } };
    function loadEntriesPart() { return Promise.resolve('same'); }
    function partsAllThere() { return partState.inbox === 'ok'; }
    function setMessages() {} function setCaptures() {} function setExperiences() {}
    function render() { log.renders += 1; } function showNewDataMark() {}`;
  const fetch = async (url) => {
    if (String(url).includes('part=inbox')) log.inbox += 1;
    return { ok: true, status: 200, json: async () => (building ? { building: true } : { state: 'ok', data: [{ name: 'a' }] }) };
  };
  const api = build({
    preamble, functions: ['partLaterAgain', 'partLaterEnd', 'partLaterSkipTimer', 'loadParts', 'entriesDisturbanceSet'],
    constants: ['PART_LATER_DEADLINE_MS', 'PART_LATER_REQUESTS'],
    expose: ['loadParts', 'partState', 'partRetryTimer', 'partLater'], stubs: { log, fetch },
  });
  return { api, log, ready: () => { building = false; } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a newer round of loadParts drops the retry still waiting: the part is asked once more, not twice', async () => {
  const w = world();
  assert.equal(typeof w.api.loadParts, 'function', 'loadParts was not cut out of dashboard.js - the fixture names moved');
  await w.api.loadParts(); // the first round: `building`, a retry is armed
  assert.equal(w.log.inbox, 1);
  assert.equal(w.api.partRetryTimer, 1, 'fixture: the building answer arms a retry');
  w.ready();
  await w.api.loadParts(); // a newer data load starts a new round well inside the wait
  assert.equal(w.log.inbox, 2);
  assert.equal(w.api.partState.inbox, 'ok');
  assert.equal(w.api.partRetryTimer, 0, 'the old retry still waits');
  assert.equal(w.api.partLater, null, 'everything arrived: no waiting spell is left');
  await sleep(WAIT_MS * 3);
  assert.equal(w.log.inbox, 2, `the old timer ran out and asked the part again (${w.log.inbox} requests)`);
});

test('POSITIVE CONTROL: without a newer round the armed retry fires and asks again (the probe can see a retry)', async () => {
  const w = world();
  await w.api.loadParts();
  assert.equal(w.log.inbox, 1);
  w.ready();
  await sleep(WAIT_MS * 3);
  assert.equal(w.log.inbox, 2, 'the retry never fired: the probe above would pass for the wrong reason');
  assert.equal(w.api.partState.inbox, 'ok');
});
