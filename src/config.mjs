// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * config — reads .mem/config.json from the memory root.
 *
 * Design goal: no hardcoded names. The user runs `mem init` once and
 * picks who lives in this memory (participants), what the default
 * branch is called, and where the memory root lives on disk.
 *
 * Three states, never two: no config, malformed config, valid config.
 * A missing config is a friendly error with a hint to run `mem init`,
 * not a silent default that lies later.
 *
 * **A participant's value** is either a plain string (a role
 * description only — the original, still-supported shape) or an
 * object `{ role, human }`. `human: true` is the ONLY way a
 * participant is the memory's human — nothing here ever assumes a
 * key named `user` means "the human" (that was the bug: renaming the
 * key silently broke the desk's inbox and P1b's reply form). See
 * `humanParticipant()` below, the single place that decision is made.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as agents from './agents.mjs';

export const CONFIG_DIR = '.mem';
export const CONFIG_FILE = 'config.json';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  participants: {
    user: { role: 'The human. Messages here are questions for them.', human: true },
    session: 'Any AI coding session (Claude, Cursor, ChatGPT, ...) working for the user.',
    librarian: 'The permanent curator session running locally.',
  },
  defaultBranch: 'main',
  defaultRemote: 'origin',
  language: 'en',
});

/** The role text of a participant, whichever shape its value has. */
export function roleOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.role === 'string') return value.role;
  return '';
}

/** True only for the object shape with `human: true` — never guessed from a name. */
export function isHuman(value) {
  return Boolean(value) && typeof value === 'object' && value.human === true;
}

/**
 * Which configured participant is the memory's human — the one thing
 * `src/dashboard.mjs`'s desk and P1b's `/inbox/reply` both need and
 * neither may hardcode (design rule 3: no participant names in `src/`).
 *
 * Three honest outcomes, never a silent guess:
 *   - `{ name, reason: null }`       exactly one participant is marked.
 *   - `{ name: null, reason }`       none is marked (a fresh legacy
 *                                    config, or one that renamed its
 *                                    human away without moving the
 *                                    mark) — `reason` says so, by name.
 *   - `{ name: null, reason }`       MORE than one is marked — refused
 *                                    rather than picking either.
 */
export function humanParticipant(participants) {
  if (!participants || typeof participants !== 'object') {
    return { name: null, reason: 'no memory config here' };
  }
  const marked = Object.keys(participants).filter((name) => isHuman(participants[name]));
  if (marked.length === 1) return { name: marked[0], reason: null };
  if (marked.length > 1) {
    return {
      name: null,
      reason: `${marked.length} participants are marked "human": true (${marked.join(', ')}) — `
        + 'exactly one must be',
    };
  }
  return {
    name: null,
    reason: 'no participant is marked "human": true in .mem/config.json — '
      + 'add it to the one that is you',
  };
}

export function configPath(root) {
  return path.join(root, CONFIG_DIR, CONFIG_FILE);
}

export function readConfig(root) {
  const p = configPath(root);
  if (!fs.existsSync(p)) {
    const err = new Error(
      `No memory config at ${p}.\n` +
      `  Run: mem init      (in ${root})\n` +
      `  Or point --root at an existing memory.`);
    err.code = 'ENOCONFIG';
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Config at ${p} is not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Config at ${p} is not an object`);
  }
  if (!raw.participants || typeof raw.participants !== 'object') {
    throw new Error(`Config at ${p} has no 'participants' map`);
  }
  // Registered agents are participants too. Without this, creating an
  // agent would not make it addressable — `mem post write --to vm-admin`
  // would be refused, and the inbox could not actually route to it no
  // matter how many agents existed. The config list stays the floor: it
  // holds roles (a human, a session) that are not agents, and it has to
  // keep working when `agents/` is missing (fresh clone, half a setup).
  const participants = { ...raw.participants };
  try {
    for (const a of agents.listAgents(root)) {
      if (!Object.hasOwn(participants, a.name)) {
        participants[a.name] = a.role || `agent: ${a.name}`;
      }
    }
  } catch { /* no agents/ — then just the configured ones */ }
  return { ...DEFAULT_CONFIG, ...raw, participants };
}

export function writeConfig(root, cfg) {
  const p = configPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return p;
}

/**
 * Locate the memory root walking up from `start`.
 * Root = a directory containing .mem/config.json. Returns null if none.
 */
export function findRoot(start) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, CONFIG_DIR, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
