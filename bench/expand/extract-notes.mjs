// SPDX-License-Identifier: MIT
// Measurement helper (agent/expand-measure-cm): extracts ONLY the note texts of the
// gold demo world (bench/gold/world.jsonl) — no questions, no group names, no decoys.
// Output: bench/expand/notes-only.jsonl  {id, type, text}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['id', 'agent', 'replaces', 'supersedes']);
const out = [];
for (const line of fs.readFileSync(path.join(HERE, '..', 'gold', 'world.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (!r.type || !r.data) continue;
  const parts = [];
  for (const [k, v] of Object.entries(r.data)) {
    if (SKIP.has(k)) continue;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) parts.push(v.join(', '));
  }
  out.push({ id: r.data.id ?? null, type: r.type, text: parts.join(' | ') });
}
fs.writeFileSync(path.join(HERE, 'notes-only.jsonl'), out.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`${out.length} notes`);
