// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-fair-cm): checks the decoy definition
// mechanically against the store's OWN words (no expansions exist yet):
//   far  = shares no content word with the store,
//   near = shares exactly one content word with the store.
// "Content word" = an index token of cm's English pack that is not in the
// generic Snowball stop list (src/search.mjs EXPAND_STOP). The store's
// words are the gold world's notes plus the filler generator's vocabulary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeGroupsMulti, EXPAND_STOP } from '../../src/search.mjs';
import { pack } from '../../src/language.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const toks = (text, langs = [pack('en')]) => new Set(tokenizeGroupsMulti(
  String(text).split(/\s+/).filter((w) => !EXPAND_STOP.has(w.toLowerCase())).join(' '), { langs }).flat());
const store = new Set();
const addAll = (t) => { for (const x of toks(t, [pack('en')])) store.add(x); for (const x of toks(t, [pack('de')])) store.add(x); };
for (const line of fs.readFileSync(path.join(HERE, '..', 'gold', 'world.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (r.data) addAll(JSON.stringify(Object.values(r.data)).replace(/[\[\]{}",:]/g, ' '));
}
const scale = fs.readFileSync(path.join(HERE, '..', 'scale.mjs'), 'utf8');
for (const name of ['TOPICS', 'VERBS', 'NOUNS', 'WHYS', 'TYPES']) {
  const m = scale.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  addAll(m[1].replace(/['\n,]/g, ' '));
}
addAll('seen again in near and tracked as');
export function overlap(q) { return [...toks(q)].filter((t) => store.has(t)); }
export const STORE = store;
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? path.join(HERE, 'decoys.jsonl');
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    const o = overlap(d.query);
    const ok = d.kind === 'far' ? o.length === 0 : o.length === 1;
    if (!ok) { bad += 1; console.log(`BAD ${d.id} ${d.kind} [${o.join(',')}] ${d.query}`); }
  }
  console.log(`${bad} decoys break the definition; store has ${store.size} content tokens`);
  process.exitCode = bad ? 1 : 0;
}
