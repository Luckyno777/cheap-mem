// Style checking for ~18,900 lines that had none.
//
// **Why this is deliberately small.** A rule set that flags six hundred
// things on its first run gets switched off on the second. The rules
// below are the ones that catch real defects rather than taste:
// variables that are never read, a `catch` that swallows without saying
// so, an `await` in a loop that should be parallel, a comparison that
// can never be true.
//
// Formatting rules are absent on purpose. This codebase is written by
// one person and one model, both consistent enough; a formatter would
// produce a large diff that hides the next real change.

import js from '@eslint/js';

export default [
  {
    ignores: ['node_modules/**', '.mem/**', 'raw/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        structuredClone: 'readonly',
        crypto: 'readonly',
      },
    },
    rules: {
      // An unused variable is usually a rename that was left half done.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        // `const { agent: _ignored, ...fields } = args` ist das Muster,
        // mit dem die Bruecke Felder WEGWIRFT, die ein Aufrufer nicht
        // setzen darf. Die Variable ist absichtlich unbenutzt — sie
        // existiert nur, damit `...fields` sie nicht enthaelt. Eine
        // Namensregel (`^_`) wuerde dasselbe erlauben, sagt aber nicht,
        // warum; diese Option benennt genau den Fall.
        ignoreRestSiblings: true,
        // `catch {}` without a binding is the house style for "this
        // failure is expected and handled by the fallback"; a bound but
        // unused error is the accident.
        caughtErrorsIgnorePattern: '^_',
      }],
      // `x == null` is the one loose comparison this codebase uses on
      // purpose (null and undefined together). Everything else is strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      // A condition that can never change is either dead code or a
      // guard someone disabled while debugging.
      'no-constant-condition': ['error', { checkLoops: false }],
      // Two keys with the same name: the second wins silently. This
      // exact defect cost a command in the sibling project on
      // 2026-09-08 — `mem frage` was defined twice and the new one
      // overwrote the existing inbox round-trip without a word.
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-duplicate-case': 'error',
      // A promise nobody waits for fails without anyone hearing it.
      'require-atomic-updates': 'error',
    },
  },
  {
    // **The files with the most lines have no extension.** `bin/mem`,
    // `bin/mem-mcp` and the rest are executables with a shebang, and
    // eslint skips anything that is not `.js`/`.mjs` unless told
    // otherwise. Without this block the linter reported success while
    // never opening the largest file in the repository — a check that
    // looks green because it looked at nothing.
    // **Only the two that are actually JavaScript.** The other eight
    // files in `bin/` are shell scripts with a `#!/bin/sh` shebang; the
    // first run of this config tried to parse them as JS and produced
    // four "Unexpected character" errors that said nothing about the
    // code. Classified by shebang, not by name — `mem-capture` and
    // `mem-mcp` look equally like Node from the outside.
    files: ['bin/mem', 'bin/mem-mcp'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // Tests may shadow and re-declare freely; they are read top to
    // bottom, not maintained as an API.
    files: ['test/**', 'bench/**', 'eval/**'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // **Hier ist das seltsame Zeichen der Pruefgegenstand.**
      //
      // `test/redaction-unicode.test.mjs` prueft, dass die Redaktion
      // sich nicht mit unsichtbaren Trennern austricksen laesst;
      // `test/browse.test.mjs` prueft das Entfernen von ANSI-Codes. Die
      // Regeln melden dort genau das, was die Probe absichtlich
      // enthaelt. Sie einzeln zu unterdruecken hiesse, in jede Fixtur
      // eine Direktive zu schreiben — und eine Direktive, die
      // ueberall steht, liest niemand mehr.
      'no-irregular-whitespace': 'off',
      'no-control-regex': 'off',
    },
  },
];
