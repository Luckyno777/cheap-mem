/**
 * The read-only MCP profile.
 *
 * The bridge hands a memory to whatever client connects. Most of them
 * only ever need to READ — a chat assistant answering from the
 * memory, a dashboard, someone else's agent looking something up.
 * Giving all of them the ability to append is a permission handed out
 * because it happened to be there, not because anyone needed it.
 *
 * So a profile: `CHEAP_MEM_MCP_READONLY=1` and the writing tools are
 * neither listed nor callable.
 *
 * ## Two things that make this a boundary rather than a hint
 *
 * **Unknown counts as writing.** A tool that is in neither list is
 * refused under the read-only profile. The other way round — unknown
 * means reading — is the convenient default and the wrong one: every
 * new tool would be readable from the day it is added until someone
 * remembers the list. A boundary that new code slips past by default
 * is not a boundary.
 *
 * **Hidden AND refused.** Not listing a tool is a hint, not a
 * boundary: a client that knows the name can still call it. So the
 * check sits in front of the dispatch as well.
 *
 * ## Why the classification is pinned by a test
 *
 * Because getting it wrong is quiet and easy. In the sibling memory
 * two tools were classified as reading that write on the way
 * (`markSeen`, `record`), and it only came out because the
 * documentation disagreed and the code was checked. The test that
 * belongs with this module reads the CASE BODIES and fails when a tool
 * listed as reading touches a writing call — the classification is
 * then derived from the code, not from memory.
 */

/** The two profiles. Closed list. */
export const PROFILE = Object.freeze({
  FULL: 'full',
  READ_ONLY: 'read-only',
});

/**
 * The tools that only read.
 *
 * Deliberately an explicit list and not "everything except WRITING":
 * with the complement, a tool missing from both lists would be
 * readable, and that is the wrong side to fall to.
 */
export const READING = Object.freeze([
  'mem_board', 'mem_questions',
  'mem_procedures', 'mem_component', 'mem_links',
  'mem_show', 'mem_experiences', 'mem_topics', 'mem_facts',
  'mem_explain', 'mem_retrieve', 'mem_find', 'mem_duties',
  'mem_context', 'mem_inbox_show', 'mem_store_list', 'mem_store_get',
]);

/**
 * The tools that write.
 *
 * `mem_inbox_ack` is on this list and looks like a read from its name:
 * it acknowledges. It calls `inbox.setState`, which rewrites the
 * message file. Exactly the sort of mistake the test pins.
 */
export const WRITING = Object.freeze([
  'mem_answer', 'mem_log', 'mem_duty_close', 'mem_inbox_new',
  'mem_inbox_write', 'mem_inbox_ack', 'mem_project_init', 'mem_store_put',
  // These three sat in READING until 2026-09-20, and the probe in
  // test/mcpprofile.test.mjs was green the whole time, because it only
  // looked at the case body in bin/mem-mcp and each of them writes one
  // hop further in:
  //
  //   mem_heartbeat     -> heartbeat.beat() -> fs.appendFileSync
  //   mem_bridge_report -> board.report()   -> fs.appendFileSync
  //   mem_source        -> source.take()    -> memory.logEntry()
  //
  // `mem_source` is the one that mattered: it puts caller-supplied text
  // into the memory under a read-only profile. The other two append to
  // operational files. All three are classified by what the code does.
  'mem_heartbeat', 'mem_bridge_report', 'mem_source',
]);

/**
 * Writing tools that the read-only profile lets through anyway.
 *
 * **This is a policy decision, and it is deliberately not a
 * classification.** `mem_heartbeat` writes — it says so in WRITING, and
 * the source probe holds it to that. But an agent that may only read
 * still has to be able to say it is alive, and a heartbeat carries no
 * caller content: it is a name and a timestamp. Refusing it would make
 * a read-only bridge invisible to the board rather than harmless.
 *
 * Kept separate from READING so the two questions stay apart: "does
 * this write?" is answered by the code, "may it write here anyway?" is
 * answered here, by name, one line per exception, with the reason
 * above. A tool added to this list is a decision someone has to defend;
 * a tool moved into READING would be a lie about the code.
 */
export const READONLY_EXCEPTIONS = Object.freeze(['mem_heartbeat']);

const READING_SET = new Set(READING);
const READONLY_EXCEPTIONS_SET = new Set(READONLY_EXCEPTIONS);

/**
 * Read the profile from the environment.
 *
 * Only the exact string `'1'` switches it on. Anything else — `true`,
 * `yes`, an empty string, a typo — leaves the full profile in place.
 * A variable that turns a boundary on by accident is as bad as one
 * that turns it off by accident.
 */
export function fromEnv(env = process.env) {
  return env.CHEAP_MEM_MCP_READONLY === '1' ? PROFILE.READ_ONLY : PROFILE.FULL;
}

/** May this tool be called under this profile? */
export function allowed(name, profile) {
  if (profile !== PROFILE.READ_ONLY) return true;
  // Unknown counts as writing. See the head of this file.
  return READING_SET.has(String(name)) || READONLY_EXCEPTIONS_SET.has(String(name));
}

/** Which tools are listed at all. */
export function visible(tools, profile) {
  if (profile !== PROFILE.READ_ONLY) return tools;
  // Listed and callable must be the same set. A tool that is allowed
  // but invisible is a tool nobody finds; a tool that is visible but
  // refused is a tool everybody tries.
  return tools.filter((t) => allowed(String(t?.name ?? t), profile));
}

/**
 * The refusal. It names the profile and how to turn it off — a
 * boundary whose reason cannot be seen looks like a defect.
 */
export function refusal(name) {
  return `'${name}' writes, and this bridge runs read-only `
    + '(CHEAP_MEM_MCP_READONLY=1). Nothing was changed.';
}

/**
 * Is every tool classified? Returns the ones in neither list.
 *
 * Used by the test: a new tool that nobody sorted shows up here
 * instead of quietly being refused for the wrong reason.
 */
export function coverage(names = []) {
  const known = new Set([...READING, ...WRITING, ...READONLY_EXCEPTIONS]);
  return names.filter((n) => !known.has(String(n)));
}
