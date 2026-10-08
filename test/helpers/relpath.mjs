// Shared helper (not a test file): THE one place that spells a relative path
// the way caps, allowlists, git and humans write it -- with forward slashes.
//
// On Windows path.relative / path.join answer "src\chain.mjs". Anything
// keyed or compared against a literal 'src/chain.mjs' (per-file caps,
// allowlists, `git show <rev>:<path>`) then silently misses. Normalise
// where the path is born, here, and nowhere downstream.
import path from 'node:path';

/** Forward-slash spelling of any path. */
export const posix = (p) => p.split(path.sep).join('/');

/** path.relative(from, to), spelled with forward slashes. */
export const relPosix = (from, to) => posix(path.relative(from, to));
