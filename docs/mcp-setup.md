# MCP setup per client

cheap-mem ships an MCP server (`bin/mem-mcp`) that exposes eight tools:
`mem_log`, `mem_find`, `mem_context`, `mem_inbox_new`, `mem_inbox_show`,
`mem_inbox_write`, `mem_inbox_ack`, `mem_project_init`.

**First: install the SDK.** `mem-mcp` needs `@modelcontextprotocol/sdk`,
which is an *optional peer* — it is 28 MB across 91 packages (an HTTP
server stack this stdio server never uses), so it is not fetched unless
you want the MCP tools:

```bash
npm install -g @modelcontextprotocol/sdk
```

Without it `mem-mcp` exits with that command rather than a stack trace —
an import failure inside an MCP client is otherwise invisible, since the
client reports only that the server would not start.

Every MCP config below just points at `bin/mem-mcp` and sets `CHEAP_MEM_ROOT`.

## Claude Code

```bash
claude mcp add cheap-mem --scope user \
  --env CHEAP_MEM_ROOT=/absolute/path/to/your-memory \
  -- node /absolute/path/to/cheap-mem/bin/mem-mcp
```

Or for hooks + permissions (recommended):
```bash
CHEAP_MEM_ROOT=/absolute/path/to/your-memory \
  bash /absolute/path/to/cheap-mem/install/claude-code.sh   # or: mem setup claude
```

That merges into `~/.claude/settings.json` and drops SessionStart +
Stop hooks under `~/.claude/hooks/`.

## Claude Desktop (macOS / Windows)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "cheap-mem": {
      "command": "node",
      "args": ["/absolute/path/to/cheap-mem/bin/mem-mcp"],
      "env": {
        "CHEAP_MEM_ROOT": "/absolute/path/to/your-memory"
      }
    }
  }
}
```

Restart Claude Desktop.

## Cursor

Settings → Features → **MCP** → Add Server:

- **Name**: cheap-mem
- **Command**: `node /absolute/path/to/cheap-mem/bin/mem-mcp`
- **Env**: `CHEAP_MEM_ROOT=/absolute/path/to/your-memory`

## VS Code — Continue.dev

`~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "cheap-mem",
      "command": "node",
      "args": ["/absolute/path/to/cheap-mem/bin/mem-mcp"],
      "env": { "CHEAP_MEM_ROOT": "/absolute/path/to/your-memory" }
    }
  ]
}
```

## ChatGPT — via Custom GPTs / Actions

MCP is not native to ChatGPT yet. Two working paths:

1. **`codex` CLI** (OpenAI's terminal client). Add the same MCP entry to
   `~/.codex/config.json` (`mcpServers` key).
2. **Custom GPT with Actions**. Wrap the CLI in a tiny HTTP server; not
   documented here yet.

## Gemini CLI / Mistral CLI

Currently these do not speak MCP. Give the model a shell tool and let it
call `mem` directly — see [cli-integration.md](cli-integration.md).

## Sanity check any MCP server

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | CHEAP_MEM_ROOT=/tmp/nowhere node /path/to/cheap-mem/bin/mem-mcp
```

You should see a JSON blob listing eight tools. (The `mem_*` tools that
touch the memory will fail because `/tmp/nowhere` is not initialized —
that's fine, we only wanted `tools/list`.)
