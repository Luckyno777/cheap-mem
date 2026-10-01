// Shared helper of the F5 source-text guards (not a test file).
// Reads source, drops comments, counts hits -- so a guard looks at CODE and
// not at the explanation above it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Block comments and whole-line comments removed; line count preserved. */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n');
}

/** All files under `rel` (recursive) that pass `filter`; relative paths. */
export function files(rel, filter, root = ROOT) {
  const out = [];
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return out;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') out.push(...files(r, filter, root)); }
    else if (filter(e.name)) out.push(r);
  }
  return out;
}

/** Hits of a pattern per line after comment removal: [{line, text}]. */
export function hits(text, pattern) {
  const out = [];
  stripComments(text).split('\n').forEach((l, i) => { if (pattern.test(l)) out.push({ line: i + 1, text: l.trim() }); });
  return out;
}

export function read(rel, root = ROOT) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
