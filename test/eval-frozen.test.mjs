// Der final-Split ist eingefroren. Dieser Test ist das Siegel.
//
// Nach dem Einfrieren (2026-09-06) darf an diesen Aufgaben nichts mehr
// geaendert werden: keine Umformulierung, keine gelockerte Regel, keine
// Sonderbehandlung. Sonst misst der Abschlusslauf, wie gut die Aufgaben
// an das Ergebnis angepasst wurden.
//
// Wenn dieser Test rot wird, ist das keine Kleinigkeit: entweder wurde
// eine eingefrorene Aufgabe angefasst, oder das Einfrieren war nicht
// gemeint. Beides gehoert besprochen, nicht weggedrueckt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TASKS } from '../eval/tasks.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const EVAL = path.join(HIER, '..', 'eval');

test('der eingefrorene final-Split ist unveraendert', () => {
  const jetzt = TASKS.filter((t) => t.split === 'final').map((t) => ({
    id: t.id, klasse: t.klasse, gold: t.gold, prompt: t.prompt,
    must: t.must.map(String), mustNot: t.mustNot.map(String),
    gates: Object.fromEntries(Object.entries(t.gates ?? {}).map(([k, v]) => [k, v.map(String)])),
  }));
  const json = JSON.stringify(jetzt, null, 2);
  const hash = createHash('sha256').update(json).digest('hex');
  const erwartet = fs.readFileSync(path.join(EVAL, 'final-eingefroren.sha256'), 'utf8').trim();
  assert.equal(hash, erwartet,
    'Der final-Split wurde nach dem Einfrieren veraendert. Wenn das Absicht war, '
    + 'muss das Einfrieren mit einer Begruendung neu gesetzt werden — und der '
    + 'Abschlusslauf zaehlt dann nicht mehr als unabhaengig.');
});

test('die Kennzahl "erfundene Zahlen" ist vorab festgelegt und deterministisch', async () => {
  const { erfundeneZahlen } = await import('../eval/tasks.mjs');
  // Positivkontrolle und Negativkontrolle, damit ein Nullergebnis spaeter
  // von einer kaputten Kennzahl unterscheidbar bleibt.
  const a = erfundeneZahlen('Der Port ist 3000.', 'Auf welchem Port?', '[F] Port 9443');
  const b = erfundeneZahlen('Port 9443.', 'Auf welchem Port?', '[F] Port 9443');
  assert.equal(a.erfunden, 1, 'eine Zahl aus dem Nichts muss zaehlen');
  assert.equal(b.erfunden, 0, 'eine Zahl aus dem Kontext darf nicht zaehlen');
});
