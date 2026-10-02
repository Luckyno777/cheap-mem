// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-fair-cm), step (a): extract NOTE TEXTS only.
//   - every gold demo note (bench/gold/world.jsonl), as bench/expand/extract-notes.mjs did;
//   - a deterministic sample of 200 synthetic filler notes: bench/scale.mjs
//     buildCorpus(947, seed 42) (the filler of a 1k store), indices 0, 4, 8, ... 796.
//     The generator is sequential, so these exact notes exist at 1k, 10k and 100k.
// No questions, no decoys, no group names are read here.
// Output: bench/expand-fair/notes.jsonl  {id, src, type, text}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus } from '../scale.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['id', 'agent', 'replaces', 'supersedes', 'ts']);
const textOf = (data) => {
  const parts = [];
  for (const [k, v] of Object.entries(data)) {
    if (SKIP.has(k)) continue;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) parts.push(v.join(', '));
  }
  return parts.join(' | ');
};
const out = [];
for (const line of fs.readFileSync(path.join(HERE, '..', 'gold', 'world.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (!r.type || !r.data) continue;
  out.push({ id: r.data.id ?? null, src: 'gold', type: r.type, text: textOf(r.data) });
}
if (process.env.MEM_EXPAND) throw new Error('run without MEM_EXPAND');
const { root } = buildCorpus(947);
try {
  const all = new Map();
  for (const f of fs.readdirSync(path.join(root, 'global'))) {
    if (!f.endsWith('.jsonl')) continue;
    const type = f.replace(/s\.jsonl$/, '');
    for (const line of fs.readFileSync(path.join(root, 'global', f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      all.set(e.id, { id: e.id, src: 'filler', type, text: textOf(e) });
    }
  }
  for (let i = 0; i < 800; i += 4) out.push(all.get(`s${i.toString(36)}`));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
fs.writeFileSync(path.join(HERE, 'notes.jsonl'), out.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`${out.length} notes (${out.filter((o) => o.src === 'gold').length} gold, ${out.filter((o) => o.src === 'filler').length} filler)`);
