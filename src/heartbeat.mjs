// src/heartbeat.mjs — is an agent running, or does it just have
// nothing to say?
//
// **The finding (2026-09-08, reference deployment).** For twenty
// hours no agent but one session had written anything: the curator
// silent for 20 h, the vm admin for 32, the connected foreign agent
// never. Whether they were RUNNING could not be established — there is
// no signal separate from work output. "Dead" and "nothing to do" look
// identical, and while that is true a watchdog has nothing to watch.
//
// --- Why it lives in git and still does not sprawl -------------------
//
// A local watchdog pulse file is not enough: it sits on THE machine the
// agent runs on. Anyone asking from outside whether that agent is alive
// never sees it.
//
// So: a log in git. But a pulse every three minutes would be 480 lines
// per agent per day — the memory would be buried under its own pulse
// measurement. Hence a QUIET PERIOD: at most one new line every
// `MIN_GAP_MIN` minutes per agent. An agent may call as often as it
// likes; writing happens rarely.
//
// What this measures and what it does not: a line means "this agent was
// running at this time and could write". It does NOT mean it is doing
// its job. That second question is answered by what it logged — which
// is why `mem agents` shows both side by side.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// At the root of the memory, next to global/ and inbox/ — not in a
// subdirectory of its own. A memory laid out by `mem init` has four
// places; a fifth for one file would be tidiness bought with a lookup
// nobody makes.
export const LOG = 'heartbeat.jsonl';
export const MIN_GAP_MIN = 60;

const file = (root) => path.join(root, LOG);

/** All lines, oldest first. Broken ones are COUNTED, not swallowed. */
export function read(root) {
  let raw;
  try { raw = fs.readFileSync(file(root), 'utf8'); } catch { return { lines: [], broken: 0 }; }
  const lines = []; let broken = 0;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if (e && typeof e === 'object' && e.agent) lines.push(e); else broken += 1;
    } catch { broken += 1; }
  }
  return { lines, broken };
}

/** The newest heartbeat per agent. */
export function latest(root) {
  const map = new Map();
  for (const e of read(root).lines) {
    const before = map.get(e.agent);
    if (!before || String(e.ts) > String(before.ts)) map.set(e.agent, e);
  }
  return map;
}

/**
 * Set a heartbeat — or leave it, if the last one is still fresh.
 *
 * Returns `{ written, why }`. `written: false` is the NORMAL case, not
 * a failure: the quiet period is the whole point.
 */
export function beat(root, agent, {
  now = new Date(), what = null, where = null, minGapMin = MIN_GAP_MIN,
} = {}) {
  const name = String(agent ?? '').trim();
  if (!name) return { written: false, why: 'no agent name' };
  const t = new Date(now);
  const before = latest(root).get(name);
  if (before) {
    const age = (t - new Date(before.ts)) / 60000;
    if (age < minGapMin) {
      return { written: false, why: `last beat is ${Math.round(age)} min old (quiet period ${minGapMin} min)` };
    }
  }
  const line = {
    agent: name,
    ts: t.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    where: where ?? os.hostname(),
    ...(what ? { what: String(what).slice(0, 200) } : {}),
  };
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  fs.appendFileSync(file(root), `${JSON.stringify(line)}\n`);
  return { written: true, line };
}

/**
 * How old a heartbeat is, in minutes — or `null` if there never was one.
 *
 * `null` is deliberately not `Infinity`: "never seen" and "not seen for
 * a long time" are different statements, and the first usually means
 * the agent does not call the heartbeat at all.
 */
export function ageMin(root, agent, { now = new Date() } = {}) {
  const e = latest(root).get(String(agent));
  if (!e) return null;
  return Math.max(0, (new Date(now) - new Date(e.ts)) / 60000);
}
