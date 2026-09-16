// A guard that reads a field nobody sets does nothing, quietly, for weeks.
//
// Four instances in ten days, in the sibling project. Each time the same
// shape: a decision depends on a field, no write path sets it, the guard
// silently passes. A guard that never fires is indistinguishable from a
// guard with nothing to report — that is what made it cost weeks rather
// than minutes each time.
//
// `bench/field-without-writer.mjs` is the instrument. This file is the
// proof that it can find something. On the live corpus it reports zero
// findings, and zero is exactly the answer that needs a control: the
// three cuts that came before this one also reported plausible numbers,
// and two of them were measuring the wrong thing.
//
// Four assertions, one per requirement:
//
//   A  a real reader-without-writer is found
//   B  a field that IS set is not reported
//   C  finding nothing to analyse is not a pass
//   D  a sabotaged instrument goes red
// Covers assurances from shared/invariants.jsonl. The id is the
// shared language between the houses; the prose there names the
// incident that forced it.
// invariant: feld-ohne-schreiber
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entscheidungsFelder, imBestand, befund, ENTSCHEIDUNGS_MUSTER }
  from '../bench/field-without-writer.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A corpus and a codebase, built to order.
 *
 * Deliberately modelled on the real defect of 2026-09-08: a message
 * header field that a bolt reads and no writer fills. The header form
 * matters — three of the four real cases were NOT in the log, and an
 * instrument that only reads `.jsonl` would have called them clean.
 */
function bau({ antwortAufWert = '', extraLog = {} } = {}) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'fow-'));
  fs.mkdirSync(path.join(w, 'post'), { recursive: true });
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });

  // Two messages. `Antwort-Auf` is present as a header and empty —
  // exactly the state the real bug had for a month.
  for (const n of ['a', 'b']) {
    fs.writeFileSync(path.join(w, 'post', `${n}.md`),
      `Von: sitzung\nAn: chatgpt\nBetreff: ${n}\nAntwort-Auf: ${antwortAufWert}\n\nRumpf.\n`);
  }
  fs.writeFileSync(path.join(w, 'log.jsonl'),
    `${JSON.stringify({ id: 'x1', ts: '2026-09-16T10:00:00Z', klasse: 'a', ...extraLog })}\n`
    + `${JSON.stringify({ id: 'x2', ts: '2026-09-16T11:00:00Z', klasse: 'b', ...extraLog })}\n`);

  // A bolt that DECIDES on that header, and one that decides on a field
  // the log really carries.
  fs.writeFileSync(path.join(w, 'src', 'riegel.mjs'),
    'export function passt(kopf, eintrag) {\n'
    + "  if (kopf['Antwort-Auf']) return 'bezug';\n"
    + "  if (eintrag.klasse === 'a') return 'klasse-a';\n"
    + '  return null;\n}\n');
  return w;
}
const weg = (w) => fs.rmSync(w, { recursive: true, force: true });

const fahre = (w) => befund({
  code: entscheidungsFelder([path.join(w, 'src')]),
  bestand: imBestand(w),
});

// --- A ----------------------------------------------------------------

test('A: a field a decision depends on, never carrying a value, is found', () => {
  const w = bau({ antwortAufWert: '' });
  try {
    const r = fahre(w);
    const t = r.treffer.find((x) => x.feld === 'Antwort-Auf');
    assert.ok(t, `not found. Checked ${r.geprueft} fields, found ${r.treffer.length}`);
    assert.equal(t.gesehen, 2, 'it should count both messages carrying the empty header');
    assert.deepEqual(t.form, ['kopf'], 'the header form has to be recognised as its own shape');
  } finally { weg(w); }
});

test('A2: the header shape is read at all — three of four real cases lived there', () => {
  // Without this the instrument could pass A through the .jsonl path
  // alone and still be blind to exactly the cases that motivated it.
  const w = bau();
  try {
    const b = imBestand(w);
    assert.ok(b.felder.has('Betreff'), 'message headers are not being read');
    assert.ok([...b.felder.get('Betreff').form].includes('kopf'));
    assert.ok(b.felder.has('klasse'), 'log entries are not being read');
  } finally { weg(w); }
});

// --- B ----------------------------------------------------------------

test('B: a field that IS set somewhere is not reported', () => {
  const w = bau({ antwortAufWert: '2026-09-15T20-13-14Z--sitzung-an-chatgpt.md' });
  try {
    const r = fahre(w);
    assert.equal(r.treffer.find((x) => x.feld === 'Antwort-Auf'), undefined,
      'a filled field was reported — the instrument would cry wolf');
    assert.deepEqual(r.treffer, [], `unexpected findings: ${r.treffer.map((t) => t.feld).join(', ')}`);
  } finally { weg(w); }
});

test('B2: ONE filled occurrence is enough to clear a field', () => {
  // The real corpus has fields that are legitimately empty on most
  // entries and carry a value on a few. Reporting those would make the
  // instrument useless within a week.
  const w = bau({ antwortAufWert: '' });
  try {
    fs.writeFileSync(path.join(w, 'post', 'c.md'),
      'Von: a\nAn: b\nBetreff: c\nAntwort-Auf: a.md\n\nRumpf.\n');
    const r = fahre(w);
    assert.equal(r.treffer.find((x) => x.feld === 'Antwort-Auf'), undefined,
      'two empty and one filled still counts as written');
  } finally { weg(w); }
});

test('B3: a field the corpus never saw is NOT a finding', () => {
  // Most fields a program reads are local variables. Mixing them in
  // would bury eleven real answers under seven hundred — measured.
  const w = bau();
  try {
    fs.appendFileSync(path.join(w, 'src', 'riegel.mjs'),
      'export const f = (o) => (o.irgendeinLokalesDing ? 1 : 2);\n');
    const r = fahre(w);
    assert.equal(r.treffer.find((x) => x.feld === 'irgendeinLokalesDing'), undefined);
    assert.ok(r.unbekannt > 0, 'unknown fields are not being counted separately');
  } finally { weg(w); }
});

// --- C ----------------------------------------------------------------

test('C: analysing nothing is NOT a pass', () => {
  // The whole family of defects this instrument chases is "a check that
  // silently does nothing". It must not become one.
  const leer = fs.mkdtempSync(path.join(os.tmpdir(), 'fow-leer-'));
  try {
    const r = befund({ code: entscheidungsFelder([leer]), bestand: imBestand(leer) });
    assert.equal(r.geprueft, 0);
    assert.deepEqual(r.treffer, []);
    // The command turns this into exit 2, not exit 0 — the assertion
    // here is that the report says so rather than looking clean.
    assert.equal(r.bestandsdateien, 0,
      'an empty corpus must be visible as empty, not as healthy');
  } finally { weg(leer); }
});

test('C2: the patterns still match how this code is written', () => {
  // A positive control against THIS repository. If the codebase is
  // refactored into a shape the patterns miss, every run afterwards
  // reports a clean bill of health without checking anything.
  const code = entscheidungsFelder([path.join(REPO, 'src'), path.join(REPO, 'bin')]);
  assert.ok(code.size > 100,
    `only ${code.size} decision fields found in src+bin — the patterns no longer `
    + 'match this codebase, and every finding below is vacuous');
  assert.ok(ENTSCHEIDUNGS_MUSTER.length >= 4, 'a pattern was dropped');
});

// --- D ----------------------------------------------------------------

test('D: an instrument that only reads the log would miss the real cases', () => {
  // The sabotage that matters, because it is the shape of the mistake
  // that was actually made twice while building this: reading one
  // persistence form and calling the rest clean.
  const w = bau({ antwortAufWert: '' });
  try {
    const nurJsonl = { felder: new Map(), dateien: 0 };
    for (const [k, v] of imBestand(w).felder) {
      if ([...v.form].includes('jsonl')) nurJsonl.felder.set(k, v);
    }
    nurJsonl.dateien = 1;
    const r = befund({ code: entscheidungsFelder([path.join(w, 'src')]), bestand: nurJsonl });
    assert.equal(r.treffer.find((x) => x.feld === 'Antwort-Auf'), undefined,
      'this sabotage is supposed to HIDE the finding — if it still shows, '
      + 'the test is not testing what it claims');
  } finally { weg(w); }
});
