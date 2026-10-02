// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * skilleffect — the rate "offered -> fetched" of the question hook's
 * skill offer (twin of lucky-mem's H7), from what is recorded; no model,
 * nothing written. Denominator: journal lines `skill-offer`. Numerator: a
 * `mem_skill_fetch` tool call or `mem skills fetch <name>` in the raw
 * capture of the SAME session (`raw.sessionFingerprint`) within
 * WINDOW_MIN, counted for the last offer of that skill before it.
 * "Fetched" means requested, not "it helped"; subagents are invisible.
 * Not measurable is not zero: an offer whose window the capture does not
 * cover is `unobserved`; below MIN_N observed offers the rate is null.
 */

import * as injection from './injection.mjs';
import * as raw from './raw.mjs';
import * as skillregistry from './skillregistry.mjs';

/** Minutes "after the offer" (one or two answer rounds). A setting, printed with every display. */
export const WINDOW_MIN = 30;
/** Minimum OBSERVED offers for a rate (0 of 9 still reaches ~30 % upper bound). */
export const MIN_N = 10;
const Z95 = 1.96;

/** Wilson interval (95 %) for k of n; null for n = 0. */
export function wilson(k, n) {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = Z95 * Z95;
  const mid = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, mid - half), high: Math.min(1, mid + half) };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const BASH_FETCH = /\bmem(?:\.mjs)?\s+skills?\s+fetch\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})/g;
const MCP_FETCH = /(?:^|__)mem_skill_fetch$/;

/** Fetch calls in one capture line: names/ids as written. */
export function fetchesIn(z) {
  const out = [];
  if (!z || z.type !== 'assistant' || !Array.isArray(z.message?.content)) return out;
  for (const x of z.message.content) {
    if (!x || x.type !== 'tool_use') continue;
    if (typeof x.name === 'string' && MCP_FETCH.test(x.name)) {
      const n = x.input?.name;
      if (typeof n === 'string' && NAME.test(n.trim())) out.push(n.trim());
    } else if (x.name === 'Bash' && typeof x.input?.command === 'string') {
      for (const m of x.input.command.matchAll(BASH_FETCH)) out.push(m[1]);
    }
  }
  return out;
}

const ms = (t) => { const n = Date.parse(t); return Number.isNaN(n) ? null : n; };

/**
 * Pure evaluation over data already read (for probes without a disk).
 *   offers:   [{ts, session, ids[]}]
 *   fetches:  [{session, skill(id), ms}]
 *   coverage: Map session -> last observed time (ms) of its captures
 *   names:    Map id -> name
 */
export function compute({ offers, fetches, coverage, names, windowMin = WINDOW_MIN, minN = MIN_N }) {
  const win = windowMin * 60000;
  const single = [];
  for (const o of offers) for (const id of o.ids) single.push({ id, session: o.session, t: ms(o.ts) });
  const bySkill = new Map();
  single.forEach((e, i) => {
    if (e.t === null || !e.session) return;
    const k = `${e.session}|${e.id}`;
    if (!bySkill.has(k)) bySkill.set(k, []);
    bySkill.get(k).push(i);
  });
  const fetched = new Set();
  for (const f of fetches) {
    let best = -1;
    for (const i of bySkill.get(`${f.session}|${f.skill}`) ?? []) {
      const t = single[i].t;
      if (t <= f.ms && f.ms - t <= win && (best < 0 || t >= single[best].t)) best = i;
    }
    if (best >= 0) fetched.add(best);
  }
  const per = new Map();
  const row = (id) => {
    if (!per.has(id)) per.set(id, { id, name: names.get(id) ?? id, offered: 0, fetched: 0, notFetched: 0, unobserved: 0, fetchedUnobserved: 0 });
    return per.get(id);
  };
  single.forEach((e, i) => {
    const s = row(e.id);
    s.offered += 1;
    const end = coverage.get(e.session);
    const covered = e.t !== null && e.session && end != null && end >= e.t + win;
    if (!covered) { if (fetched.has(i)) s.fetchedUnobserved += 1; else s.unobserved += 1; return; }
    if (fetched.has(i)) s.fetched += 1; else s.notFetched += 1;
  });
  const value = (o) => {
    const n = o.fetched + o.notFetched;
    const ok = n >= minN;
    return { ...o, observed: n, rate: ok ? o.fetched / n : null, interval: ok ? wilson(o.fetched, n) : null,
      state: ok ? 'measured' : 'unknown',
      reason: ok ? null : `only ${n} observed offers (minimum ${minN}) — rate unknown, not 0` };
  };
  const skills = [...per.values()].map(value).sort((a, b) => b.offered - a.offered || a.name.localeCompare(b.name));
  const sum = { id: null, name: 'overall', offered: 0, fetched: 0, notFetched: 0, unobserved: 0, fetchedUnobserved: 0 };
  for (const x of skills) for (const k of ['offered', 'fetched', 'notFetched', 'unobserved', 'fetchedUnobserved']) sum[k] += x[k];
  return { windowMin, minN, skills, overall: value(sum) };
}

/** The measurement: `{ state: 'measured'|'unknown'|'empty', reason, skills[], overall, capturesRead }`. Never throws. */
export function measure(root) {
  const none = (state, reason) => ({ state, reason, windowMin: WINDOW_MIN, minN: MIN_N, skills: [], overall: null, capturesRead: 0 });
  let j;
  try { j = injection.read(root); } catch (e) { return none('unknown', `journal unreadable: ${e?.message || e}`); }
  if (!j.present) return none('unknown', 'no injection journal on this machine');
  const offers = j.lines.filter((z) => z?.occasion === injection.OCCASION.SKILL_OFFER && Array.isArray(z.sources))
    .map((z) => ({ ts: z.ts, session: z.session ? raw.sessionFingerprint(z.session) : null, ids: z.sources.filter((q) => typeof q === 'string') }));
  if (!offers.length) return none('empty', 'no skill offer in the journal yet (the hook offered nothing)');

  let items = [];
  try { items = skillregistry.registry(root); } catch { items = []; }
  const toId = new Map();
  for (const i of items) { toId.set(i.id, i.id); toId.set(i.name, i.id); }
  const idOf = (q) => toId.get(String(q).replace(new RegExp(`^${skillregistry.PREFIX}`), '')) ?? null;
  const names = new Map(items.map((i) => [i.id, i.name]));

  const sessions = new Set(offers.map((o) => o.session).filter(Boolean));
  const fetches = [];
  const coverage = new Map();
  let read = 0; let why = null;
  try {
    for (const c of raw.capturesWithState(root)) {
      if (c.state !== 'present' || !c.fingerprint || !sessions.has(c.fingerprint)) continue;
      let cp;
      try { cp = raw.readCapture(root, c.path); } catch { continue; }
      read += 1;
      let end = ms(cp.header?.__stamp?.ts_to);
      for (const z of cp.lines) {
        const t = ms(z?.timestamp);
        if (t === null) continue;
        if (end === null || t > end) end = t;
        for (const f of fetchesIn(z)) { const id = idOf(f); if (id) fetches.push({ session: c.fingerprint, skill: id, ms: t }); }
      }
      if (end !== null && (!coverage.has(c.fingerprint) || end > coverage.get(c.fingerprint))) coverage.set(c.fingerprint, end);
    }
  } catch (e) { why = `raw capture unreadable: ${e?.message || e}`; }
  const r = compute({ offers, fetches, coverage, names });
  const g = r.overall;
  return { ...r, capturesRead: read, state: g.state, reason: g.state === 'measured' ? null : (why ? `${g.reason}; ${why}` : g.reason) };
}

const pct = (x) => `${Math.round(x * 100)} %`;
function line(s) {
  const q = s.rate === null ? 'unknown' : `${pct(s.rate)} (95 % interval ${pct(s.interval.low)}..${pct(s.interval.high)})`;
  const rest = [];
  if (s.unobserved) rest.push(`${s.unobserved} unobserved`);
  if (s.fetchedUnobserved) rest.push(`${s.fetchedUnobserved} fetched without coverage (not in the rate)`);
  return `${s.name}: ${s.offered} offered, ${s.fetched} of ${s.observed} observed fetched -> ${q}${rest.length ? `; ${rest.join(', ')}` : ''}`;
}

export function asText(e) {
  const out = [`Skill effect: offered -> fetched, window ${e.windowMin} min, minimum ${e.minN} observed offers`];
  if (!e.overall) { out.push(`  ${e.state}: ${e.reason}`); return out.join('\n'); }
  out.push(`  ${line(e.overall)}`);
  for (const s of e.skills) out.push(`  - ${line(s)}`);
  if (e.state !== 'measured') out.push(`  Overall unknown: ${e.reason}`);
  out.push('  "fetched" means requested (mem_skill_fetch / mem skills fetch), not "it helped". '
    + 'Subagents are not captured; an offer counts as "not fetched" only when the capture covers the window.');
  return out.join('\n');
}
