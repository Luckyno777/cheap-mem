# Semantic search — the escalation

`mem find` needs no key, no network and no money, and it answers in
single-digit milliseconds. **Use it.** This page is about the case it
honestly cannot do.

## When you actually need this

BM25 plus a thesaurus plus a learned tag graph covers a lot of
rewording: `flaky tests` finds *"aborts sporadically"*, `ram leak`
finds *"heap climbs until the OOM killer"*. What it cannot do is a
paraphrase with **no lexical overlap at all** and no synonym pair to
bridge it:

> *"the customer was unhappy"* → *"complaint received"*

If that keeps happening in your memory, embeddings help. If it does
not, they only cost you a key, a native build and a per-query API call.

Measured on a 228-entry corpus, `mem find` retrieved the answering
entry for 14 of 15 questions. Embeddings would have to beat that to be
worth their price.

## Setup

```bash
npm install better-sqlite3 sqlite-vec     # optional deps, not installed by default
mem embed setup --provider voyage         # or openai, or ollama
mem embed backfill                        # embed what is already written
mem find-embed "the customer was unhappy"
```

| provider | model | dim | key | data leaves the machine |
|---|---|---:|---|---|
| `voyage` | voyage-3-lite | 512 | `VOYAGE_API_KEY` | yes |
| `openai` | text-embedding-3-small | 1536 | `OPENAI_API_KEY` | yes |
| `ollama` | nomic-embed-text | 768 | none | **no** |

Keys go in the environment or in `.mem/embed.env` — which must be
gitignored, and is, by default.

**If the memory holds anything you would not send to a vendor, use
ollama.** It runs locally, needs no key, and the text never leaves the
machine. That is not a small detail for a memory that captures your
terminal.

## Why it is bolted on, not built in

The JSONL line is written **first**; the embedding is attached after.
If embedding fails — no key, no network, a provider outage, a native
build that did not compile — the memory entry still exists. The other
order would mean losing a memory because an optional feature was
unavailable.

For the same reason `better-sqlite3` and `sqlite-vec` are
`optionalDependencies`. A native build is the most common way a Node
tool fails to install, and nobody should lose the whole memory over a
feature they never asked for.

## No key is not an error

A missing key returns `status: 'off'`, and `off` is silent. It is the
normal state for anyone who does not want embeddings.

An earlier version reported it as `broken`, so `mem log` printed
`[embed broken] no VOYAGE_API_KEY` on **every single write**. Once
people are used to warnings, they stop seeing the real ones.

## Don't compare the scores

`mem find` returns BM25 scores. `mem find-embed` returns `1/(1+L2)`.
Both rank correctly within themselves; neither is on the other's scale.
Comparing them, or blending them, would produce a number that means
nothing.

## Dimension mismatch

Switching providers changes the vector size, and the store is built for
one. Switching is a rebuild:

```bash
mem embed setup --provider openai
mem embed backfill --force
```

The store detects the mismatch on open and says so, rather than
accepting vectors it cannot compare — a failure that would otherwise
only show up months later as bad results.
