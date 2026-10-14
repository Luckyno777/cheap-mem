# Start skill for Codex Cloud

This text belongs in the environment field "Start skill" (Codex settings,
Codex Cloud, Environments). It is the short form of the start of the `$mem`
skill. What the setup involves: the section "OpenAI Codex Cloud" in
`docs/mcp-setup.md`. `mem setup codex-cloud` prints this text.

Enter exactly this text:

```text
Use $mem. First call mem_context(n=8), then mem_find(query=the task in one sentence, top=5). Then follow the skill: look up before each file you touch, look up after each failure and before the second attempt, and file one closing entry at the end of the task if something new came out of it. This also applies when you resume a task. If the connector is not reachable or a call fails, say so at once and explicitly, naming the step that is missing. Never carry on silently.
```
