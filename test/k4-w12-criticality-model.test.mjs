// K4 + W12 (ported from the sibling house, 2026-10-02): criticality and
// per-model rows in the agent ledger.
//
//   K4  a job without a valid `criticality` counts as "critical, unknown"
//       - counted and shown, NEVER silently uncritical.
//   W12 per model (across agent kinds): jobs, the three stages, red probes
//       over the jobs that REPORTED them (none reported: null, not 0).
//
// Red proof (rule 3): on the base commit 1d8f6c5 `ledger()` had no
// `byModel` and no `criticalUnknown`, and `buildJobFields` dropped
// criticality/red_probes. The positive controls show a marked job is NOT
// counted as unknown, so the probe tells the two apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as ledger from '../src/agentledger.mjs';

const NO_GIT = () => '';
function build() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-k4w12-'));
  fs.mkdirSync(path.join(w, 'global'), { recursive: true });
  fs.mkdirSync(path.join(w, 'projects'), { recursive: true });
  return w;
}
const wipe = (w) => fs.rmSync(w, { recursive: true, force: true });
function job(w, pkg, fields, extra = {}) {
  memory.logEntry(w, 'event', {
    title: `Job ${pkg}`, text: `Job ${pkg}, synthetic.`, tags: ['job', 'agents'],
    agent: 'human:root', ...ledger.buildJobFields({ package: pkg, first_try: true, ...fields }), ...extra,
  });
}

test('K4: criticalityOf - only a valid value counts, everything else is critical, unknown', () => {
  assert.equal(ledger.criticalityOf({ criticality: 'critical' }), ledger.CRIT.CRITICAL);
  assert.equal(ledger.criticalityOf({ criticality: ' Uncritical ' }), ledger.CRIT.UNCRITICAL);
  for (const e of [{}, { criticality: '' }, { criticality: 'uncritcal' }, { criticality: 3 }, null]) {
    assert.equal(ledger.criticalityOf(e), ledger.CRIT.UNKNOWN, JSON.stringify(e));
  }
});

test('K4: buildJobFields carries criticality and red_probes, and refuses invalid ones', () => {
  const f = ledger.buildJobFields({ package: 'P', first_try: true, criticality: 'uncritical', red_probes: 2 });
  assert.equal(f.criticality, 'uncritical');
  assert.equal(f.red_probes, 2);
  const none = ledger.buildJobFields({ package: 'P', first_try: true });
  assert.ok(!('criticality' in none) && !('red_probes' in none), 'absent stays absent (not 0, not uncritical)');
  assert.throws(() => ledger.buildJobFields({ package: 'P', first_try: true, criticality: 'meh' }));
  assert.throws(() => ledger.buildJobFields({ package: 'P', first_try: true, red_probes: -1 }));
  assert.throws(() => ledger.buildJobFields({ package: 'P', first_try: true, red_probes: 1.5 }));
});

test('K4 + W12: ledger counts critical-unknown and red probes per model', () => {
  const w = build();
  try {
    job(w, 'A1', { model: 'Sonnet 5', agent_kind: 'builder', criticality: 'uncritical', red_probes: 2 });
    job(w, 'A2', { model: 'Sonnet 5', agent_kind: 'reviewer' });                       // unmarked
    job(w, 'A3', { model: 'Sonnet 5', agent_kind: 'builder', criticality: 'critical', red_probes: 1 });
    job(w, 'B1', { model: 'Opus 5.5', agent_kind: 'orchestrator' }, { criticality: 'typo' }); // invalid
    const r = ledger.ledger(w, { git: NO_GIT });
    assert.equal(r.criticalUnknown, 2, 'unmarked and invalid both count as critical, unknown');
    const sonnet = r.byModel.find((m) => m.model === 'Sonnet 5');
    const opus = r.byModel.find((m) => m.model === 'Opus 5.5');
    assert.equal(sonnet.jobs, 3, 'per model across agent kinds');
    assert.equal(sonnet.criticalUnknown, 1, 'positive control: marked jobs are not unknown');
    assert.equal(sonnet.redProbes, 3);
    assert.equal(sonnet.redProbesReported, 2);
    assert.equal(opus.redProbes, null, 'none reported is null, never 0');
    assert.equal(opus.criticalUnknown, 1);
    const rowBuilder = r.rows.find((x) => x.agent_kind === 'builder');
    assert.equal(rowBuilder.criticalUnknown, 0);
    const text = ledger.reportText(r);
    assert.match(text, /Per model/);
    assert.match(text, /Sonnet 5: 3 job\(s\).*red probes 3 \(2\/3 reported\), critical unknown 1/);
    assert.match(text, /Opus 5\.5: 1 job\(s\).*red probes unknown/);
    assert.match(text, /2 of 4 job\(s\) carry no valid marking and count as "critical, unknown"/);
  } finally { wipe(w); }
});
