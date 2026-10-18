// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A fingerprint of the BEHAVIOUR of the index rules (see src/indexrules.mjs for what counts as a rule). Not a hash of source
// text: a refactor that changes no result leaves it alone, a change of a stopword, a stem, a weight, the field set, the drawer
// set, the shape rule or the compound splitter moves it. Everything is taken from the real modules, nothing is copied here;
// the only input of its own is the fixed set of probe words and lines below, which are part of the fingerprint's definition
// (change them and the recorded fingerprint changes too).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as memory from '../../src/memory.mjs';
import * as search from '../../src/search.mjs';
import { PACKS, pack } from '../../src/language.mjs';
import { BODY_FIELDS_BY_TYPE, NON_BODY_FIELDS } from '../../src/bodyfields.mjs';

const WORDS = [
  'running', 'runs', 'ran', 'databases', 'queries', 'quickly', 'happiness', 'stored', 'caches', 'cafe', 'café',
  'Wächter', 'waechter', 'Datenbanken', 'Verbindungen', 'größer', 'Straße', 'machten', 'gemacht', 'kleinste',
];
const PHRASES = [
  'The data-store was rebuilt, because the pull-request failed on src/a.mjs:12',
  'Die Datenbankverbindung fällt aus, weil der Wächter nicht läuft',
  'Sitzungspost an den Bibliothekar; naechste Schritte: AuthService.refreshToken prüfen',
];
const LINES = {
  decision: [
    { id: 'd1', ts: '2026-01-01T00:00:00Z', title: 'Use SQLite for the datastore', choice: 'SQLite', why: 'one file, no server', rejected: 'PostgreSQL', tags: ['db', 'storage'], topic: 'storage', class: 'tooling', asked: 'which database?', symbols: 'store.put' },
    { id: 'd2', ts: '2026-01-02T00:00:00Z', title: 'Datenbankverbindung prüfen', choice: 'Verbindung', why: 'Datenbank und Verbindung getrennt', tags: 'x, y' },
  ],
  error: [{ id: 'e1', ts: '2026-01-03T00:00:00Z', title: 'Boom in src/a.mjs', text: 'it broke twice quickly', why: 'cache', class: 'looks-right', file: 'src/a.mjs' }],
  event: [{ id: 'v1', ts: '2026-01-04T00:00:00Z', title: 'Release 1.0', text: 'shipped the running version' }],
  timeline: [{ id: 't1', ts: '2026-01-05T00:00:00Z', title: 'Status', fact: 'the server runs in a container', text: 'since January' }],
  thought: [
    { id: 'h1', ts: '2026-01-06T00:00:00Z', title: 'alpha one', text: 'alpha healthy words', why: 'because', author: 'alice' },
    { id: 'h2', ts: '2026-01-06T00:00:01Z', title: 'poison', text: 'alpha poisoned', author: { toString: 'x' } },
    { id: 'h3', ts: '2026-01-06T00:00:02Z', title: 5, text: 'a number in a text field' },
    { id: 'h4', ts: '2026-01-06T00:00:03Z', title: 'list flag without a list', text: 'tags true', tags: true },
  ],
  learning: [{ id: 'l1', ts: '2026-01-07T00:00:00Z', title: 'Learned', learning: 'check the stamps first', text: 'and the rules', why: 'stale index' }],
  duty: [{ id: 'u1', ts: '2026-01-08T00:00:00Z', title: 'Owed', duty: 'send the report', text: 'to the team' }],
  question: [{ id: 'q1', ts: '2026-01-09T00:00:00Z', title: 'Open', text: 'who owns the queue?' }],
  procedure: [{ id: 'p1', ts: '2026-01-10T00:00:00Z', title: 'Release steps', rule: 'tag then push', steps: ['build', 'test', 'publish'] }],
  workflow: [{ id: 'w1', ts: '2026-01-11T00:00:00Z', title: 'Deploy flow', steps: ['build', 'ship'], body: 'snippet body text' }],
  snippet: [{ id: 's1', ts: '2026-01-12T00:00:00Z', title: 'Snippet', body: 'select * from entries', text: 'a query' }],
  card: [{ id: 'c1', ts: '2026-01-13T00:00:00Z', title: 'Card of a decision', card_question: 'which?', target_id: 'd1' }],
};

const h = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sortedEntries = (m) => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** The probes of the language packs: stopword lists, normalisation, stemming, tokenisation with and without a lexicon. */
function packFacts() {
  const out = {};
  const lexicon = new Set(['data', 'store', 'datenbank', 'verbindung', 'post', 'sitzung']);
  for (const [code, p] of Object.entries(PACKS)) {
    out[code] = {
      stop: [...p.stopwords].sort(),
      words: WORDS.map((w) => p.stem(p.normalize(w.toLowerCase()))),
      compounds: p.compounds, linking: p.linkingChars,
      tokens: PHRASES.map((t) => search.tokenize(t, { lang: p, lexicon })),
    };
  }
  const n = pack('xx');
  out.neutral = { words: WORDS.map((w) => n.stem(n.normalize(w.toLowerCase()))), tokens: PHRASES.map((t) => search.tokenize(t, { lang: n })) };
  return out;
}

/** The index of the fixed lines: what is indexed, under which terms and weights, and the statistics drawn from them. */
function indexFacts(language) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rulesfp-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'fp', participants: ['a'], language }));
    const put = (type, project, rows, extra = '') => {
      const p = memory.logPath(root, type, project);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${rows.map((r) => JSON.stringify({ v: 1, authority: 'agent', ...r })).join('\n')}\n${extra}`);
    };
    for (const [type, rows] of Object.entries(LINES)) put(type, null, rows, type === 'error' ? 'not json at all\n' : '');
    put('decision', 'proj', [{ id: 'dp', ts: '2026-02-01T00:00:00Z', title: 'Project decision about caches', choice: 'keep', why: 'the Wächter runs' }]);
    const idx = search.buildIndex(root, { language });
    const docs = idx.documents.map((d) => ({
      id: d.entry.id, type: d.type, project: d.project, line: d.line, lang: d.lang, certain: d.langCertain, enc: d.enc ?? false,
      length: d.length, weights: sortedEntries(d.weights), exp: d.expOnly ? [...d.expOnly].sort() : null,
    })).sort((a, b) => (a.id < b.id ? -1 : 1));
    return {
      docs, N: idx.N, avgLength: idx.avgLength, statsN: idx.statsN, statsAvgLength: idx.statsAvgLength,
      docFreq: sortedEntries(idx.docFreq), statsDocFreq: sortedEntries(idx.statsDocFreq),
      lexicon: [...idx.lexicon].sort(), lexicons: [...idx.lexicons].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, s]) => [c, [...s].sort()]),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** The facts as named parts, so a red test can say WHICH part of the rules moved. */
export function ruleFacts() {
  return {
    packs: packFacts(),
    fieldWeights: search.FIELD_WEIGHTS,
    bodyFields: BODY_FIELDS_BY_TYPE,
    nonBodyFields: NON_BODY_FIELDS,
    drawers: { types: Object.keys(memory.TYPES), searched: memory.SEARCH_TYPES },
    raw: { weight: search.RAW_WEIGHT, cap: search.RAW_CAP },
    index: indexFacts('en'),
  };
}

export function partHashes(facts = ruleFacts()) {
  return Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, h(v)]));
}

export function ruleFingerprint(facts = ruleFacts()) {
  return h(partHashes(facts));
}
