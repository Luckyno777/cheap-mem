// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Second review (2026-10-12): the "safe reverse-proxy shape needs a token" block of docs/mcp-setup.md carried the token only in a
// COMMENT, so a copied block started the server without one. The code block that starts `mem-mcp --http` behind a proxy host
// must contain the `CHEAP_MEM_MCP_TOKEN=` line itself, in front of the command.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'mcp-setup.md');

test('the proxy-shape code block of docs/mcp-setup.md sets CHEAP_MEM_MCP_TOKEN as a line of the command', () => {
  const text = fs.readFileSync(DOC, 'utf8');
  const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const proxy = blocks.filter((b) => /CHEAP_MEM_MCP_HOSTS=/.test(b) && /mem-mcp --http/.test(b));
  assert.ok(proxy.length >= 1, 'no code block starts mem-mcp --http behind a proxy host');
  for (const b of proxy) {
    const code = b.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.match(code, /^CHEAP_MEM_MCP_TOKEN=\S+ \\$/m, 'the token is only in a comment, not a line of the command');
    assert.ok(code.indexOf('CHEAP_MEM_MCP_TOKEN=') < code.indexOf('node '), 'the token line must stand in front of the node command');
  }
});
