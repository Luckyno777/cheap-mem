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
not, they only cost you a local model, a native build and a per-query
call to it.

Measured on a 228-entry corpus, `mem find` retrieved the answering
entry for 14 of 15 questions. Embeddings would have to beat that to be
worth their price.

## Local only — no entry text goes to an embedding vendor

Since 2026-10-13 the only embedding provider is **ollama on your own
machine**. The Voyage and OpenAI adapters were removed, not switched
off by a flag: the code that sent text to them does not exist any more,
not even masked or shortened. A memory captures your terminal; that text
does not leave the machine for the sake of a better ranking.

Ollama is accepted only on a **loopback address**: `127.0.0.0/8`, `::1`,
or the name `localhost` (resolved here, and every answer must be
loopback). Any other host in `OLLAMA_HOST` — another machine on your
network, a name, a public address — is refused before a connection is
opened, because the text would cross a wire. Host names other than
`localhost` are never trusted, even if they would resolve to loopback
today.

## Setup

```bash
npm install better-sqlite3 sqlite-vec     # optional peers: 14 MB, not fetched until you ask
ollama pull nomic-embed-text              # the model, once
mem embed setup                           # --provider ollama is the default (and the only choice)
mem embed backfill                        # embed what is already written
mem find-embed "the customer was unhappy"
```

| provider | model | dim | key | data leaves the machine |
|---|---|---:|---|---|
| `ollama` | nomic-embed-text | 768 | none | **no** (loopback only) |

`OLLAMA_HOST` (default `http://localhost:11434`) may point at another
port on this machine, not at another machine.

## The three states, and what each one says

`mem embed status` names the state; `mem find-hybrid` and
`mem find-embed` put it in the first line of their answer.

| state | what it means | what the search does |
|---|---|---|
| **local** | `.mem/embed.json` names ollama, the endpoint is loopback | `find-hybrid` fuses BM25 with the local semantic ranking; `find-embed` is semantic only |
| **not configured** | no `.mem/embed.json` | lexical search. The line says `lexical only — semantic search is not configured`. Nothing is wrong |
| **refused** | the config names `voyage` or `openai` (or any other provider), or `OLLAMA_HOST` is not loopback | lexical search, **loudly**: stderr carries `external embedding providers are disabled: no entry text leaves this machine; using lexical search` and the first line says `lexical only — REFUSED` |

A config file that cannot be read is a fourth, separate answer (it
says what is wrong and uses lexical search). A configured local model
that is not running gives `bm25 only — local semantic search failed:
...`: the failure is named, not turned into "no hits".

## If you used voyage or openai before

What you have to do:

1. Nothing breaks: `mem find`, `mem retrieve` and the recall hooks never
   used embeddings. `mem find-hybrid` and `mem find-embed` fall back to
   lexical search and tell you so on every call.
2. To get semantic search back, locally: install ollama, `ollama pull
   nomic-embed-text`, `mem embed setup`, `mem embed backfill --force`.
   The vector size differs (512 or 1536 against 768), so the old store
   cannot be reused.
3. Your old `.mem/vectors.db` is **not deleted** and **not used**. It is
   your data; `mem embed status` says how many entries in it came from a
   removed provider. Delete or move the file when you no longer want it.
   (`backfill --force` rebuilds the store, but only when a local setup is
   configured; a store holding vectors of another provider is moved to
   `.mem/local/kept-vectors/`, not deleted. Against a refused setup
   `--force` touches nothing.)
4. `VOYAGE_API_KEY`, `OPENAI_API_KEY` and `.mem/embed.env` are no longer
   read by anything. `mem embed status` notes when they are present
   (names only, never values). Revoke the keys if you only had them for
   this, and delete `.mem/embed.env`.

## Why it is bolted on, not built in

The JSONL line is written **first**; the embedding is attached after.
If embedding fails — no local model running, a native build that did
not compile — the memory entry still exists. The other order would mean
losing a memory because an optional feature was unavailable.

For the same reason `better-sqlite3` and `sqlite-vec` are
optional peer dependencies. A native build is the most common way a Node
tool fails to install, and nobody should lose the whole memory over a
feature they never asked for.

## Not set up is not an error

An unconfigured memory returns `status: 'off'` from the entry hook, and
`off` is silent. It is the normal state for anyone who does not want
embeddings. A *refused* setup is different and is never silent.

An earlier version reported "not set up" as `broken`, so `mem log`
printed `[embed broken] ...` on **every single write**. Once people are
used to warnings, they stop seeing the real ones.

## Don't compare the scores

`mem find` returns BM25 scores. `mem find-embed` returns `1/(1+L2)`.
Both rank correctly within themselves; neither is on the other's scale.
Comparing them, or blending them, would produce a number that means
nothing.

## Dimension mismatch

The store is built for one vector size (768 for nomic-embed-text). A
store written with another size, such as one a removed provider made,
cannot be searched with it. The store detects the mismatch on open and
says so, rather than accepting vectors it cannot compare — a failure
that would otherwise only show up months later as bad results. Move the
old `.mem/vectors.db` aside (`mem embed backfill --force` does that for
you, once a local setup is configured) and backfill again.
