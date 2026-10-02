// SPDX-License-Identifier: MIT
// Writes expansions.jsonl: the asked_as of every extracted note (step c).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus } from '../scale.mjs';
import { goldAskedAs, fillerAskedAs } from './expand.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const notes = fs.readFileSync(path.join(HERE, 'notes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const { root } = buildCorpus(947);
const fill = new Map();
try {
  for (const f of fs.readdirSync(path.join(root, 'global'))) {
    for (const l of fs.readFileSync(path.join(root, 'global', f), 'utf8').split('\n')) if (l.trim()) { const e = JSON.parse(l); fill.set(e.id, e); }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
const out = notes.map((n) => ({ id: n.id, asked_as: n.src === 'gold' ? goldAskedAs(n.id) : fillerAskedAs(fill.get(n.id)) }));
const bad = out.filter((o) => !o.asked_as || o.asked_as.length < 8 || o.asked_as.length > 12);
if (bad.length) throw new Error(`bad: ${bad.map((b) => b.id)}`);
fs.writeFileSync(path.join(HERE, 'expansions.jsonl'), out.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`${out.length} notes expanded`);
