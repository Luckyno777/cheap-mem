// stores.mjs — the usual places people keep files, found by name.
//
// **Why this is not just "it's a path".** When the archive was built I
// wrote that any store the operating system can mount is a path, so no
// adapter is needed. That is true for a NAS share and for a plain
// folder. It is only HALF true for a consumer cloud drive, and the
// missing half matters:
//
//   1. **Nobody knows the path.** Google Drive on macOS lives under
//      `~/Library/CloudStorage/GoogleDrive-<account>/My Drive`, with the
//      account in the directory name. Asking a user to type that is a
//      setup step that fails silently when they get it slightly wrong.
//
//   2. **A file there can stop being a file.** Files On-Demand (Google
//      Drive, OneDrive, Dropbox) and iCloud's "Optimise Storage" evict
//      local copies and leave a placeholder. Reading one may block for
//      seconds, or fail outright when the machine is offline. That is
//      the same class as an unmounted NAS — but it happens to a folder
//      that looks perfectly normal in a file listing.
//
//   3. **Sync is not a write barrier.** `writeFileSync` returning means
//      the bytes are on the local disk, not that they left the machine.
//      A capture written one second before a laptop is closed may never
//      arrive anywhere.
//
// So: the paths are found by name, and the caller is TOLD when the
// chosen store is a syncing one. None of these three problems is
// solvable from here — the memory can only refuse to pretend they do
// not exist. Point 2 is already covered where it counts: a capture that
// cannot be read arrives as an error, never as an empty result.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `sync: true` means the store copies files elsewhere in the background.
 * That flag is the whole reason this table has a shape rather than
 * being a list of paths: it decides whether the user gets warned.
 */
export const STORES = Object.freeze([
  {
    id: 'local',
    label: 'A folder on this machine',
    sync: false,
    // No candidates: a local folder is whatever the user names. Listed
    // so `mem raw archive --list-stores` does not imply that a cloud is
    // required.
    candidates: { all: [] },
  },
  {
    id: 'gdrive',
    label: 'Google Drive',
    sync: true,
    candidates: {
      darwin: ['~/Library/CloudStorage/GoogleDrive-*/My Drive', '~/Google Drive'],
      win32: ['%USERPROFILE%/Google Drive', 'G:/My Drive'],
      linux: ['~/GoogleDrive', '~/google-drive'],
    },
  },
  {
    id: 'icloud',
    label: 'iCloud Drive',
    sync: true,
    candidates: {
      darwin: ['~/Library/Mobile Documents/com~apple~CloudDocs'],
      win32: ['%USERPROFILE%/iCloudDrive'],
      linux: [],
    },
  },
  {
    id: 'onedrive',
    label: 'OneDrive',
    sync: true,
    candidates: {
      darwin: ['~/Library/CloudStorage/OneDrive-*', '~/OneDrive'],
      win32: ['%USERPROFILE%/OneDrive', '%USERPROFILE%/OneDrive - *'],
      linux: ['~/OneDrive'],
    },
  },
  {
    id: 'dropbox',
    label: 'Dropbox',
    sync: true,
    candidates: {
      darwin: ['~/Library/CloudStorage/Dropbox', '~/Dropbox'],
      win32: ['%USERPROFILE%/Dropbox'],
      linux: ['~/Dropbox'],
    },
  },
]);

/** The subfolder the memory creates inside whichever store is chosen. */
export const SUBFOLDER = 'cheap-mem-archive';

/** `~` and `%USERPROFILE%` are the two forms these paths come in. */
function expandHome(p, home = os.homedir()) {
  return p
    .replace(/^~(?=[/\\]|$)/, home)
    .replace(/%USERPROFILE%/gi, home)
    .replace(/\//g, path.sep);
}

/**
 * Expand ONE `*` in the last-but-one segment.
 *
 * Google Drive and OneDrive put the account into the directory name
 * (`GoogleDrive-someone@example.com`, `OneDrive - Company`), so the
 * path cannot be written down in advance. A full glob library would be
 * a dependency for one wildcard; this reads the parent directory and
 * matches a prefix, which is all these patterns ever need.
 */
function expandStar(pattern) {
  if (!pattern.includes('*')) return fs.existsSync(pattern) ? [pattern] : [];

  const parts = pattern.split(path.sep);
  const starAt = parts.findIndex((s) => s.includes('*'));
  if (starAt < 0) return [];

  const parent = parts.slice(0, starAt).join(path.sep) || path.sep;
  const [before, after] = parts[starAt].split('*');
  const rest = parts.slice(starAt + 1);

  let entries;
  try { entries = fs.readdirSync(parent); } catch { return []; }

  const out = [];
  for (const name of entries) {
    if (!name.startsWith(before) || !name.endsWith(after ?? '')) continue;
    const full = [parent, name, ...rest].join(path.sep);
    if (fs.existsSync(full)) out.push(full);
  }
  return out;
}

/** Candidate paths for one store on this platform, expanded. */
export function candidates(store, { platform = process.platform, home = os.homedir() } = {}) {
  const raw = store.candidates[platform] ?? store.candidates.all ?? [];
  const out = [];
  for (const pattern of raw) {
    for (const hit of expandStar(expandHome(pattern, home))) {
      if (!out.includes(hit)) out.push(hit);
    }
  }
  return out;
}

/**
 * What is actually on this machine.
 *
 * Reports every known store with `found: []` when nothing matched —
 * not an empty list. "Google Drive is not installed here" and "we never
 * looked for Google Drive" are different statements, and a caller that
 * only sees what was found cannot tell them apart.
 */
export function discover(opts = {}) {
  return STORES.map((s) => ({
    id: s.id,
    label: s.label,
    sync: s.sync,
    found: candidates(s, opts),
  }));
}

/**
 * Turn a store id into a concrete directory, or explain why not.
 *
 * Returns `{ok: true, path, store}` or `{ok: false, reason, …}`. Never
 * throws and never guesses: an id that resolves to two candidates is
 * reported as ambiguous rather than silently taking the first, because
 * "it went somewhere" is the failure mode this whole archive was built
 * to avoid.
 */
export function resolve(id, opts = {}) {
  const store = STORES.find((s) => s.id === id);
  if (!store) {
    return { ok: false, reason: 'unknown-store', known: STORES.map((s) => s.id) };
  }
  if (store.id === 'local') {
    return { ok: false, reason: 'needs-path', store };
  }

  const found = candidates(store, opts);
  if (found.length === 0) return { ok: false, reason: 'not-installed', store };
  if (found.length > 1) return { ok: false, reason: 'ambiguous', store, found };

  return { ok: true, path: path.join(found[0], SUBFOLDER), store };
}

/**
 * Is this path inside a syncing store?
 *
 * Used to warn AFTER the fact too — someone who types the Dropbox path
 * by hand should get the same warning as someone who says `--set
 * dropbox`, otherwise the warning is a property of the command rather
 * than of the situation.
 */
export function syncingStoreFor(dir, opts = {}) {
  const target = path.resolve(dir);
  for (const store of STORES) {
    if (!store.sync) continue;
    for (const base of candidates(store, opts)) {
      const b = path.resolve(base);
      if (target === b || target.startsWith(b + path.sep)) return store;
    }
  }
  return null;
}

/**
 * What to tell someone who picked a syncing store.
 *
 * Deliberately not a refusal. A cloud drive is a reasonable place for
 * this — it is off the machine, it is backed up, and the record in the
 * repository still says what existed even when a file is evicted. The
 * user just has to know which of those three things can bite.
 */
export const SYNC_WARNING = [
  'This is a syncing store. Three things follow, none of them fatal:',
  '  - Files can be evicted to the cloud (Files On-Demand, Optimise',
  '    Storage). Reading one may be slow, or fail while offline. The',
  '    memory reports that as an error, never as an empty result.',
  '  - A write returning does not mean the bytes left this machine.',
  '  - Two machines pointed at the same folder share the archive. That',
  '    works, but they are then writing into one place.',
];
