// Shared helper (not a test file): a base directory for scratch folders whose path holds NO whitespace.
//
// A model command is configured as one string (MEM_DIGEST_CMD, MEM_HANDLER_CMD, MEM_REFLECT_CMD) and word-split
// by the shell scripts, so a stand-in model that is named by an ABSOLUTE path needs a path without a space. On
// Windows the temp directory sits under the user's profile, which may have one: then the drive root is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function spaceFreeBase() {
  const t = os.tmpdir();
  if (!/\s/.test(t)) return t;
  const alt = path.join(path.parse(t).root, 'cm-scratch');
  fs.mkdirSync(alt, { recursive: true });
  return alt;
}

/** Forward slashes: what the word-split command line and Git Bash want. */
export const slashes = (p) => p.replace(/\\/g, '/');
