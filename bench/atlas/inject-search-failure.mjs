// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/inject-search-failure.mjs — a preload that makes ONE search lane fail.
//
// The silent-errors phase (bench/atlas/phase-silent-errors.mjs) asks whether
// a lane of a search that fails looks different from a lane that found
// nothing. To ask, a lane has to fail, in the real code, without editing it.
// This preload replaces `search()` of src/search.mjs, in the child process
// that loads it, by a function that throws when it is asked for the type
// named in the URL's query (`?fail=error`) and otherwise calls the real one.
// Without `fail` it changes nothing, which is the healthy half of the
// comparison. It needs `node --experimental-test-module-mocks`.
import path from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';

const fail = new URL(import.meta.url).searchParams.get('fail');
if (fail) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const url = pathToFileURL(path.join(repo, 'src', 'search.mjs')).href;
  const real = await import(url);
  mock.module(url, {
    namedExports: {
      ...real,
      search: (index, query, options) => {
        if (options?.type === fail) throw new Error(`injected: the search lane for "${fail}" failed`);
        return real.search(index, query, options);
      },
    },
  });
}
