// A scratch copy of the code tree, for proving that an atlas record turns red when ONE guarantee is removed
// (test/atlas-gaps-mutants-cm.test.mjs, bench/atlas/gap-mutants.mjs).
//
// What is copied: `bin/`, `src/`, `shared/`, `assets/`, `package.json` and `package-lock.json`. `node_modules` is linked
// (a junction on Windows), never copied, so the copy resolves the same SDK. The copy lives under `os.tmpdir()` and is
// removed by `dispose()`; the mutation is applied to the COPY only, and `restore()` puts every file back, so one copy
// serves all mutants in turn (a fresh child process per ask means no module cache can answer for a file that changed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARTS = ['bin', 'src', 'shared', 'assets'];
const FILES = ['package.json', 'package-lock.json'];

export function makeScratchTree(prefix = 'atlas-gap-tree-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const p of PARTS) fs.cpSync(path.join(REPO, p), path.join(dir, p), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const originals = new Map();
  return {
    dir,
    /**
     * Apply edits (`{file, from, to}`); every anchor must match EXACTLY ONCE or the call throws (a mutant that did not
     * apply proves nothing, one that applied somewhere else measures something nobody chose).
     */
    apply(edits) {
      for (const e of edits) {
        const p = path.join(dir, e.file);
        const text = fs.readFileSync(p, 'utf8');
        const hits = text.split(e.from).length - 1;
        if (hits !== 1) throw new Error(`the anchor must match exactly once, it matched ${hits}x in ${e.file}: ${e.from.slice(0, 80)}`);
        if (!originals.has(p)) originals.set(p, text);
        fs.writeFileSync(p, text.replace(e.from, () => e.to));
      }
    },
    restore() {
      for (const [p, text] of originals) fs.writeFileSync(p, text);
      originals.clear();
    },
    dispose() {
      // the link is removed first, so the removal can never walk into the real node_modules
      try { fs.unlinkSync(path.join(dir, 'node_modules')); } catch { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
