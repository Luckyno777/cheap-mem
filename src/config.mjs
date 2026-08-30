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
 */

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR = '.mem';
export const CONFIG_FILE = 'config.json';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  participants: {
    user: 'The human. Messages here are questions for them.',
    session: 'Any AI coding session (Claude, Cursor, ChatGPT, ...) working for the user.',
    librarian: 'The permanent curator session running locally.',
  },
  defaultBranch: 'main',
  defaultRemote: 'origin',
  language: 'en',
});

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
  return { ...DEFAULT_CONFIG, ...raw, participants: { ...raw.participants } };
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
