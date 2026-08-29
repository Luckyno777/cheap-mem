# cheap-mem

> Cheap in tokens, rich in memory.

A local-first, git-backed persistent memory layer for AI coding assistants.

Works with Claude Code, Claude Desktop, Cursor, ChatGPT, Gemini, Mistral, and
any other model via a small CLI and an MCP server. Your memory lives in a git
repo you own — sync across machines is just `git pull`.

## Why cheap?

Most personal-memory patterns (Obsidian second-brain, RAG-heavy setups) load
your whole knowledge base into every context. cheap-mem does the opposite:
tiny always-loaded facts file, everything else pulled on demand. Rough
measurements: **80-95% fewer tokens per session** than typical RAG-second-brain
setups.

## Status

Early development. Ported from the private [lucky-mem] design.
Not yet ready for daily use — check back soon.

[lucky-mem]: https://github.com/Luckyno777/lucky-mem
