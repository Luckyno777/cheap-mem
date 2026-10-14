// The OLD before-edit hook (bash, e98bf2d) kept as a reference (verbatim, except that the Windows
// user-profile path in four comments reads `C:\Home`, for the fixed-paths ratchet), and a tool
// directory laid out like the repo to run it — or the current hook — in.
// Shared by test/before-edit-golden.test.mjs (same output as before) and
// test/before-edit-node-starts.test.mjs (red proof: how many starts it took).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../temp-dir.mjs';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OLD_HOOK_TEXT = path.join(REPO, 'test', 'fixture', 'before-edit-v1', 'mem-before-edit.sh.txt');

/**
 * A tool directory: bin/ (the hook, _portable.sh, mem [, the core]) next to a
 * copy of src/. Returns the path of the hook inside it.
 */
export function toolDir(t, hookText, { core = false } = {}) {
  const dir = tempDir('cm-bego-tool-', t);
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.cpSync(path.join(REPO, 'src'), path.join(dir, 'src'), { recursive: true });
  for (const f of ['_portable.sh', 'mem']) fs.copyFileSync(path.join(REPO, 'bin', f), path.join(dir, 'bin', f));
  if (core) fs.copyFileSync(path.join(REPO, 'bin', 'mem-before-edit-core.mjs'), path.join(dir, 'bin', 'mem-before-edit-core.mjs'));
  fs.writeFileSync(path.join(dir, 'bin', 'mem-before-edit'), hookText);
  return path.join(dir, 'bin', 'mem-before-edit');
}
