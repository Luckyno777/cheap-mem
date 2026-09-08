// Was die CLI kann und was ein angeschlossener Agent davon erreicht.
//
// **Der Befund, 2026-09-08.** 35 CLI-Befehle, 11 MCP-Werkzeuge. `links`,
// `experiences`, `topics`, `facts`, `show` und `explain` waren gebaut,
// getestet und dokumentiert — und fuer jeden Fremdagenten schlicht nicht
// vorhanden. Er konnte den Kanten-Graphen nicht ablaufen, keinen
// Themenfaden verfolgen und nicht fragen, warum etwas NICHT kam.
//
// Dasselbe Muster wie beim Loggen am selben Tag, eine Ebene tiefer:
// nicht "die Faehigkeit fehlt", sondern "sie ist von dort, wo
// gearbeitet wird, nicht erreichbar".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

/** Ein Gedaechtnis mit genug Inhalt, dass jedes Werkzeug etwas zu sagen hat. */
function gedaechtnis() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reach-'));
  const mem = (...a) => spawnSync('node', [path.join(REPO, 'bin', 'mem'), ...a],
    { cwd: root, encoding: 'utf8', timeout: 30000 });
  mem('init');
  mem('log', 'error', '--class', 'quoting', '--title', 'unquoted bash path', '--topic', 'install/windows');
  mem('log', 'learning', '--title', 'quote every path', '--topic', 'install/windows');
  mem('log', 'timeline', '--key', 'server.users', '--value', '13', '--valid_from', '2026-07-13');
  return root;
}

/** Ein Handshake plus beliebig viele Aufrufe, in einem Prozess. */
function bridge(root, calls = []) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  if (!calls.length) lines.push(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  for (const [name, args] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }));
  }
  const r = spawnSync('node', [MCP], {
    input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root },
  });
  return String(r.stdout).split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
}

const PFLICHT = ['mem_links', 'mem_show', 'mem_experiences', 'mem_topics', 'mem_facts', 'mem_explain'];

test('DER FALL: die sechs Werkzeuge werden ueberhaupt angeboten', () => {
  const root = gedaechtnis();
  try {
    const namen = bridge(root).at(-1).result.tools.map((t) => t.name);
    for (const n of PFLICHT) assert.ok(namen.includes(n), `${n} fehlt an der Bruecke`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('und sie ANTWORTEN auch, statt nur in der Liste zu stehen', () => {
  // Ein Werkzeug, das gelistet ist und beim Aufruf wirft, ist schlimmer
  // als eines, das fehlt: der Agent glaubt, es gefragt zu haben.
  const root = gedaechtnis();
  try {
    const antworten = bridge(root, [
      ['mem_experiences', {}], ['mem_topics', {}], ['mem_facts', {}],
    ]).slice(1);
    assert.equal(antworten.length, 3, 'nicht jeder Aufruf hat geantwortet');
    for (const a of antworten) {
      assert.ok(!a.error, `Fehler statt Antwort: ${JSON.stringify(a.error)}`);
      assert.ok(!a.result?.isError, `isError: ${JSON.stringify(a.result)}`);
      assert.ok(a.result.content[0].text.trim().length > 0, 'leere Antwort');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_facts nennt den derzeit gueltigen Wert', () => {
  const root = gedaechtnis();
  try {
    const [, a] = bridge(root, [['mem_facts', {}]]);
    assert.match(a.result.content[0].text, /server\.users/);
    assert.match(a.result.content[0].text, /13/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_topics ohne Schluessel listet die Themen, mit Schluessel den Faden', () => {
  // Ein Agent, der die Themennamen nicht kennt, kann nach keinem fragen.
  const root = gedaechtnis();
  try {
    const [, liste, faden] = bridge(root, [
      ['mem_topics', {}], ['mem_topics', { key: 'install/windows' }],
    ]);
    assert.match(liste.result.content[0].text, /install\/windows/);
    const zeilen = faden.result.content[0].text.trim().split('\n');
    assert.equal(zeilen.length, 2, 'der Faden soll beide Eintraege zeigen');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('die Beschreibungen der neuen Werkzeuge nennen den ANLASS', () => {
  // Dieselbe Lehre wie bei mem_find und mem_log: ein Werkzeug, dessen
  // Anlass niemand nennt, wird nicht benutzt. Die Liste steht in jedem
  // Zug im Kontext — dort gehoert das Wann hin, nicht nur das Was.
  const root = gedaechtnis();
  try {
    const tools = Object.fromEntries(bridge(root).at(-1).result.tools.map((t) => [t.name, t.description]));
    for (const n of PFLICHT) {
      assert.match(tools[n], /\b(call it|use it|use this|ask this|read this)\b/i,
        `${n}: die Beschreibung sagt nur WAS, nicht WANN`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
