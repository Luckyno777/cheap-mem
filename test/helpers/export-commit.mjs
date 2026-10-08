// test/helpers/export-commit.mjs - write the files of a FIXED old commit into a
// directory, for the red proofs that run old code against new probes.
//
// Pure git + fs, no `tar`. The red proofs used to run
// `git archive -o <dir>/x.tar <commit> ...` and then `tar -x -C <dir> -f <dir>/x.tar`.
// On Windows the `tar` found first on the PATH can be GNU tar (Git for Windows),
// which reads the `C:` in `-f C:\...\x.tar` as a remote host and dies with
// "tar: Cannot connect to C: resolve failed" (CI run 37844100363). Nothing here
// puts a drive-letter path into a tar command line, and nothing depends on which
// tar is installed.
//
// `git ls-tree -r -z` lists the blobs, one `git cat-file --batch` process reads
// them all (binary safe), the files are written with ordinary fs calls. Stored
// names use "/" (git's own); the destination path is built with path.join.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Write `paths` (files or directories, as in `git archive <commit> <paths>`)
 * of `commit` of the repository at `repo` into `dest`.
 * Returns the sorted list of files written (relative, "/" separated).
 * Throws when the commit or a path is missing, like `git archive` does.
 */
export function exportCommit(repo, commit, paths, dest) {
  const listing = execFileSync(
    'git', ['-C', repo, 'ls-tree', '-r', '-z', commit, '--', ...paths],
    { maxBuffer: 1 << 28 },
  ).toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (const rec of listing) {
    // "<mode> <type> <sha>\t<path>"
    const tab = rec.indexOf('\t');
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    if (type !== 'blob') continue;           // submodules (commit) are not files
    entries.push({ mode, sha, name: rec.slice(tab + 1) });
  }
  if (entries.length === 0) throw new Error(`exportCommit: no files at ${commit} for ${paths.join(' ')}`);
  const batch = execFileSync(
    'git', ['-C', repo, 'cat-file', '--batch'],
    { input: `${entries.map((e) => e.sha).join('\n')}\n`, maxBuffer: 1 << 29 },
  );
  let pos = 0;
  for (const e of entries) {
    const eol = batch.indexOf(0x0a, pos);
    const [, kind, size] = batch.toString('latin1', pos, eol).split(' ');
    if (kind !== 'blob') throw new Error(`exportCommit: ${e.name} is a ${kind}`);
    const start = eol + 1;
    const body = batch.subarray(start, start + Number(size));
    pos = start + Number(size) + 1;          // the byte after the body is a newline
    const target = path.join(dest, ...e.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (e.mode === '120000') {               // a symlink is stored as a file holding the link text
      fs.writeFileSync(target, body);
    } else {
      fs.writeFileSync(target, body, { mode: e.mode === '100755' ? 0o755 : 0o644 });
    }
  }
  return entries.map((e) => e.name).sort();
}
