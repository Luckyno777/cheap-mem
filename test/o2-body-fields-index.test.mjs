// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// O2 (build plan block O, row O2) — the index half.
//
// One source for "what is an entry's content": src/bodyfields.mjs. This
// file holds the source itself and the search index to it:
//   - every type in memory.TYPES maps to at least one body field (red, naming the type),
//   - the SET of indexed fields (search.FIELD_WEIGHTS) is exactly
//     BODY_FIELDS + NON_BODY_FIELDS, every body field has a weight,
//   - a workflow is found by its `steps` and a snippet by its `body`
//     (before: by the title only).
// Red proof: against the start commit c23ad5c53e343fec5c5512b8d59920a6a9633dac
// (no src/bodyfields.mjs, `steps`/`body` not indexed) — see the O2 report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as config from '../src/config.mjs';

const bodyfields = await import('../src/bodyfields.mjs').catch(() => ({}));

test('O2: every type in memory.TYPES maps to at least one body field', () => {
  const table = bodyfields.BODY_FIELDS_BY_TYPE ?? {};
  const without = Object.keys(memory.TYPES)
    .filter((t) => !Array.isArray(table[t]) || table[t].length === 0);
  assert.deepEqual(without, [], `type(s) without a body field in bodyfields.BODY_FIELDS_BY_TYPE: ${without.join(', ')}`);
  // Positive control: the probe sees a type without a mapping.
  const broken = { ...table };
  delete broken.workflow;
  assert.deepEqual(Object.keys(memory.TYPES).filter((t) => !Array.isArray(broken[t]) || !broken[t].length),
    ['workflow']);
});

test('O2: the indexed field set is body fields + non-body fields, each with a weight', () => {
  const expected = new Set([...(bodyfields.BODY_FIELDS ?? []), ...(bodyfields.NON_BODY_FIELDS ?? [])]);
  const actual = new Set(Object.keys(search.FIELD_WEIGHTS));
  const unweighted = [...expected].filter((f) => !actual.has(f));
  const foreign = [...actual].filter((f) => !expected.has(f));
  assert.deepEqual(unweighted, [], `body field without a weight: ${unweighted.join(', ')}`);
  assert.deepEqual(foreign, [], `indexed field from no source: ${foreign.join(', ')}`);
  for (const f of Object.values(bodyfields.BODY_FIELDS_BY_TYPE ?? {}).flat()) {
    assert.ok(search.FIELD_WEIGHTS[f] > 0, `body field '${f}' has no positive weight`);
  }
  assert.ok(['steps', 'body'].every((f) => expected.has(f)), 'steps/body are not body fields');
  // Positive control: the probe reports a body field that lost its weight.
  const less = new Set([...actual].filter((f) => f !== 'steps'));
  assert.deepEqual([...expected].filter((f) => !less.has(f)), ['steps']);
});

test('O2: a workflow is found by its steps, a snippet by its body', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-o2-idx-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    config.writeConfig(root, config.DEFAULT_CONFIG);
    fs.mkdirSync(path.dirname(memory.logPath(root, 'workflow')), { recursive: true });
    fs.writeFileSync(memory.logPath(root, 'workflow'), `${JSON.stringify({
      id: 'o2wf1', ts: '2026-09-30T00:00:00Z', title: 'Release routine', issued_by: 'lucky',
      steps: ['file the cyclopean receipt', 'check the duplicate'],
    })}\n`);
    fs.writeFileSync(memory.logPath(root, 'snippet'), `${JSON.stringify({
      id: 'o2sn1', ts: '2026-09-30T00:00:00Z', title: 'Greeting', kind: 'text',
      body: 'Dear {{name}}, the quincunx arrived.',
    })}\n`);
    const index = search.buildIndex(root);
    const ids = (q) => search.search(index, q, { top: 5 }).map((h) => h.entry?.id);
    assert.ok(ids('cyclopean').includes('o2wf1'), 'a workflow step does not find the workflow — steps not indexed');
    assert.ok(ids('quincunx').includes('o2sn1'), 'the snippet body does not find the snippet — body not indexed');
    // Positive control: the titles find both anyway (the probe sees the entries).
    assert.ok(ids('routine').includes('o2wf1'), 'positive control: title does not find the workflow');
    assert.ok(ids('greeting').includes('o2sn1'), 'positive control: title does not find the snippet');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
