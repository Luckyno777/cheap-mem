# The dashboard

`mem serve` shows one page: the dashboard. Since 2026-09-28 it is
cheap-mem's only UI. It is the sibling house's dashboard (lucky-mem),
functionally and visually the same. It differs in three ways only: it is
in English, it carries cheap-mem's own mark (the C), and a fresh install
starts with an empty store.

```bash
mem serve                 # http://127.0.0.1:8847/  (localhost only without a token)
mem serve --allow-writes  # allow the page to write, for this run only
```

## Routes

| Route | What |
|---|---|
| `/`, `/dashboard`, `/pult` | the page |
| `/dashboard.json` | everything the views show, collected live (gzip when asked) |
| `/dashboard/entry.json?id=` | one entry, whole |
| `/dashboard/message.json?id=` | one inbox message, whole |
| `/dashboard/probe.json` | the retrieval probe: what `mem retrieve` would inject for a question. It is read-only and never logged |
| `/dashboard/facts-at.json?known=&valid=` | the bitemporal comparison (Knowledge / Facts) |
| `/console.json`, `/pult.json` | the console's and the board's numbers, for tools |
| `/console`, `/viewer` | 303 into the dashboard (`#settings/system`, `#knowledge/entries`) |
| `/manifest.webmanifest`, `/sw.js`, `/favicon.ico` | the installable shell (PWA) |

Writing routes and their switch: `docs/dashboard-writes.md`.

## What it shows

- **Overview**: state, attention, the board's tiles (the same as
  `mem board`, which stays on the CLI), and the 3D network.
- **Knowledge**: entries, network, topics, facts, learnings, skills.
- **Work**: duties and questions, agents, inbox, agent context, usage,
  and the user and ledger view.
- **Sources**: projects, files and store, raw captures, digest, and the
  export studio.
- **Operations**: shards, operations, doctor, performance, integrity,
  versions, MCP.
- **Settings**: appearance, system (the console's knobs and long jobs),
  the command catalogue, and project state.

Every count has four states, each with its own colour: calm, watch,
alarm, unknown. The doctor uses good, warning, error, unknown.
**Unknown is never drawn as 0.** A source that cannot be read is named
on the page, and completeness then reads "unknown".

**What cheap-mem does not have is shown, not hidden.** Books, the
digester's yield, restore, merge and the live injection view are marked
"not available in cheap-mem".

**Raw capture delete** works like `mem raw delete`. You get a preview
first, then must give a reason, then confirm. The tombstone stays in the
register.

## The measurement series

A running server records one snapshot a week: entries, declared links,
links into the void, raw captures, open duties and questions, injections
shown that week, and doctor warnings plus errors. They go to
`.mem/measurements.jsonl` and are capped at 52 weeks
(`src/measurements.mjs`). Nothing is recorded by tests or by opening
the page.

## Security

- Without `CHEAP_MEM_SERVE_TOKEN` it binds to localhost only. A request
  that is neither loopback nor carries the token gets a bare 404.
- Every data route checks the `Host` header against loopback,
  `CHEAP_MEM_SERVE_HOSTS` and the hosts of `CHEAP_MEM_SERVE_ORIGINS`.
  This guards against DNS rebinding.
- The page sends a Content-Security-Policy and never a CORS header.
- The service worker stores nothing unless `CHEAP_MEM_SERVE_OFFLINE=1`.

## Every file from this server

three.js r180 (MIT) and DM Sans (SIL OFL 1.1) are vendored under
`assets/`, with their licences next to them and in `NOTICE`. That is
the one named exception to "no dependencies"
(`test/packaging.test.mjs`, `VENDORED`). The page makes no outside
request: no CDN, no font service.

## Parity with the sibling

Parity is kept through shared invariants (`shared/invariants.jsonl`),
not through shared code. Each house has its own tests. The completeness
inventory (`test/dashboard-complete.test.mjs`) lists every feature the
old UI had and where it lives now.
