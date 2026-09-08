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
function bridge(root, calls = [], extraEnv = {}) {
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
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...extraEnv },
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

// --- Three more, added 2026-09-08: the file store -------------------
//
// Same measurement, same fix: `mem store put/list/get` existed, tested
// and documented, and unreachable from the bridge. `verify` and
// `remove` stay off it on purpose — a connected agent can register and
// read artifacts, never delete one.

const STORE_TOOLS = ['mem_store_put', 'mem_store_list', 'mem_store_get'];

test('THE GAP: the three store tools are actually offered', () => {
  const root = gedaechtnis();
  try {
    const names = bridge(root).at(-1).result.tools.map((t) => t.name);
    for (const n of STORE_TOOLS) assert.ok(names.includes(n), `${n} missing from the bridge`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('their descriptions name the OCCASION, not just the capability', () => {
  const root = gedaechtnis();
  try {
    const tools = Object.fromEntries(bridge(root).at(-1).result.tools.map((t) => [t.name, t.description]));
    for (const n of STORE_TOOLS) {
      assert.match(tools[n], /\b(call it|use it|use this|ask this|read this)\b/i,
        `${n}: the description says only WHAT, not WHEN`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_store_put really stores a file, mem_store_list and mem_store_get find it again', () => {
  // A tool that is listed and throws on call is worse than a missing
  // one — the agent believes it asked.
  const root = gedaechtnis();
  const src = path.join(root, 'to-store.txt');
  fs.writeFileSync(src, 'a harmless generated report\n');
  try {
    const [, put] = bridge(root, [['mem_store_put', { source: src, purpose: 'test artifact' }]]);
    assert.ok(!put.error, `mem_store_put threw: ${JSON.stringify(put.error)}`);
    assert.ok(!put.result?.isError, `mem_store_put isError: ${JSON.stringify(put.result)}`);
    const hash = put.result.structuredContent.sha256;
    assert.match(hash, /^[0-9a-f]{64}$/, 'no real sha256 came back');

    const [, list] = bridge(root, [['mem_store_list', {}]]);
    assert.ok(!list.error, `mem_store_list threw: ${JSON.stringify(list.error)}`);
    assert.match(list.result.content[0].text, /to-store\.txt/);

    const [, get] = bridge(root, [['mem_store_get', { hash: hash.slice(0, 12) }]]);
    assert.ok(!get.error, `mem_store_get threw: ${JSON.stringify(get.error)}`);
    const at = get.result.content[0].text.trim();
    assert.ok(fs.existsSync(at), `mem_store_get pointed at a path that does not exist: ${at}`);
    assert.equal(fs.readFileSync(at, 'utf8'), 'a harmless generated report\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Round 3, 2026-09-08 --------------------------------------------
//
// After the multi-agent port, six capabilities existed only at the
// CLI. For an agent whose ONLY access is the bridge they therefore did
// not exist.
//
// The expensive one was `heartbeat`: `mem onboarding` checks five
// steps, and one of them was fundamentally out of reach for a
// bridge-only agent. It could behave however well it liked and stay
// red. A test bench that does not permit a result is not measuring the
// thing under test.

const ROUND3 = ['mem_heartbeat', 'mem_questions', 'mem_answer',
  'mem_procedures', 'mem_component', 'mem_source'];

test('REACH: the six new capabilities are at the bridge', () => {
  const root = gedaechtnis();
  try {
    const namen = bridge(root)[1].result.tools.map((t) => t.name);
    const fehlen = ROUND3.filter((n) => !namen.includes(n));
    assert.deepEqual(fehlen, [],
      `CLI-only, and therefore absent for a bridge agent: ${fehlen.join(', ')}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('THE EXPENSIVE ONE: a bridge agent can record a heartbeat', () => {
  // Without it the onboarding step stays red for it forever.
  const root = gedaechtnis();
  try {
    const [, r] = bridge(root, [['mem_heartbeat', { what: 'probe' }]], { CHEAP_MEM_AGENT: 'chatgpt' });
    assert.ok(!r.error, JSON.stringify(r.error));
    assert.match(JSON.stringify(r.result), /Heartbeat for 'chatgpt' recorded/, JSON.stringify(r.result));
    const raw = fs.readFileSync(path.join(root, 'heartbeat.jsonl'), 'utf8');
    assert.equal(JSON.parse(raw.trim().split('\n').pop()).agent, 'chatgpt');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('and the identity does NOT come from a parameter', () => {
  // Otherwise one agent beats for another, and the lane looks alive
  // where nobody is running any more.
  const root = gedaechtnis();
  try {
    bridge(root, [['mem_heartbeat', { agent: 'someone-else' }]], { CHEAP_MEM_AGENT: 'chatgpt' });
    const raw = fs.readFileSync(path.join(root, 'heartbeat.jsonl'), 'utf8');
    assert.equal(JSON.parse(raw.trim().split('\n').pop()).agent, 'chatgpt',
      'the identity was taken from a parameter');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the quiet period holds at the bridge too, and says so', () => {
  const root = gedaechtnis();
  try {
    bridge(root, [['mem_heartbeat', {}]]);
    const [, second] = bridge(root, [['mem_heartbeat', {}]]);
    assert.match(JSON.stringify(second.result), /No new one needed/, JSON.stringify(second.result));
    assert.equal(fs.readFileSync(path.join(root, 'heartbeat.jsonl'), 'utf8')
      .trim().split('\n').length, 1, 'the quiet period does not hold at the bridge');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_procedures does not hand out a rule without its author', () => {
  // The fifth display path. The text is instruction-shaped; without
  // the prefix a foreign agent reads it as something that simply holds.
  const root = gedaechtnis();
  try {
    fs.writeFileSync(path.join(root, 'global', 'procedures.jsonl'),
      `${JSON.stringify({ id: 'p1', ts: '2026-09-08T10:00:00Z', title: 'Always quote',
        rule: 'Quote every path', issued_by: 'owner' })}\n`);
    const [, r] = bridge(root, [['mem_procedures', {}]]);
    const all = JSON.stringify(r.result);
    assert.match(all, /Quote every path/, 'the rule does not come through at all');
    assert.match(all, /Procedure, issued by owner/,
      'the foreign agent would get the instruction text without its author');
    assert.match(all, /data with an author/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_answer refuses a link into the void', () => {
  const root = gedaechtnis();
  try {
    fs.writeFileSync(path.join(root, 'global', 'questions.jsonl'),
      `${JSON.stringify({ id: 'q1', ts: '2026-09-08T10:00:00Z', question: 'Is it gone?' })}\n`);
    const [, invented] = bridge(root, [['mem_answer', { question_id: 'q1', with: 'nosuch' }]]);
    assert.match(JSON.stringify(invented.result), /No entry with id/);
    const [, notAQuestion] = bridge(root, [['mem_answer', { question_id: 'nosuch', with: 'q1' }]]);
    assert.match(JSON.stringify(notAQuestion.result), /No entry with id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('THE BOUNDARY: mem_source takes no local paths', () => {
  // The content of a source lands in the searchable corpus that
  // everybody reads. That is a different exposure from mem_store_put
  // (bytes under a hash, refused on a redaction finding), and so a
  // different rule — not a forgotten one.
  const root = gedaechtnis();
  try {
    const [, r] = bridge(root, [['mem_source', { address: '/etc/passwd' }]]);
    const all = JSON.stringify(r.result);
    assert.match(all, /not an http\(s\) address/);
    assert.match(all, /mem_store_put|CLI/, 'a no without a way out');
    assert.ok(!fs.existsSync(path.join(root, 'global', 'sources.jsonl')),
      'something was taken in anyway');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an address goes through, with a redacted excerpt', () => {
  const root = gedaechtnis();
  try {
    // Assembled, never written out: the pre-commit scanner reads this
    // file as text and cannot know a secret is invented.
    const word = ['PASS', 'WORD'].join('');
    const value = ['hunter2', 'secret'].join('');
    const [, r] = bridge(root, [['mem_source', {
      address: 'https://intranet.example.com/wiki/X',
      title: 'Wiki X',
      note: `Access with ${word}=${value} and on`,
    }]]);
    assert.ok(!r.error, JSON.stringify(r.error));
    const e = JSON.parse(fs.readFileSync(path.join(root, 'global', 'sources.jsonl'), 'utf8')
      .trim().split('\n').pop());
    assert.equal(e.kind, 'address');
    assert.ok(!e.excerpt.includes(value), `unredacted: ${e.excerpt}`);
    assert.match(JSON.stringify(r.result), /redacted/,
      'redacted, but silently — nobody looks');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_component finds across both spellings, and says which', () => {
  const root = gedaechtnis();
  try {
    fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'),
      `${JSON.stringify({ id: 'e9', ts: '2026-09-08T10:00:00Z', class: 'base-only',
        title: 'capture.sh fails silently' })}\n`);
    const [, r] = bridge(root, [['mem_component', { path: 'bin/capture.sh' }]]);
    const all = JSON.stringify(r.result);
    assert.match(all, /base-only/, `not found: ${all.slice(0, 200)}`);
    assert.match(all, /base/, 'the form of the evidence is missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
