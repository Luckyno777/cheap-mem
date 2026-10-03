#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * injection-by-origin.mjs — the evaluation of the injection journal as ONE
 * command, split by where the session ran (port of lucky-mem's
 * abruf-auswertung, ceb244cb).
 *
 *   node bench/injection-by-origin.mjs [--root <dir>] [--before <iso>] [--after <iso>]
 *        [--occasion question,before] [--json]
 *
 * Per occasion and per origin (cloud | ssh | local | unknown; a missing
 * field in old lines = unknown): line count, p50/p95 of duration_ms
 * (nearest rank), the share path=server among lines WITH a path, and the
 * path_reason count (null = no server was asked). --after T: only lines
 * with ts >= T, --before T: only ts < T. Read-only.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read } from '../src/injection.mjs';
import { originNormal } from '../src/origin.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Nearest rank; an empty series is null (not measurable is not zero milliseconds). */
export function rankValue(xs, p) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

/** Filter lines and summarise per occasion x origin. Pure, no file access. */
export function summarise(lines, { before = null, after = null, occasions = null } = {}) {
  const groups = new Map();
  for (const z of lines) {
    if (!z || typeof z !== 'object') continue;
    const ts = String(z.ts ?? '');
    if (after && !(ts >= after)) continue;
    if (before && !(ts < before)) continue;
    const occasion = typeof z.occasion === 'string' ? z.occasion : 'unknown';
    if (occasions && !occasions.includes(occasion)) continue;
    const origin = originNormal(z.origin);
    const key = `${occasion}\u0000${origin}`;
    if (!groups.has(key)) groups.set(key, { occasion, origin, n: 0, durations: [], withPath: 0, server: 0, reasons: {} });
    const g = groups.get(key);
    g.n += 1;
    if (Number.isFinite(z.duration_ms)) g.durations.push(z.duration_ms);
    if (typeof z.path === 'string') {
      g.withPath += 1;
      if (z.path === 'server') g.server += 1;
      const reason = z.path_reason == null ? 'no-server' : String(z.path_reason);
      g.reasons[reason] = (g.reasons[reason] ?? 0) + 1;
    }
  }
  return [...groups.values()]
    .map((g) => ({
      occasion: g.occasion,
      origin: g.origin,
      n: g.n,
      p50_ms: rankValue(g.durations, 0.5),
      p95_ms: rankValue(g.durations, 0.95),
      with_path: g.withPath,
      server_share: g.withPath ? Math.round((g.server / g.withPath) * 1000) / 1000 : null,
      path_reasons: g.reasons,
    }))
    .sort((a, b) => a.occasion.localeCompare(b.occasion) || a.origin.localeCompare(b.origin));
}

/** A readable table. */
export function table(rows) {
  const head = ['occasion', 'origin', 'n', 'p50_ms', 'p95_ms', 'with_path', 'server_share', 'path_reasons'];
  const body = rows.map((r) => [r.occasion, r.origin, r.n, r.p50_ms ?? '-', r.p95_ms ?? '-', r.with_path,
    r.server_share ?? '-', Object.entries(r.path_reasons).map(([k, v]) => `${k}=${v}`).join(' ') || '-']);
  return [head, ...body].map((r) => r.join('\t')).join('\n');
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const A = parseArgs(process.argv.slice(2));
  const { lines, broken, present } = read(path.resolve(typeof A.root === 'string' ? A.root : REPO));
  if (!present) { console.error('no injection journal found (unknown, not zero)'); process.exitCode = 2; }
  else {
    const rows = summarise(lines, {
      before: typeof A.before === 'string' ? A.before : null,
      after: typeof A.after === 'string' ? A.after : null,
      occasions: typeof A.occasion === 'string' ? A.occasion.split(',') : null,
    });
    if (A.json) console.log(JSON.stringify({ broken, rows }, null, 2));
    else { console.log(table(rows)); if (broken) console.log(`# broken lines: ${broken}`); }
  }
}
