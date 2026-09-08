/**
 * Onboarding instead of configuration.
 *
 * **The finding (2026-09-07/08, reference deployment).** A connected
 * foreign agent had `mem_log` available for a whole day and used it
 * not once. It was CONFIGURED — inbox created, bridge connected, tools
 * visible — and still not connected. We noticed after a day, by
 * counting.
 *
 * So a new agent should not be configured but ONBOARDED: there is a
 * list of steps, each of them mechanically checkable, and the last one
 * proves the whole loop — write and find again. After that you know on
 * day ONE whether it is connected.
 *
 * **What this file explicitly does NOT do.** It does not onboard. It
 * CHECKS. A step counts because something in the memory evidences it —
 * never because somebody ticked it. A tick you can set without having
 * done the thing is the configuration illusion in new clothes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from './memory.mjs';
import * as agents from './agents.mjs';
import * as heartbeat from './heartbeat.mjs';

/** The tag the probe entry has to carry. */
export const PROBE_TAG = 'onboarding';

/**
 * The steps. The order is intentional: each assumes the previous, and
 * the last is the only one that proves the loop.
 */
export const STEPS = Object.freeze([
  'inbox',      // registered and addressable
  'houserules', // the text it hears on connecting exists
  'written',    // has ever left an entry under its own name
  'heartbeat',  // has ever reported that it is running
  'loop',       // probe entry: written AND findable again
]);

function checkInbox(root, name, participants) {
  const registered = Object.hasOwn(participants ?? {}, name);
  if (!registered) {
    return { state: 'red', why: 'no inbox — nobody can write to it',
      todo: `mem agent new ${name} --role "..."` };
  }
  let known = false;
  try { known = agents.listAgents(root).some((a) => a.name === name); } catch { /* none */ }
  return { state: 'green', why: known ? `agents/${name}/ exists and is addressable` : 'addressable as a configured participant' };
}

/**
 * The house rules ship with the PACKAGE, not with the memory.
 *
 * That is the architectural difference from the reference deployment,
 * where memory and code are one repository. Here cheap-mem is an
 * installed tool and the memory root is the user's data — looking for
 * HOUSE-RULES.md under the memory root would find nothing in every
 * normal installation, and the step would be permanently red for a
 * reason that has nothing to do with the agent.
 */
export const HOUSE_RULES = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'HOUSE-RULES.md');

function checkHouseRules(root, houseRulesPath) {
  const p = houseRulesPath;
  if (!fs.existsSync(p)) {
    return { state: 'red', why: `${path.basename(p)} missing`,
      todo: 'write the house rules — without them a foreign agent hears nothing from us' };
  }
  const size = fs.statSync(p).size;
  return size > 200
    ? { state: 'green', why: `house rules present (${size} bytes, sent as instructions)` }
    : { state: 'red', why: 'house rules are nearly empty', todo: `fill ${p}` };
}

function ownEntries(root, name) {
  const out = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      let res;
      try { res = memory.readLog(root, type, { project }); } catch { continue; }
      for (const e of res.entries) {
        if (e.__broken) continue;
        if (e.agent === name) out.push({ ...e, _type: type, _project: project });
      }
    }
  }
  return out;
}

function checkWritten(name, own) {
  return own.length
    ? { state: 'green', why: `${own.length} entr${own.length === 1 ? 'y carries' : 'ies carry'} its name` }
    : { state: 'red',
      why: 'has never written — exactly the state a connected agent sat in for a whole day',
      todo: 'have it write ONE entry (see the probe task below)' };
}

function checkHeartbeat(root, name) {
  const age = heartbeat.ageMin(root, name, {});
  if (age === null) {
    return { state: 'red',
      why: 'never a heartbeat — "dead" and "had nothing to do" look the same',
      todo: `CHEAP_MEM_AGENT=${name} mem heartbeat` };
  }
  return { state: 'green', why: `last seen ${Math.round(age)} min ago` };
}

/**
 * The one step that proves the LOOP: an entry this agent wrote, that
 * carries the probe tag — and that the ordinary search finds again.
 *
 * Both halves have to hold. Written alone would mean it can send.
 * Findable means the way back stands too.
 */
function checkLoop(root, name, own) {
  const probe = own.find((e) => Array.isArray(e.tags) && e.tags.includes(PROBE_TAG));
  if (!probe) {
    return { state: 'red', why: `no entry tagged '${PROBE_TAG}'`,
      todo: probeTask(name).join('\n      ') };
  }
  // Found again over the same literal path the hooks take — not over a
  // direct file read. Otherwise the check tests its own setup instead
  // of the lane.
  let hits = [];
  try { hits = memory.find(root, probe.id, {}); } catch { /* empty stays empty */ }
  return hits.some((e) => e.id === probe.id)
    ? { state: 'green', why: `probe ${probe.id} written AND found again` }
    : { state: 'red', why: `probe ${probe.id} exists but is not findable`,
      todo: 'check the index: mem doctor' };
}

/** The task the agent has to carry out ITSELF. Not a tick. */
export function probeTask(name) {
  return [
    'The AGENT gets this task — not us on its behalf:',
    `  "Write an entry: type thought, tags ${PROBE_TAG},`,
    '   text = what you are doing right now. Then find it again and tell me its id."',
    'Over the bridge: mem_log, then mem_find.',
    `At the CLI:      CHEAP_MEM_AGENT=${name} mem log thought --tags ${PROBE_TAG} --text "..."`,
  ];
}

/**
 * The whole status. Reads only.
 *
 * `done` is true only when EVERY step is green — there is no
 * "essentially onboarded".
 */
export function status(root, name, { participants = {}, houseRules = HOUSE_RULES } = {}) {
  const own = ownEntries(root, name);
  const steps = {
    inbox: checkInbox(root, name, participants),
    houserules: checkHouseRules(root, houseRules),
    written: checkWritten(name, own),
    heartbeat: checkHeartbeat(root, name),
    loop: checkLoop(root, name, own),
  };
  const openSteps = STEPS.filter((s) => steps[s].state !== 'green');
  return { agent: name, steps, open: openSteps, done: openSteps.length === 0 };
}
