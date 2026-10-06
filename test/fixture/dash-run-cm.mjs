// test/fixture/dash-run-cm.mjs — cuts original functions out of assets/dashboard/dashboard.js
// (column 0 up to the closing brace in column 0) and assembles them with stubs.
// DASH_JS=<file> takes another state (red proof against the fixed old hash).
// Exports only; nothing runs on import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const dashSource = () => fs.readFileSync(process.env.DASH_JS || path.join(ROOT, 'assets', 'dashboard', 'dashboard.js'), 'utf8');

export function fn(src, name) {
  for (const head of [`async function ${name}(`, `function ${name}(`]) {
    const i = src.indexOf('\n' + head);
    if (i < 0) continue;
    const j = src.indexOf('\n}\n', i + 1);
    if (j < 0) throw new Error('end not found: ' + name);
    return src.slice(i + 1, j + 2);
  }
  return null;
}
export function constant(src, name) {
  const m = src.match(new RegExp(`^const ${name} = [^\\n]*;$`, 'm'));
  return m ? m[0] : null;
}
export function helperBlock(src) {
  const a = src.indexOf('// --- run-helper-cm');
  const b = src.indexOf('// --- end run-helper-cm');
  return a >= 0 && b > a ? src.slice(a, b) : '';
}
// Builds `new Function(...)` from preamble + helper + functions/constants; `stubs` are parameters (e.g. fetch, Date).
export function build({ preamble = '', functions = [], constants = [], expose = [], stubs = {} }) {
  const src = dashSource();
  const parts = [preamble, helperBlock(src)];
  for (const k of constants) { const z = constant(src, k); if (z) parts.push(z); }
  for (const f of functions) { const z = fn(src, f); if (z) parts.push(z); }
  const names = Object.keys(stubs);
  const exposed = expose.map((r) => `get ${JSON.stringify(r)}() { return typeof ${r} === 'undefined' ? undefined : ${r}; }`).join(', ');
  return new Function(...names, parts.join('\n') + `\nreturn { ${exposed} };`)(...names.map((n) => stubs[n]));
}
// An answer the test releases by hand; reacts to an AbortSignal like fetch.
export function handAnswer(signal) {
  let ok, no;
  const p = new Promise((a, b) => { ok = a; no = b; });
  const abort = () => no(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  return { p, signal, answer: (json, status = 200) => ok({ ok: status < 400, status, json: async () => json }) };
}
export const tick = (n = 5) => new Promise((r) => { let i = 0; const s = () => (++i >= n ? r() : setImmediate(s)); setImmediate(s); });
