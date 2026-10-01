// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// projectpackage — the dashboard's project package export (#sources/export),
// parity with lucky-mem's projektpaket (2026-10-01).
//
// **One selection, two outputs.** `select()` decides which rows belong in a
// package. The page's content preview (`?preview=1`) and the downloadable
// package call THE SAME function on THE SAME build of the dashboard cache
// (`/dashboard.json`) — the number on the page and the number in the package
// header cannot drift apart. Until 2026-10-01 the preview counted in the
// browser (`getExport()` in assets/dashboard/dashboard.js); the rule moved
// here, it was not copied.
//
// **Read only.** No write path, no task, no file on disk.
//
// **What does NOT go into a package** (EXCLUDED): raw captures, inbox mail,
// file bytes, key material. An entry keeps its origin pointer
// (`origin.raw` is a path, not raw text).
//
// **Encrypted entries stay encrypted.** The raw lines are read here through
// `memory.iterLog` — NOT through `dashboard.readPass`, which decrypts for the
// display (`shred.makeReveal`). The `body_enc` envelope goes into the package
// unchanged; only the plaintext fields beside it run through the redaction.
//
// **Redaction.** Every plaintext field (entries, reference titles, retirement
// reasons) runs through `redaction.redactEntry` — patterns plus the env match.
//
// **`why` only from raw lines.** The reason an entry was retired is text of
// the RETIRING line (`memory.retiredMap`: `e.why ?? e.text`). It is computed
// here from the raw lines again — never taken from the dashboard rows, which
// come from a display path that decrypts. It is dropped when the target line
// or the retiring line is encrypted.

import * as memory from './memory.mjs';
import * as viewer from './viewer.mjs';
import * as redaction from './redaction.mjs';

export const FORMAT = 'cheap-mem-project-package';
export const VERSION = 1;
const PREVIEW_CAP = 200;

const EXCLUDED = Object.freeze([
  'raw captures (the captured texts; only the origin pointer stays)',
  'inbox mail (messages between participants)',
  'file bytes (attachments, stores)',
  'key material (the crypto-shredding keyring)',
]);

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** `'1'|'true'|'yes'` -> true, `'0'|'false'|'no'` -> false, absent -> fallback, else null. */
function flag(value, fallback = true) {
  if (value == null || value === '') return fallback;
  const w = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(w)) return true;
  if (['0', 'false', 'no', 'off'].includes(w)) return false;
  return null;
}

/**
 * Check a request. `known`: the project names that exist (without 'global').
 * -> { ok:true, project, global, history } | { ok:false, code, reason }
 */
export function checkRequest(params, known) {
  const project = String(params.get('project') ?? '');
  if (!PROJECT_NAME.test(project)) return { ok: false, code: 400, reason: 'project missing or not a valid name' };
  const global = flag(params.get('global'));
  const history = flag(params.get('history'));
  if (global === null || history === null) return { ok: false, code: 400, reason: 'global/history: only 1 or 0' };
  if (project !== 'global' && !known.includes(project)) return { ok: false, code: 404, reason: `no project '${project}'` };
  return { ok: true, project, global, history };
}

/**
 * THE selection. `entries`: the rows of `/dashboard.json` (id, type, project,
 * state, out …). The same rule that stood in the browser: the project's rows,
 * plus the global ones when `global`; without `history` only `state ===
 * 'active'`. References: targets of `out` that are not in the package (once per id).
 */
export function select(entries, { project, global = true, history = true }) {
  const included = (entries || []).filter((e) => {
    const p = e.project || 'global';
    return (p === project || (global && p === 'global')) && (history || (e.state || 'active') === 'active');
  });
  const ids = new Set(included.map((e) => e.id));
  const refs = [...new Set(included.flatMap((e) => (e.out || []).map((r) => r[1])).filter((id) => !ids.has(id)))];
  return { included, refs };
}

/** The same rule as the page's `state.missing`: build 'ok' AND every row readable. */
function completeness(data) {
  const reasons = [];
  if (data?.state !== 'ok') reasons.push(...(data?.reasons?.length ? data.reasons : ['dashboard build not ok']));
  const unreadable = (data?.entries || []).filter((e) => !e.readable).length;
  if (unreadable) reasons.push(`${unreadable} entries without a readable line`);
  return { state: reasons.length ? 'unknown' : 'good', reasons };
}

function countsOf(x) {
  return {
    entries: x.included.length,
    fromProject: x.included.filter((e) => (e.project || 'global') === x.project).length,
    global: x.project === 'global' ? 0 : x.included.filter((e) => (e.project || 'global') === 'global').length,
    historical: x.included.filter((e) => (e.state || 'active') !== 'active').length,
    externalRefs: x.refs.length,
  };
}

/** For the page's content preview. No raw read, only the build. */
export function preview(data, opts) {
  const x = { ...select(data.entries, opts), project: opts.project };
  return {
    state: 'ok',
    selection: { project: opts.project, global: opts.global, history: opts.history },
    counts: countsOf(x),
    completeness: completeness(data),
    list: x.included.slice(0, PREVIEW_CAP).map((e) => ({ id: e.id, title: e.title })),
  };
}

/** Raw lines, WITHOUT decryption. -> { raw: Map 'project|type|id' -> [line…], all: [line…], reasons } */
function readRaw(root, projects) {
  const raw = new Map();
  const all = [];
  const reasons = [];
  for (const project of projects) {
    for (const type of Object.keys(memory.TYPES)) {
      try {
        for (const z of memory.iterLog(root, type, { project: project === 'global' ? null : project })) {
          if (!z || z.__broken) continue;
          all.push(z);
          if (!z.id) continue;
          const k = `${project}|${type}|${z.id}`;
          if (!raw.has(k)) raw.set(k, []);
          raw.get(k).push(z);
        }
      } catch (e) { reasons.push(`${project}/${type} not readable: ${e?.message || e}`); }
    }
  }
  return { raw, all, reasons };
}

function tally(sum, found) {
  for (const f of found) sum.set(f.type, (sum.get(f.type) ?? 0) + f.count);
}

/** Redact the plaintext; a `body_enc` envelope stays untouched. */
function redactLine(z, found, secrets) {
  const { body_enc: enc, ...clear } = z;
  const r = redaction.redactEntry(clear, { secrets });
  tally(found, r.found);
  return enc !== undefined ? { ...r.object, body_enc: enc } : r.object;
}

function redactText(t, found, secrets) {
  if (t == null) return null;
  const r = redaction.redactEntry(String(t), { secrets });
  tally(found, r.found);
  return r.object;
}

/**
 * The package. `data`: the build (`dashCache.get().data`), `cache`: its cache
 * meta. `secrets` injectable for probes only.
 */
export function build(root, data, opts, { cache = null, now = new Date(), secrets = null } = {}) {
  const x = { ...select(data.entries, opts), project: opts.project };
  const reasons = [...completeness(data).reasons];
  const { raw, all, reasons: rawReasons } = readRaw(root, ['global', ...memory.listProjects(root)]);
  reasons.push(...rawReasons);
  // `why` from the RAW lines only — see the header.
  const retired = memory.retiredMap(all);
  const byIdRaw = new Map();
  for (const z of all) if (z.id && !byIdRaw.has(z.id)) byIdRaw.set(z.id, z);
  const whyFromRaw = (z) => {
    if (!z || z.body_enc !== undefined) return null;
    const rec = retired.get(z.id);
    if (!rec?.why) return null;
    if (rec.by && byIdRaw.get(rec.by)?.body_enc !== undefined) return null;
    return rec.why;
  };
  const found = new Map();
  const handed = new Map();
  let encrypted = 0;
  let withoutLine = 0;
  const inPackage = new Set(x.included.map((e) => e.id));

  const entries = x.included.map((e) => {
    const k = `${e.project || 'global'}|${e.type}|${e.id}`;
    const i = handed.get(k) ?? 0;
    handed.set(k, i + 1);
    const z = raw.get(k)?.[i] ?? null;
    if (!z) withoutLine++;
    const enc = z?.body_enc !== undefined;
    if (enc) encrypted++;
    const why = whyFromRaw(z);
    return {
      id: e.id,
      type: e.type,
      project: e.project || 'global',
      state: e.state || 'active',
      ...(why ? { why: redactText(why, found, secrets) } : {}),
      encrypted: enc,
      relations: (e.out || []).map(([kind, id]) => ({ kind, id, inPackage: inPackage.has(id) })),
      entry: z ? redactLine(z, found, secrets) : null,
    };
  });
  if (withoutLine) reasons.push(`${withoutLine} chosen entries without a readable raw line (entry: null)`);

  // References: id + type + title, never the content. The title only from
  // the RAW line — an encrypted entry has no title in the package.
  const rowById = new Map();
  for (const e of data.entries || []) if (!rowById.has(e.id)) rowById.set(e.id, e);
  const refs = x.refs.map((id) => {
    const e = rowById.get(id);
    if (!e) return { id, type: null, project: null, title: null, known: false };
    const z = raw.get(`${e.project || 'global'}|${e.type}|${id}`)?.[0] ?? null;
    const enc = z?.body_enc !== undefined;
    return {
      id, type: e.type, project: e.project || 'global',
      title: z && !enc ? redactText(viewer.headline(z), found, secrets) : null,
      encrypted: enc, known: true,
    };
  });

  return {
    header: {
      format: FORMAT,
      version: VERSION,
      created: now.toISOString(),
      code: { commit: data.meta?.git?.head ?? null },
      dataState: { at: data.at ?? null, cache },
      selection: { project: opts.project, global: opts.global, history: opts.history },
      counts: { ...countsOf(x), encrypted, withoutRawLine: withoutLine },
      completeness: { state: reasons.length ? 'unknown' : 'good', reasons },
      excluded: EXCLUDED,
      encryption: 'Encrypted entries carry their body_enc envelope unchanged (ciphertext); the server decrypts nothing for the export.',
      redaction: { applied: true, found: [...found].map(([type, count]) => ({ type, count })) },
    },
    entries,
    refs,
  };
}

/** `cheap-mem-<project>-<YYYY-MM-DD>.json` */
export function fileName(project, now = new Date()) {
  return `cheap-mem-${project}-${now.toISOString().slice(0, 10)}.json`;
}
