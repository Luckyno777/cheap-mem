#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// mem-before-edit-core — the slim node entry of the before-edit hook.
//
// `bin/mem-before-edit` and `bin/mem-before-edit.ps1` start THIS, once,
// instead of a dozen `node -e` snippets and a full `node bin/mem`
// (src/beforeedit.mjs says why). It does not decide anything itself:
// it reads the hook JSON from stdin, the few settings from the
// environment, hands both to `run()`, prints what comes back.
//
//   CHEAP_MEM_ROOT          the memory (the shell has resolved it)
//   MEM_BEFORE_EDIT_MARKS   where the once-per-file marks live
//   MEM_BEFORE_EDIT_TOP     at most this many warning hits (default 3)
//   MEM_BEFORE_EDIT_TRACE=1 name the exit on stderr
//   MEM_BE_START_MS         when the hook started (journal duration)
//   MEM_BE_ASCII=1          ASCII hyphen in the final text (the .ps1 twin)
//
// Never exits non-zero over recall: a hook that fails loudly is worse
// than none. No process.exit(): the journal line must be written out.

import { run } from '../src/beforeedit.mjs';
import { readHookStdinSync } from '../src/hookstdin.mjs';

const root = process.env.CHEAP_MEM_ROOT || '';
// Without a byte order mark in front: Windows PowerShell 5.1 put one on the pipe (src/hookstdin.mjs, CI run 1141).
const input = readHookStdinSync();

if (root) {
  const top = process.env.MEM_BEFORE_EDIT_TOP;
  const { stdout } = await run({
    input,
    root,
    marks: process.env.MEM_BEFORE_EDIT_MARKS || undefined,
    startMs: Number(process.env.MEM_BE_START_MS),
    top: top ? Number(top) : 3,
    ascii: process.env.MEM_BE_ASCII === '1',
    trace: process.env.MEM_BEFORE_EDIT_TRACE === '1',
  });
  if (stdout) process.stdout.write(stdout);
}
