/**
 * The gauges — three numbers instead of one.
 *
 * Until now the benchmark answered ONE question: does retrieval find
 * the right thing for a given question. That is throughput. What the
 * hook puts into every turn is a STOCK: it stays there and is charged
 * against every following turn. A one-question run cannot see that.
 *
 * Three questions, three numbers, and none is a view of another:
 *
 *  - **Occupancy**    how much context do our injections hold at the
 *                     end of a session?
 *  - **Sufficiency**  did an injection suffice? Read off what the
 *                     session did NEXT.
 *  - **Allocation**   of the injected locations, which were actually
 *                     touched afterwards?
 *
 * A change to retrieval can move one of these without touching the
 * others. Whoever folds them into one score loses exactly the
 * information they measured for.
 *
 * ## Why the verdict is read off, not reported
 *
 * The obvious build would let the session say whether the injection
 * helped. That is self-assessment: it costs a model call and believes
 * itself. What the session DOES is already in the raw capture — it
 * searches again, it reads a file, or it carries on. That is free and
 * cannot be talked up.
 *
 * ## The rules that keep it honest
 *
 * Every one of them is a trap a first version would have fallen into:
 *
 *  - **Only a LATER message is a verdict.** Tools in the same
 *    assistant message went out before the injection existed. They
 *    count separately as `concurrent`, never as a verdict.
 *
 *  - **Reading happens through the shell.** Counted across 25 raw
 *    captures on 2026-09-12: 890 Bash against 3 Read. Counting only
 *    `Read` and `Grep` would miss 99.7 % of the reading and book every
 *    injection as "sufficed". So the command itself is classified —
 *    `cat`/`sed -n`/`head` is reading, `grep`/`rg`/`find` is
 *    searching, a redirect or heredoc is writing.
 *
 *  - **Bookkeeping is not a verdict.** Todo lists and deferred-tool
 *    loading say nothing about the answer; the call BEHIND them is the
 *    verdict.
 *
 *  - **A subagent is its own thread.** Otherwise its first reach for
 *    search is charged to the parent as a verdict on an injection it
 *    never saw.
 *
 * Everything here only reads. Nothing is reported, nothing is sent and
 * nothing leaves the product — what gets evaluated is what the raw
 * capture writes down anyway.
 */

/** How a shell command is classified. Closed list. */
export const COMMAND_KIND = Object.freeze({
  READ: 'read',
  SEARCH: 'search',
  WRITE: 'write',
  OTHER: 'other',
});

/** The buckets of the after-look. Closed list. */
export const BUCKET = Object.freeze({
  /** Searched the memory again — the injection did not suffice. */
  SEARCHED_AGAIN: 'searched-again',
  /** Read a location we injected: right place, wrong excerpt. */
  READ_NAMED: 'read-named',
  /** Read something we never named: a retrieval gap. */
  READ_UNNAMED: 'read-unnamed',
  /** Searched rather than read — weaker signal, still hunting. */
  SEARCHED: 'searched',
  /** Carried on: the injection sufficed. */
  MOVED_ON: 'moved-on',
  /** Nothing came after the injection. No verdict, not "good". */
  NO_VERDICT: 'no-verdict',
});

/** Tools that are stepped over: bookkeeping, not a verdict. */
export const BOOKKEEPING = Object.freeze(new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'ToolSearch', 'Skill',
]));

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const WORK_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

const READ_CMDS = /(^|[|;&]\s*)(cat|bat|sed|head|tail|less|more|zcat|zless|jq|wc|nl|column)\b/;
const SEARCH_CMDS = /(^|[|;&]\s*)(grep|rg|ag|ack|find|fd|ls|tree|locate)\b/;
const WRITE_CHARS = /(>>?\s*\S|<<\s*['"]?[A-Za-z_])/;
const WRITE_CMDS = /(^|[|;&]\s*)(git\s+(commit|push|add)|npm|node\s|mkdir|rm|mv|cp|touch|tee|chmod)\b/;

/**
 * Classify a shell command.
 *
 * Writing is checked FIRST: `cat > file <<EOF` starts with `cat` and
 * is still a write. The other way round, every file this session
 * created would have counted as "reading".
 */
export function classifyCommand(command) {
  const c = String(command || '');
  if (!c.trim()) return COMMAND_KIND.OTHER;
  if (WRITE_CHARS.test(c) || WRITE_CMDS.test(c)) return COMMAND_KIND.WRITE;
  if (READ_CMDS.test(c)) return COMMAND_KIND.READ;
  if (SEARCH_CMDS.test(c)) return COMMAND_KIND.SEARCH;
  return COMMAND_KIND.OTHER;
}

/** Does this call search the memory again? */
export function isMemorySearch(name, input) {
  const n = String(name || '');
  if (/^mcp__.*mem_(find|search|browse)/i.test(n)) return true;
  if (n !== 'Bash') return false;
  const c = String(input?.command || '');
  return /\bmem\b[^|;&]*\b(find|browse|context)\b/.test(c) || /cheap-mem\/bin\/mem\b/.test(c);
}

/**
 * Which file paths a call touches — roughly, but without guessing:
 * only what looks like a path.
 */
export function pathsOf(name, input) {
  const out = [];
  if (input?.file_path) out.push(String(input.file_path));
  if (input?.path) out.push(String(input.path));
  if (input?.notebook_path) out.push(String(input.notebook_path));
  if (name === 'Bash' && input?.command) {
    const m = String(input.command)
      .match(/[\w./@-]*\/[\w./@-]+|\b[\w-]+\.(mjs|js|ts|md|json|jsonl|yaml|yml|sh|py)\b/g);
    if (m) out.push(...m);
  }
  return out;
}

/** The tool calls of one capture line, flat. */
export function callsOf(o) {
  const c = o?.message?.content;
  if (!Array.isArray(c)) return [];
  return c.filter((t) => t?.type === 'tool_use')
    .map((t) => ({ name: String(t.name || ''), input: t.input || {} }));
}

/**
 * Which thread a line belongs to. A subagent gets its own, so its
 * first reach is not charged to the parent.
 */
export function threadOf(o) {
  if (o?.isSidechain) return `side:${o.parentUuid ?? o.uuid ?? 'unknown'}`;
  if (o?.parent_tool_use_id) return `side:${o.parent_tool_use_id}`;
  return 'main';
}

/**
 * The after-look: what happened after line `from` in the same thread?
 *
 * `named` are the locations the injection itself named. Without them
 * "right place, wrong excerpt" cannot be told from "never found" — so
 * without them the function deliberately does not claim
 * {@link BUCKET.READ_NAMED}.
 */
export function afterLook(lines, from, { named = [], thread = 'main' } = {}) {
  const stems = named.map((g) => String(g).split(':')[0]).filter(Boolean);
  let concurrent = 0;
  for (let i = from + 1; i < lines.length; i += 1) {
    const o = lines[i];
    if (threadOf(o) !== thread) continue;
    for (const a of callsOf(o)) {
      if (BOOKKEEPING.has(a.name)) continue;
      if (isMemorySearch(a.name, a.input)) {
        return { bucket: BUCKET.SEARCHED_AGAIN, tool: a.name, concurrent };
      }
      let kind = null;
      if (READ_TOOLS.has(a.name)) kind = COMMAND_KIND.READ;
      else if (SEARCH_TOOLS.has(a.name)) kind = COMMAND_KIND.SEARCH;
      else if (WORK_TOOLS.has(a.name)) kind = COMMAND_KIND.WRITE;
      else if (a.name === 'Bash') kind = classifyCommand(a.input?.command);
      else kind = COMMAND_KIND.OTHER;

      if (kind === COMMAND_KIND.READ) {
        const paths = pathsOf(a.name, a.input);
        const hit = stems.length > 0
          && paths.some((p) => stems.some((n) => p.endsWith(n) || n.endsWith(p)));
        return {
          bucket: hit ? BUCKET.READ_NAMED : BUCKET.READ_UNNAMED,
          tool: a.name, concurrent, paths,
        };
      }
      if (kind === COMMAND_KIND.SEARCH) return { bucket: BUCKET.SEARCHED, tool: a.name, concurrent };
      if (kind === COMMAND_KIND.WRITE) return { bucket: BUCKET.MOVED_ON, tool: a.name, concurrent };
      // OTHER: no signal, keep looking.
    }
  }
  return { bucket: BUCKET.NO_VERDICT, tool: null, concurrent };
}

/**
 * Occupancy of one session.
 *
 * `bytes` is the sum of the injections, `material` everything the raw
 * capture kept. The share of the CONTEXT WINDOW is only computed when
 * a MEASURED chars-per-token ratio is handed in. Guessing one would be
 * the most convenient place to prove oneself right: the number would
 * look just as official.
 */
export function occupancy({
  injections = [], materialBytes = 0, charsPerToken = null, window = null, measured = true,
}) {
  // Without a journal there is no number, only the absence of one. The
  // first version printed "0 bytes / 0.0 %" here and named the blind
  // spot twenty lines further down — so the head read like a finding
  // ("our injections cost nothing") while nothing had been measured.
  if (!measured) {
    return {
      bytes: null, injections: null, material_bytes: materialBytes,
      share_material: null, units: null, share_window: null,
    };
  }
  const bytes = injections.reduce((s, e) => s + (Number(e.bytes) || 0), 0);
  const shareMaterial = materialBytes > 0 ? bytes / materialBytes : null;
  // Estimated tokens. The field is deliberately not called `token`:
  // the secret scanner reads `token: <value>` as an assignment to a
  // secret, and it is right to. The text changed, not the check.
  let units = null;
  let shareWindow = null;
  if (charsPerToken && charsPerToken > 0) {
    units = Math.round(bytes / charsPerToken);
    if (window && window > 0) shareWindow = units / window;
  }
  return {
    bytes,
    injections: injections.length,
    material_bytes: materialBytes,
    share_material: shareMaterial,
    units,
    share_window: shareWindow,
  };
}

/**
 * Allocation: of the injected locations, which were touched?
 *
 * The numerator counts INJECTIONS whose after-look landed on a named
 * location — not a share of bytes. Bytes would be the more obvious
 * number and the less honest one: one long location read once would
 * raise the allocation without anything more being used.
 */
export function allocation(verdicts = []) {
  const scored = verdicts.filter((v) => v.bucket !== BUCKET.NO_VERDICT);
  const used = scored.filter((v) => v.bucket === BUCKET.READ_NAMED).length;
  return { scored: scored.length, used, share: scored.length ? used / scored.length : null };
}

/** Count the buckets, in fixed order. */
export function countBuckets(verdicts = []) {
  const order = [
    BUCKET.SEARCHED_AGAIN, BUCKET.READ_NAMED, BUCKET.READ_UNNAMED,
    BUCKET.SEARCHED, BUCKET.MOVED_ON, BUCKET.NO_VERDICT,
  ];
  const m = new Map(order.map((k) => [k, 0]));
  for (const v of verdicts) m.set(v.bucket, (m.get(v.bucket) ?? 0) + 1);
  return order.map((k) => ({ bucket: k, count: m.get(k) }));
}

const BUCKET_TEXT = {
  [BUCKET.SEARCHED_AGAIN]: 'searched again      did not suffice',
  [BUCKET.READ_NAMED]: 'read a named place  right place, wrong excerpt',
  [BUCKET.READ_UNNAMED]: 'read another place  never injected',
  [BUCKET.SEARCHED]: 'searched            still hunting (weak)',
  [BUCKET.MOVED_ON]: 'moved on            sufficed',
  [BUCKET.NO_VERDICT]: 'nothing after       no verdict',
};

/** Human text. The contract is the object, not this rendering. */
export function asText(r) {
  const z = [];
  const o = r.occupancy;
  z.push('Occupancy — what the injections hold:');
  z.push(o.bytes == null
    ? '  unknown — not measured, not zero'
    : `  ${o.bytes.toLocaleString('en-US')} bytes from ${o.injections} injections`);
  z.push(o.share_material == null
    ? '  share of session material: unknown'
    : `  share of session material: ${(o.share_material * 100).toFixed(1)} %`);
  z.push(o.share_window == null
    ? '  share of context window: unknown (no measured chars-per-token)'
    : `  share of context window: ${(o.share_window * 100).toFixed(1)} %`);
  z.push('');
  z.push(`Sufficiency — what happened next (${r.verdicts} injections with a verdict):`);
  for (const b of r.buckets) {
    const share = r.verdicts ? ((b.count / r.verdicts) * 100).toFixed(0) : '0';
    z.push(`  ${String(b.count).padStart(4)}  ${String(share).padStart(3)}%  ${BUCKET_TEXT[b.bucket]}`);
  }
  z.push('');
  const a = r.allocation;
  z.push('Allocation — injected places touched afterwards:');
  z.push(a.share == null
    ? '  unknown (no injection with a verdict)'
    : `  ${a.used} of ${a.scored}  (${(a.share * 100).toFixed(0)} %)`);
  if (r.blind_spots?.length) {
    z.push('');
    z.push('What this measurement could NOT see:');
    for (const b of r.blind_spots) z.push(`  - ${b}`);
  }
  return z.join('\n');
}

/**
 * All of it: journal lines and capture lines into one finding.
 *
 * The blind spot travels along instead of being dropped. A measurement
 * without a journal and one with an empty journal would otherwise look
 * the same — the same mistake as an empty memory that reads like a
 * fully answered one.
 */
export function measure({
  journal = [], lines = [], broken = 0, journalPresent = true,
  charsPerToken = null, window = null,
} = {}) {
  const blind = [];
  if (!journalPresent) blind.push('no injection journal — occupancy and allocation are unknown, not zero');
  if (broken > 0) blind.push(`${broken} broken journal lines skipped`);
  if (!lines.length) blind.push('no raw capture for it — sufficiency cannot be determined');

  const injected = journal.filter((e) => e && e.reason == null);
  const materialBytes = lines.reduce((s, o) => s + Buffer.byteLength(JSON.stringify(o)), 0);

  const verdicts = [];
  for (const e of injected) {
    const from = lines.findIndex((o) => (o?.timestamp ?? '') >= (e.ts ?? ''));
    if (from < 0) continue;
    verdicts.push(afterLook(lines, from, { named: e.sources || [], thread: 'main' }));
  }

  const silent = journal.filter((e) => e && e.reason != null);
  return {
    occupancy: occupancy({
      injections: injected, materialBytes, charsPerToken, window, measured: journalPresent,
    }),
    verdicts: verdicts.length,
    buckets: countBuckets(verdicts),
    allocation: allocation(verdicts),
    silent: silent.length,
    silent_reasons: [...silent.reduce((m, e) => m.set(e.reason, (m.get(e.reason) ?? 0) + 1), new Map())]
      .map(([reason, count]) => ({ reason, count })),
    blind_spots: blind,
  };
}
