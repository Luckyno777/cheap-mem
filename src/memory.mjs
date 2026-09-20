/**
 * memory — append-only JSONL log per type, per project.
 *
 * Ported from lucky-mem/src/memory.mjs (originally in German).
 * The code is deliberately small: the structure and the append-only
 * discipline are the system, this file is the thin glue.
 *
 * Format: JSONL for append-only logs (decisions/errors/events/timeline),
 * YAML for stable snapshots (facts/people/sources — human-edited, not
 * touched by this CLI).
 *
 * Time: ISO-UTC with second resolution.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import * as freshness from './freshness.mjs';
import * as authority from './authority.mjs';
import * as cfgmod from './config.mjs';
import * as bidi from './bidi.mjs';
import { appendLine } from './append.mjs';
import * as capabilityMod from './capability.mjs';

/**
 * The per-writer hash chain (`src/chain.mjs`), loaded lazily and
 * tolerantly rather than with a normal `import`.
 *
 * `test/entry-version.test.mjs` copies THIS file alone, plus a
 * hand-checked list of its dependencies, into a throwaway sandbox
 * directory to test schema-version behaviour in isolation — the same
 * situation `FLOOD_STOPWORDS` below is duplicated (not imported) to
 * avoid. A normal `import * as chain from './chain.mjs'` would fail
 * module resolution for that sandbox the moment memory.mjs is loaded at
 * all — before a single test in that file runs, whether or not it ever
 * calls `logEntry` — breaking a suite about entry versioning for a
 * reason it has nothing to do with. A top-level `await import()`
 * resolves once, here, and the `catch` turns "chain.mjs is not sitting
 * beside this file" into "sealing is skipped", never into "this module
 * fails to load". `logEntry` itself stays fully synchronous either way:
 * by the time it runs, `chain` is already settled to one or the other.
 */
let chain = null;
try { chain = await import('./chain.mjs'); } catch { /* sibling not present here — sealing skipped */ }

/**
 * The crypto-shredding module (`src/shred.mjs`), loaded the same
 * tolerant way as `chain` above and for the identical reason (the
 * entry-version sandbox in `test/entry-version.test.mjs` copies this
 * file alone plus a hand-picked dependency list). `shred` is null when
 * the sibling module is not sitting beside this one; every call site
 * below checks that explicitly rather than assuming it loaded.
 */
let shred = null;
try { shred = await import('./shred.mjs'); } catch { /* sibling not present here — crypto-shredding unavailable */ }

/**
 * Known log types. Each has its own JSONL per project + global.
 *
 * Five of these exist because a digest run kept producing entries that
 * did not fit the original four. A `thought` is not an `event`; a
 * `duty` is not a `decision`. Forcing them into the wrong drawer makes
 * the search worse, because the field weights stop meaning anything.
 *
 * All of them are append-only. A correction is a NEW line carrying
 * `replaces_id` — never an edit. Rewriting history is how a memory
 * starts lying.
 */
export const TYPES = Object.freeze({
  decision: 'decisions.jsonl',   // a choice, with the reason for it
  error: 'errors.jsonl',         // something broke, and why
  event: 'events.jsonl',         // it happened: a release, a hire, a start
  timeline: 'timeline.jsonl',    // a fact that changes over time
  thought: 'thoughts.jsonl',     // reasoning worth keeping, not yet a decision
  learning: 'learnings.jsonl',   // what to do differently next time
  duty: 'duties.jsonl',          // something owed to someone
  question: 'questions.jsonl',   // something we do NOT know. No debtor and
                                 // no lifecycle of its own: it closes over
                                 // the existing `resolves` edge. See
                                 // src/question.mjs.
  skill: 'skills.jsonl',         // a capability acquired, with evidence
  procedure: 'procedures.jsonl', // a norm for ALL — "this is how we do it
                                 // here". NOT the same as `skill`: a
                                 // capability is acquired, a procedure is
                                 // issued. Only a human can issue one and
                                 // the MCP bridge does not write it at all.
                                 // See src/procedure.mjs.
  source: 'sources.jsonl',       // a pointer at knowledge that already exists —
                                 // indexed, not copied. Local files live in
                                 // the store, the entry carries the hash and
                                 // a capped, redacted excerpt. See
                                 // src/source.mjs.
  update: 'updates.jsonl',       // a version, a dependency, a config change
  link: 'links.jsonl',           // a typed relation between two entries
});

/**
 * The closed vocabulary of relations between entries.
 *
 * Deliberately small. An open vocabulary would let every digest run invent
 * a new verb, and a graph whose edges mean whatever the writer felt that
 * day cannot be traversed by code — only re-read by a model, which is the
 * cost this whole design exists to avoid.
 */
export const LINK_KINDS = Object.freeze({
  causes: 'the source brought the target about',
  generalizes: 'the source is the lesson drawn from the target(s)',
  contradicts: 'the source and target cannot both be right',
  resolves: 'the source closed the target out',
});

/**
 * Which entries this one says it was drawn from — ALL the shapes.
 *
 * **The finding (external audit, 2026-09-17).** Provenance is written in
 * this repo in two shapes, both genuine: `origin.derived_from` (the
 * digest, `standing()`, the desk, `mem why`) and
 * `provenance.derived_from` / `provenance.inferred_from`
 * (`src/teach.mjs`, `src/basis.mjs`). `src/net.mjs` read only the second,
 * so a real lineage written in the first shape produced ZERO edges — the
 * net drew a memory less connected than the one on disk.
 *
 * Not "read any structure as provenance": the shapes are a closed list,
 * and a third one is added here, once, where every reader picks it up.
 *
 * Returns entry ids, unchecked — whether the target exists is the
 * caller's question, and answering it here would hide a dangling edge,
 * which is exactly what `build()` in net.mjs counts on purpose.
 */
export const HERKUNFT_FELDER = Object.freeze([
  ['origin', 'derived_from'],
  ['provenance', 'derived_from'],
  ['provenance', 'inferred_from'],
]);

export function derivedFrom(e) {
  const out = [];
  for (const [aussen, innen] of HERKUNFT_FELDER) {
    const q = e?.[aussen]?.[innen];
    if (!Array.isArray(q)) continue;
    for (const x of q) if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * Duty is the ONLY type with a lifecycle.
 *
 * Closing one does not overwrite the original line; it appends a new
 * line carrying `closes_id`. `openDuties()` folds the two into a
 * current view. That keeps the append-only rule intact while still
 * answering "what do I still owe?" — the one question a flat log
 * cannot answer.
 */
export const DUTY_STATE = Object.freeze({
  OPEN: 'open',
  DONE: 'done',
  DROPPED: 'dropped',
});

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Names a project may not take, because something else already means
 * them. `global` is the sharp one: every filter treats `project:
 * 'global'` as "the root bucket, not a project", so a project actually
 * named global becomes unreachable through its own name — the query
 * silently answers about somewhere else.
 */
export const RESERVED_PROJECT_NAMES = Object.freeze(['global', 'raw', 'inbox']);

export function checkProjectName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Project name missing');
  }
  if (RESERVED_PROJECT_NAMES.includes(name)) {
    throw new Error(
      `Project name '${name}' is reserved — it already means something else `
      + `in every filter. Reserved: ${RESERVED_PROJECT_NAMES.join(', ')}`);
  }
  if (name.length > 40) {
    throw new Error(`Project name '${name}' too long (>40 chars)`);
  }
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Error(
      `Project name '${name}' invalid — allowed: lowercase a-z, 0-9, hyphen; must start and end with alphanumeric`);
  }
}

/**
 * Where an entry was found, spelled the same on every platform.
 *
 * `_source` is not a local convenience. It travels: into the notes that
 * `broadcast` drops in another agent's inbox, into what `mem` prints for
 * a human, and into the `sources` an injection names — which
 * `gauges.afterLook` then matches against the paths it sees in tool
 * calls. `path.relative` answers in the host separator, so on Windows
 * all three carried `global\\learnings.jsonl`: the note's evidence did
 * not match, and the gauge could never report READ_NAMED at all. A
 * measurement reading zero for a reason that has nothing to do with
 * what it measures is worse than no measurement.
 *
 * The backslash is replaced unconditionally rather than via `path.sep`,
 * because `path.sep` is right only for a path this host just produced
 * and useless for one read back from a file another run wrote. It is
 * safe here: a project name is `[a-z0-9-]` only (see
 * {@link checkProjectName}) and the book names are fixed, so a
 * backslash never belongs to a real one.
 *
 * The replacement lives in {@link canonicalSep}, separately, because on
 * a POSIX host `path.relative` never produces a backslash — so a test
 * that goes through `asSource` cannot tell a working normaliser from a
 * missing one. Only the pure function can be handed the Windows shape.
 */
export const canonicalSep = (rel) => String(rel).replace(/\\/g, '/');

/** {@link canonicalSep} applied to the path of a found entry. */
export const asSource = (root, p) => canonicalSep(path.relative(root, p));

export function logPath(root, type, project = null) {
  if (!Object.hasOwn(TYPES, type)) {
    throw new Error(`Unknown type '${type}'. Known: ${Object.keys(TYPES).join(', ')}`);
  }
  // The project name is validated HERE, not only where a project is
  // created. checkProjectName existed from the start but was called
  // only from projectInit, so `mem log --project ../../../../tmp/x`
  // walked straight out of the memory and logEntry created the
  // directories on the way: verified, a file landed outside the root.
  //
  // It matters more than a stray file. The permission the docs describe
  // as narrow — `Bash(node <root>/bin/mem:*)`, granted to the unattended
  // digest — was enough on its own to write anywhere the process can
  // reach, with no git or file permission at all. This is the one place
  // every caller (CLI, MCP server, library) funnels through.
  if (project !== null && project !== undefined) checkProjectName(project);
  const file = TYPES[type];
  return project
    ? path.join(root, 'projects', project, file)
    : path.join(root, 'global', file);
}

/**
 * Append a line to a JSONL log. Never modifies an existing line.
 * If an entry needs correction, a new line with `replaces_id` is written.
 */

/**
 * Hard ceiling on one FINISHED JSON line, in bytes — the audit finding
 * this exists for (2026-09-19): a 7.6 MB field value wrote through
 * without a word, because `search.RAW_CAP` (20 KB) only trims what the
 * *index* weighs, never what `logEntry` is willing to *write*.
 *
 * **Chosen from measurement, not from the gut.** Two numbers, both
 * measured 2026-09-19:
 *
 *   - The largest line this repo actually holds, across every .jsonl
 *     under version control (global/, shared/, eval/runs/ — the raw/
 *     capture archive is a different, exempt path, see below): 1792
 *     bytes, `eval/runs/zustandslos-sonnet5.jsonl:69`.
 *   - The largest field ALLOWED to be legitimately large by design:
 *     `source.MAX_EXCERPT` caps a source excerpt at 4000 characters,
 *     which is at most ~16 KB once encoded as worst-case 4-byte UTF-8
 *     and given a title, tags and the rest of the entry on top.
 *
 * 1 MB is ~65x that DESIGNED ceiling and ~585x anything ever actually
 * written — the same shape of headroom the sibling house used for its
 * own cap (64 KB over a measured 3519-byte max, 18x), scaled to the one
 * field in this house's schema that is allowed to be large on purpose.
 * It stays orders of magnitude below the 7.6 MB that motivated this in
 * the first place, so a real accident still trips it immediately.
 *
 * Configurable via `.mem/config.json`'s `maxEntryBytes` (the same
 * ad-hoc-optional-key pattern as `cfg.hooks.Stop` — not every knob lives
 * in `config.DEFAULT_CONFIG`, only the ones every fresh `mem init`
 * should see spelled out). This constant is the floor nobody has to
 * configure to get.
 */
export const MAX_ENTRY_BYTES = 1024 * 1024; // 1 MB

/**
 * The configured cap, or the floor above when there is no config yet
 * (a bare tmp dir in a test, a root mid-`mem init`) or it says nothing.
 * Never throws: a write path that could fail on reading its OWN limit
 * would be worse than one with no limit at all.
 */
function maxEntryBytesFor(root) {
  try {
    const cfg = cfgmod.readConfig(root);
    const v = Number(cfg.maxEntryBytes);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* no config yet, or unreadable — fall back to the floor */ }
  return MAX_ENTRY_BYTES;
}

/**
 * Who is writing, when nobody said.
 *
 * **The finding (2026-09-08, reference deployment).** 855 of 1081
 * entries carried no agent field — 79 %. Only the MCP bridge stamped
 * one; the CLI never did. A field that is absent three quarters of the
 * time is not an axis, it is an anecdote: `mem agents`, every
 * authority comparison and the error broadcast all rest on it.
 *
 * **Why never a fallback to 'session'.** That would be an INVENTED
 * origin, and an invented origin is worse than none — it looks
 * credible, so a later reader takes it for evidence. `human:<user>` is
 * true: somebody typed this at a shell. The prefix keeps the human and
 * machine sets disjoint so the agent board can show both without
 * confusing them.
 *
 * **Old entries are NOT backfilled.** Stamping them now would be
 * inventing origin at scale. The corpus heals forward.
 */
export function agentDefault(env = process.env) {
  const set = String(env.CHEAP_MEM_AGENT ?? env.MEM_AGENT ?? '').trim();
  if (set) return set;
  let user = String(env.USER ?? env.LOGNAME ?? env.USERNAME ?? '').trim();
  if (!user && env === process.env) {
    try { user = String(os.userInfo().username ?? '').trim(); } catch { /* no account readable */ }
  }
  return user ? `human:${user}` : 'human:unnamed';
}

/**
 * Schema version of an ENTRY — not of the file.
 *
 * **Entry, not file.** The file is one append-only JSONL log meant to
 * hold entries written under different rules for years: `decisions.jsonl`
 * from 2026 will still sit beside a line written in 2031 under a shape
 * nobody here has designed yet. A file-level version could only ever
 * describe the LAST line appended — a fact about whatever happens to be
 * at the bottom right now, not about the file. Stamping the ENTRY instead
 * means every line, forever, carries the rules it was actually written
 * under, and a reader picks the adapter per LINE, never per file.
 *
 * **Absent means v=0, and v=0 is a KNOWN fact, not an unknown one.**
 * Every line written before this change has no `v` field, with no
 * exceptions, because the field did not exist yet. That is not "we don't
 * know what version this is" — it is "this was written before
 * versioning", which is exactly as knowable as any other historical fact
 * already sitting in this corpus. Folding that into `unknown` would erase
 * the one thing the corpus IS certain of about its own past. A line whose
 * `v` is PRESENT but does not parse as a non-negative integer — a
 * corrupted line, a hand-edit, a future format this build has never seen
 * — is the genuinely unknown case, and stays unknown rather than being
 * rounded down to 0. See `entryVersionOf`.
 *
 * **Stamped in exactly one place.** `logEntry` is the only function in
 * this repo that appends to a TYPES log (`decisions.jsonl`,
 * `errors.jsonl`, ... — checked by grepping every `appendLine` in
 * `src/`: the others write board reports, heartbeats, the observation
 * ledger, the redaction register, the topic-alias log and similar —
 * fixed-shape records of their own, not entries, and never read back
 * through `readLog`/`find`/`entriesById`). One door, one place that
 * stamps.
 */
export const ENTRY_VERSION = 1;

/**
 * One reader per version, forever. `adaptEntry` normalises any entry —
 * whichever version it carries — into the shape the current code expects.
 * Because the log is append-only, this map can only ever GROW: the day
 * `ENTRY_VERSION` becomes 2, adapter `1` stays exactly as it is (it still
 * has to read every v=1 line already on disk, unchanged) and a NEW
 * adapter `2` joins it.
 *
 * **The guard, not the comment.** "A new version must not be
 * introducible without a reader" used to be exactly the kind of rule
 * that lives only in prose — and a rule that lives only in a comment is
 * not enforced, it is hoped for. `assertVersionHasReader` runs the
 * moment this module loads (see the call right below the map), so
 * bumping `ENTRY_VERSION` without adding its adapter does not produce a
 * subtly wrong reader discovered later — it stops the module from
 * importing at all, everywhere, immediately. A rule that only lives in
 * a comment is worse than no rule at all, because it looks enforced.
 */
const ENTRY_ADAPTERS = new Map([
  // v=0: no `v` field at all — every entry ever written before this
  // change. The adapter's only job is to say so explicitly.
  [0, (entry) => ({ ...entry, v: 0 })],
  // v=1: the shape this change introduces. `v` is already present and
  // correct; nothing to translate (yet).
  [1, (entry) => ({ ...entry })],
]);

export const V_UNKNOWN = 'unknown';

function assertVersionHasReader(v) {
  if (!ENTRY_ADAPTERS.has(v)) {
    throw new Error(
      `Entry schema version ${v} has no reader adapter registered in `
      + 'ENTRY_ADAPTERS (src/memory.mjs). A version must never be '
      + 'introduced without one — add the adapter first, then the version.');
  }
}
// The guard fires at IMPORT time, for the version this build actually
// writes — the mistake it exists to catch (bump ENTRY_VERSION, forget
// the adapter) is caught before a single entry is written, not after.
assertVersionHasReader(ENTRY_VERSION);

/**
 * What version an entry ACTUALLY carries, before any adaptation.
 *
 *   - no `v` field at all          -> 0 ("written before versioning")
 *   - `v` a non-negative integer   -> that integer
 *   - anything else (string,
 *     float, negative, NaN, ...)   -> V_UNKNOWN
 *
 * Never silently coerced to 0 — an unparseable `v` is a different fact
 * from an absent one, and collapsing them is exactly the mistake this
 * field exists to make impossible.
 */
export function entryVersionOf(entry) {
  if (entry == null || typeof entry !== 'object') return V_UNKNOWN;
  if (!('v' in entry)) return 0;
  const raw = entry.v;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  return V_UNKNOWN;
}

/**
 * Read one entry through the adapter for whatever version it claims.
 *
 * A `V_UNKNOWN` entry is returned as-is, flagged — the house's fourth
 * state applies to a field exactly as it does to a check:
 * "Nicht messbar ist nicht null." A version that DOES parse but has no
 * registered adapter throws here too, at read time rather than import
 * time — this is the one path where that can happen for a version
 * genuinely written by some OTHER, newer build of this code (a corpus
 * is read by whichever version of the reader happens to run, not only
 * by the one that wrote the line).
 */
export function adaptEntry(entry) {
  const v = entryVersionOf(entry);
  if (v === V_UNKNOWN) return { ...entry, v: V_UNKNOWN };
  assertVersionHasReader(v);
  return ENTRY_ADAPTERS.get(v)(entry);
}

export function logEntry(root, type, data, { project = null, now = new Date() } = {}) {
  // The agent comes from the origin stamp when it is not set explicitly.
  // Two routes, so the second axis fills itself without every caller
  // having to remember:
  //   origin.agent    what the digest writes in
  //   origin.surface  vm -> vm-admin, cloud -> session
  // Without this the agent board stays empty while several agents write —
  // and then nobody can see who actually contributed what.
  if (!data.agent && data.origin && typeof data.origin === 'object') {
    const o = data.origin;
    const derived = o.agent ?? ({ vm: 'vm-admin', cloud: 'session' })[o.surface];
    if (typeof derived === 'string' && derived.trim()) {
      data = { ...data, agent: derived.trim() };
    }
  }
  // **Only now the default** — after the explicit field and after the
  // origin stamp have had their turn. The first version of this stamped
  // it FIRST and thereby won every time: `origin.surface` never derived
  // anything again, and a digest run's entries came out as
  // `human:<whoever ran it>`. A default that runs before the real
  // sources is not a default, it is an override. Caught by the existing
  // agents test, not by reading the code.
  if (!data.agent) data = { ...data, agent: agentDefault() };

  // Authority: normalised if given, left ABSENT if not.
  //
  // Deliberately not defaulted to a tier here. A CLI write could be the
  // owner typing or an agent scripting, and this function cannot tell —
  // guessing 'user' would hand every script the top tier, and stamping
  // 'unknown' on everything would make legacy and new data
  // indistinguishable. An absent field reads as `unknown` at comparison
  // time, which is the same conservative answer without pretending the
  // question was asked.
  if (data.authority !== undefined) {
    const t = String(data.authority).toLowerCase().trim();
    data = { ...data, authority: authority.TIERS.includes(t) ? t : authority.DEFAULT_TIER };
  }

  // Ceiling on the write path.
  //
  // A process may be run with CHEAP_MEM_MAX_AUTHORITY, and then no entry
  // it writes can claim a higher tier than that — whatever it puts in the
  // field. The digest sets it to `inferred`, because a model's output IS
  // an inference over other claims, and because text inside a captured
  // transcript can steer what the digest emits. Without the ceiling a
  // sentence in someone else's document could mint a `user`-tier claim.
  //
  // Enforced here rather than by instructing the writer: an instruction is
  // a request, and the thing being constrained is precisely a process that
  // may have been told otherwise. The demotion is RECORDED, never silent.
  const ceiling = authority.ceilingFromEnv();
  if (ceiling) {
    const c = authority.clampTier(data.authority ?? authority.DEFAULT_TIER, ceiling);
    // Only ever LOWERS. An unstamped write stays unstamped — stamping it
    // with the ceiling would turn a ceiling into a floor and raise an
    // entry of genuinely unknown provenance above `unknown`, which is the
    // opposite of what this is for.
    if (c.clamped) {
      data = { ...data, authority: c.tier, authority_clamped_from: c.from };
    }
  }

  const p = logPath(root, type, project);
  const ts = data.ts ?? new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // A SUPPLIED id is checked against the whole corpus; a generated one is
  // not. That asymmetry is deliberate.
  //
  // Ids are unique across types and projects, and every resolver takes the
  // FIRST match. A second line with the same id therefore does not surface
  // an error — it silently moves what every link points at. The sibling
  // project lucky-mem carries exactly one such duplicate, and it came in
  // on this path: copied or migrated, not rolled.
  //
  // For generated ids the check would be theatre. At ~62 bits and a
  // million entries the collision probability is around 1e-7, and putting
  // an O(n) scan on the hot path would make a batch write O(n^2) for a
  // case that does not occur. The doctor catches it if the maths ever
  // surprises us.
  if (data.id && takenIds(root).has(data.id)) {
    throw new Error(
      `The id '${data.id}' is already taken. Ids are unique across types and `
      + 'projects; otherwise resolvers take the first match and every link '
      + 'points somewhere else depending on scan order. Omit --id and one is '
      + 'generated.');
  }
  const id = data.id ?? shortId();
  // The version is authored by the CODE that appends the line, never by
  // the caller — a caller-supplied `v` would look exactly like a real
  // version a real build once produced, and this is precisely the field
  // a later migration has to trust. Whatever `data.v` holds is dropped
  // here, at the one door, not merged past it.
  const { v: _callerVersion, shred: shredRequested, ...rest0 } = data;
  let rest = rest0;

  // Crypto-shredding (P14, src/shred.mjs) — OFF unless a caller
  // explicitly asks (`shred: true`), the same "ships off, explicit
  // switch" shape `chainSealCadenceFor` already uses just below. Turning
  // this on for every write would silently change what every OTHER
  // reader in this repo sees (`find`'s substring match on the raw line,
  // `floodTextOf`, `search.mjs`'s indexer — none of them know to
  // decrypt), which is not a change this build has authorization to make
  // land quietly. See the build report for exactly which readers stay
  // un-integrated with this.
  //
  // `shred` is never persisted: it is a write-time instruction, not a
  // fact about the entry (presence of `body_enc` already says that, once
  // written) — leaving it in the clear would also be a free tell that
  // "this entry is the sensitive one".
  if (shredRequested === true) {
    if (!shred) {
      throw new Error(
        'crypto-shredding requested (shred: true) but src/shred.mjs is not available — '
        + 'refusing to write the body in the clear when encryption was explicitly asked for.');
    }
    const { redacted, key } = shred.shredWrite(rest0);
    rest = redacted;
    // The key is persisted BEFORE the line is appended below. If the
    // process dies between these two writes, the worst case is an
    // orphan key sitting unused in the keyring — harmless. The other
    // order (append first, key second) would risk the opposite: a
    // ciphertext body on disk with no key ever recorded for it,
    // permanently unreadable through no fault of `mem shred` at all.
    shred.putKey(root, id, key, { now });
  }
  const entry = { id, ts, v: ENTRY_VERSION, ...rest };

  fs.mkdirSync(path.dirname(p), { recursive: true });

  const line = JSON.stringify(entry);
  if (line.includes('\n')) {
    throw new Error('Newline in log entry — would break JSONL format');
  }
  // Measured on the FINISHED line, not on any one field — a cap on a
  // single field is evaded by adding more fields or a second large one;
  // the line is what actually lands on disk and what every reader has
  // to load back into memory. Refuses outright: cheap-mem never silently
  // truncates a write, because a truncated entry LOOKS complete and is
  // not, which is worse than no entry at all.
  const bytes = Buffer.byteLength(line, 'utf8');
  const cap = maxEntryBytesFor(root);
  if (bytes > cap) {
    throw new Error(
      `Entry too large: ${bytes} bytes, cap is ${cap} bytes `
      + '(.mem/config.json "maxEntryBytes" to raise or lower it). '
      + 'Refusing to write rather than truncate a field silently.');
  }
  // **Durability promise, stated where the write happens.**
  //
  // `appendLine` (src/append.mjs) probes the file's last byte and then
  // does one `fs.appendFileSync` — `open` + `write` + `close` with no
  // `fsync`/`fdatasync` in between. When `logEntry` RETURNS, the line has
  // reached the OS (the kernel's page cache) — a reader that opens the
  // same file right after, in this process or another, sees it — but it
  // is NOT guaranteed to have reached the disk. A kernel panic or a power
  // loss between this line returning and the next background writeback
  // can still lose it. This is a stated cost, not a silent one: adding an
  // `fsync` here was measured at ~0.24–0.29 ms/write (open+write+fsync+
  // close, median of 15, vs ~0.006–0.01 ms for the bare append above —
  // see `test/p16-durability-promise.test.mjs`), which is cheap in
  // isolation but is not what `mem log`'s 8.91 entries/sec ceiling is
  // spent on (`src/cli/commands/write.mjs`'s pre- and post-write corpus
  // scans dominate that number by two to three orders of magnitude — see
  // `test/p16-append-exponent.test.mjs`), so turning it on here would pay
  // a real cost for a guarantee the current bottleneck does not need yet.
  // `test/p16-durability-promise.test.mjs` proves the claim made in this
  // comment (`fsyncSync`/`fsync` is never called on this path) rather
  // than trusting the prose.
  appendLine(p, `${line}\n`);

  // Chain sealing (src/chain.mjs), best-effort and OPT-IN — see
  // `chainSealCadenceFor` for why this is not on by default, and
  // `CHAIN_SEAL_CADENCE` for the cadence to configure when it is turned
  // on. `chain` is null when the sibling module is not sitting beside
  // this one (the entry-version sandbox — see the import comment above);
  // either way a sealing failure must never turn a write that already
  // landed on disk into a thrown error from `logEntry`.
  if (chain) {
    const cadence = chainSealCadenceFor(root);
    if (cadence > 0) {
      try {
        chain.maybeSeal(p, chain.writerOf(entry), { cadence, now });
      } catch { /* the write already succeeded; sealing is bookkeeping, not the write itself */ }
    }
  }

  return { path: p, entry };
}

/**
 * Read one entry's body through crypto-shredding (`src/shred.mjs`) if
 * it carries `body_enc`, or hand back its `SHREDDABLE_FIELDS` unchanged
 * if it does not. See `shred.readEntryBody` for the exact four-state
 * result shape (`plain` / `ok` / `unreadable: keyring-absent` /
 * `unreadable: no-key|key-corrupt|decrypt-failed`).
 *
 * `{ state: 'unreadable', reason: 'shred-module-absent' }` when
 * `shred.mjs` itself is not sitting beside this file (the entry-version
 * sandbox) — a fourth flavour of "cannot currently answer", never
 * silently treated as `plain`, which would claim an entry has no
 * protected body when the truth is that nothing here can check.
 */
export function readEntryBody(root, entry) {
  if (!shred) return { state: 'unreadable', reason: 'shred-module-absent', fields: null };
  return shred.readEntryBody(root, entry);
}

/**
 * Crypto-shred one entry: destroy its key (so its body becomes and
 * stays unreadable), and append an ordinary new line recording the
 * deletion — the same "a correction is a new line, never an edit" shape
 * this codebase already uses for `replaces_id` and a duty's
 * `closes_id`. The original line is never touched; nothing here rewrites
 * a byte of the log.
 *
 * Throws if `type`/`project` do not hold an entry `id`, or if that entry
 * was never written with `shred: true` (no `body_enc` — there is no key
 * to destroy, so nothing this function does would mean anything).
 *
 * Returns `{ destroyed, marker }` — `destroyed` is `shred.destroyKey`'s
 * own result (`{ destroyed: true, ... }`, or `{ destroyed: false,
 * reason: 'no-such-key' }` for an entry already shredded), `marker` is
 * the newly appended entry (see `shredStatus` for reading it back).
 */
export function shredEntry(root, type, id, {
  project = null, reason = null, now = new Date(), agent = null,
} = {}) {
  if (!shred) {
    throw new Error('crypto-shredding requested but src/shred.mjs is not available');
  }
  let found = null;
  for (const e of iterLog(root, type, { project })) {
    if (e && e.id === id) { found = e; break; }
  }
  if (!found) {
    throw new Error(`No entry '${id}' in ${type}${project ? `/${project}` : ''} — nothing to shred.`);
  }
  if (!found.body_enc) {
    throw new Error(
      `Entry '${id}' was never crypto-shredding-encrypted (no body_enc) — there is no key to `
      + 'destroy. Crypto-shredding only protects entries written with shred: true.');
  }
  const destroyed = shred.destroyKey(root, id, { reason, now });
  const marker = logEntry(root, type, {
    shredded_of: id,
    shredded_reason: reason,
    ...(agent ? { agent } : {}),
  }, { project, now });
  return { destroyed, marker: marker.entry };
}

/**
 * The current deletion state of one entry, folding its original line
 * together with the newest `shredded_of` marker that names it — the
 * same fold shape `openDuties()` uses for `closes_id`. Answers the
 * register's own question ("is this deleted, since when, why") without
 * needing the key at all: the marker line is never encrypted (see
 * `shred.mjs`'s `NEVER_ENCRYPT`), so this works even when the keyring
 * is entirely absent.
 */
export function shredStatus(root, type, id, { project = null } = {}) {
  let marker = null;
  for (const e of iterLog(root, type, { project })) {
    if (e && e.shredded_of === id) marker = e; // append-only: the last one wins
  }
  return marker
    ? { shredded: true, at: marker.ts, reason: marker.shredded_reason ?? null, markerId: marker.id }
    : { shredded: false, at: null, reason: null, markerId: null };
}

/**
 * How many unsealed lines a writer is allowed to accumulate, per
 * (file, writer), before `logEntry` reseals them — when sealing is
 * turned on at all. See `chainSealCadenceFor` just below for why it
 * defaults to OFF.
 *
 * **Chosen from measurement, not a guess**, for anyone who turns it on.
 * Two numbers decide it:
 *
 *   - The cost a seal now has, with `chain.mjs`'s tail-bounded
 *     `appendSeal`/`maybeSeal`: bounded by the TAIL, not the file — see
 *     `test/chain-cost.test.mjs`, which reseals a small constant tail at
 *     1k/10k/100k/500k existing rows and finds the time roughly FLAT
 *     across that whole range (the exact numbers are in that file's own
 *     comment and the build report; the old, file-replaying
 *     implementation ranged from 9.3 ms to 2624.3 ms over the same
 *     ladder). A tail bounded to `CHAIN_SEAL_CADENCE` lines is a small
 *     fraction of even the smallest chunk read, so it lands in the flat
 *     part of that measurement regardless of how large the file has
 *     grown — the whole point of this build.
 *   - The write path's own measured throughput: 8.91 entries/sec through
 *     one writer at 150,008 existing rows (`docs/benchmark-atlas.md`,
 *     "One writer per type"), i.e. ~112 ms per `mem log` call. Against
 *     that, a tail-bounded seal measured at low single-digit
 *     milliseconds is well under 5% of one write's own cost even
 *     sealing on EVERY write — cost is not what argues for batching here.
 *
 * What argues for batching instead is what a seal COSTS every OTHER
 * reader of the log, forever: a seal is an ordinary JSONL line sitting
 * in the same file as real entries (`find`, the search index, `mem
 * agents`, every drawer count) — sealing every write would DOUBLE the
 * number of lines every one of them has to parse, for a value (the
 * unsealed window) that only has to be "short enough to be a bounded
 * blind spot", not zero. 50 caps that window at 50 entries per writer
 * (a few KB of unprotected tail at any moment, since a realistic entry
 * runs under 1.5 KB — see `test/entry-version.test.mjs`'s own COST
 * test) while keeping seal lines to about 2% of a log's entries — a
 * bounded, honest trade rather than either extreme.
 */
export const CHAIN_SEAL_CADENCE = 50;

/**
 * Sealing ships OFF by default. Reachable only through
 * `.mem/config.json`'s ad-hoc-optional `chainSealCadence` key (the same
 * pattern as `maxEntryBytesFor` above) — a positive number turns it on
 * at that cadence; anything else (absent, non-numeric, non-positive, no
 * config at all) means "do not seal".
 *
 * **Why not on unconditionally, the way the build brief asked for.**
 * A seal is, by this module's own design (see `src/chain.mjs`), an
 * ORDINARY JSONL line living in the very same file as real entries —
 * nothing marks it as special to a generic reader. Every existing
 * consumer of a TYPES log was written before this line shape existed
 * and reads generically: `find`, the search index, `procedure.forKeywords`,
 * `standing`/`floodGroups`, and several tests that count lines or rank
 * documents. Turning sealing on unconditionally at a 50-write cadence
 * was tried, and measurably broke four suites this build has no
 * authorization to touch or fix: `test/concurrent-append.test.mjs`
 * (exact survived-line-count assertion — a seal line looks like
 * corruption to it), `test/coverage-floor.test.mjs` and
 * `test/raw-stats.test.mjs`/`test/incremental.test.mjs` (search/ranking
 * assertions disturbed by extra, mostly-empty documents entering the
 * index). None of those are chain.mjs's or memory.mjs's own tests, and
 * `src/search.mjs`/`src/retrieval.mjs` — the files that would need to
 * learn to skip a `chain_seal` line — are explicitly out of scope for
 * this change (other agents were editing them this round). Shipping the
 * unconditional version anyway would be handing back a "done" that
 * quietly breaks work already in flight elsewhere. See the build report
 * for the exact before/after test runs that found this.
 *
 * Confirmed by running each of the four flagged suites once with this
 * hook forced on and once with it forced off, one file at a time (never
 * the full suite — see the house rule on that): all four pass with
 * sealing off, and the same four failures reproduce with it on, with no
 * other change in between.
 */
function chainSealCadenceFor(root) {
  try {
    const cfg = cfgmod.readConfig(root);
    const v = Number(cfg.chainSealCadence);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* no config yet, or unreadable — sealing stays off */ }
  return 0;
}

/** Length of a generated id. Always this, never "usually this". */
export const ID_LENGTH = 12;

/**
 * A generated id: ~62 bits of real randomness, base36, fixed length.
 *
 * The previous version hashed `ts|type|Math.random()` with djb2 and masked
 * the result to 32 bits. Two problems, and the second is the bad one:
 *
 *   - 32 bits is not enough. The birthday bound puts a collision at
 *     roughly 1 % by 10k entries and about 69 % by 100k — for a memory
 *     that is meant to be kept for years, that is a matter of when.
 *   - `Math.random()` is not a source anyone should build identity on.
 *
 * The sibling project lucky-mem found a duplicate id in 874 entries and
 * moved to this scheme; the same arithmetic applies to any corpus.
 *
 * Leading zeros are padded so the length is ALWAYS 12. Otherwise it would
 * be 12 *most of the time*, and "most of the time" is exactly the kind of
 * promise that surprises someone later.
 */
function shortId() {
  let out = '';
  while (out.length < ID_LENGTH) {
    out += BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36);
  }
  return out.slice(0, ID_LENGTH);
}

/**
 * Every id already handed out. Only used when a caller SUPPLIES an id —
 * see the note at the call site for why generated ids skip it.
 */
function takenIds(root) {
  // P12: needs to see EVERY entry (a uniqueness check cannot skip any of
  // them), but only ever keeps its `id` — the rest of each entry, which
  // is most of a drawer's bytes, was being materialised into an array
  // and then thrown away unread. `iterLog` still visits every line; it
  // just never holds more than one at a time while doing it.
  const all = new Set();
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      for (const e of iterLog(root, type, { project })) {
        if (e && e.id) all.add(e.id);
      }
    }
  }
  return all;
}

/**
 * Read a JSONL log. Three states: missing file, empty log, has entries.
 */
/**
 * What has already happened under this error class?
 *
 * **Why this exists.** On 2026-09-07 a first-time install on someone
 * else's machine turned up four defects in one hour. Three of them fell
 * into classes the memory already held — one with the same root cause,
 * six days old, written down in the sibling repository and explicitly
 * marked as a lesson. The knowledge was there every time. Nobody asked,
 * because asking is a separate act.
 *
 * An archive you MUST query does not get queried. So it queries itself,
 * at the moment of logging — when the class is being typed anyway and
 * the head is already on the subject. One pass over the error drawers;
 * no model, no network.
 *
 * `except` takes the id that was just written. Without it every log
 * call would report itself as a repeat, and a warning that always fires
 * is not a warning.
 */
/**
 * The last `tailBytes` of one drawer, as whole parsed lines.
 *
 * **Same shape as `neighbours.mjs`'s `readTail`, deliberately** — this
 * house does not get a second convention for "read the recent part of a
 * drawer and say whether that was the whole thing". Same field names
 * (`entries`, `scannedWholeFile`, `scannedEntries`), same reasoning for
 * why the boundary is safe: a tombstone is always appended AFTER the
 * entry it retires, so nothing inside the window can be wrongly reported
 * live because its retirement fell outside the window — a bounded read
 * here can only miss an OLD entry, never mis-state one it did see.
 *
 * `scannedWholeFile: false` is the one signal a caller MUST check before
 * treating `entries`/`scannedEntries` as a total rather than a recent
 * slice — see `sameClass` just below for a caller whose contract is a
 * total (`count`) and therefore cannot use `entries` on its own once
 * this is false.
 */
export function tailEntries(root, type, { project = null, tailBytes = 512 * 1024 } = {}) {
  const p = logPath(root, type, project);
  let size;
  try { size = fs.statSync(p).size; } catch { return { entries: [], scannedWholeFile: true, scannedEntries: 0 }; }
  let raw;
  let whole;
  if (size <= tailBytes) {
    try { raw = fs.readFileSync(p, 'utf8'); whole = true; }
    catch { return { entries: [], scannedWholeFile: true, scannedEntries: 0 }; }
  } else {
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(tailBytes);
      fs.readSync(fd, buf, 0, tailBytes, size - tailBytes);
      const text = buf.toString('utf8');
      // The first line of a mid-file read is almost always cut in half —
      // drop it, never parse it. Safe because it is the OLDEST line in
      // the window, and a bounded reader only ever needs to protect the
      // newest end.
      const cut = text.indexOf('\n');
      raw = cut >= 0 ? text.slice(cut + 1) : '';
      whole = false;
    } catch {
      return { entries: [], scannedWholeFile: true, scannedEntries: 0 };
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch { entries.push({ __broken: true, raw: line }); }
  }
  return { entries, scannedWholeFile: whole, scannedEntries: entries.length };
}

export function sameClass(root, className, { except = null, max = 3 } = {}) {
  const wanted = String(className ?? '').trim();
  if (!wanted) return { className: wanted, count: 0, latest: [] };
  const hits = [];
  for (const project of [null, ...listProjects(root)]) {
    // Fast path: a bounded tail read (see `tailEntries`) — most drawers
    // sit well under the window (the same 512 KB `neighbours.mjs`
    // measured and justified), so this is usually the ONLY read done
    // for a project: no array holding every entry in the drawer, just
    // the ones near the end.
    //
    // `sameClass`'s contract is an EXACT `count`, though — not "recent
    // entries" — so the one thing it must never do is treat a partial
    // window as if it were the whole drawer. When `tailEntries` says it
    // did not see everything, this falls back to the exhaustive,
    // non-materialising iterator (`iterLog`) instead of trusting the
    // window: slower for a drawer that has actually grown past the
    // window, but never silently wrong. Dropping that check is exactly
    // the "silent partial answer" this house forbids — see
    // `test/p12-bounded-read.test.mjs`'s sabotage case, which forces
    // `scannedWholeFile` to lie and shows the count go wrong.
    const tail = tailEntries(root, 'error', { project });
    const entries = tail.scannedWholeFile ? tail.entries : iterLog(root, 'error', { project });
    for (const e of entries) {
      if (e?.class !== wanted) continue;
      if (except && e.id === except) continue;
      hits.push({ id: e.id, ts: e.ts ?? '', title: e.title ?? '', project });
    }
  }
  // Newest first: the last case is the one still likely to hold.
  hits.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { className: wanted, count: hits.length, latest: hits.slice(0, max) };
}

export function readLog(root, type, { project = null } = {}) {
  const p = logPath(root, type, project);
  if (!fs.existsSync(p)) return { path: p, missing: true, entries: [] };
  const raw = fs.readFileSync(p, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ __broken: true, raw: line });
    }
  }
  return { path: p, missing: false, entries };
}

/**
 * P12 · read a drawer WITHOUT materialising it.
 *
 * **Measured on 2026-09-20** (see `test/p12-ladder.test.mjs`), per byte
 * of drawer: parsing every line into an array of live objects (what
 * `readLog` does) costs roughly 2.6x the raw text in peak RSS and
 * dominates the wall-clock too — reading line-by-line into the SAME
 * array changes almost nothing, because the array of N objects is the
 * expensive part, not the read.
 *
 * **Chosen shape: an iterator, not a bounded window.** `neighbours.mjs`
 * already has the bounded-window shape (`readTail` + `scannedWholeFile`)
 * for the one caller that only wants the newest few and can safely miss
 * older ones (`tailEntries` below follows that exact shape for the one
 * caller here that fits it, `sameClass`). Every caller converted onto
 * THIS function is different: it wants ONE entry, by id, that could be
 * anywhere in the file — a byte window would either have to guess wrong
 * or read the whole file anyway, so a window buys nothing. What it does
 * NOT need is to hold every OTHER entry in memory while looking for that
 * one. A generator gives exactly that: the caller sees entries one at a
 * time and stops as soon as it has what it wants, so nothing after the
 * match is ever parsed, and nothing before it is retained once looked
 * at.
 *
 * **Also reads in bounded CHUNKS, not the whole file at once.** A first
 * version here called `fs.readFileSync` and scanned the one resulting
 * string lazily — which removes the array of N parsed objects, but for
 * a single drawer that has grown very large, that ONE string is itself
 * already close to the size of the problem this build exists to fix (a
 * drawer's raw bytes and its parsed size are the same order of
 * magnitude). `retiredMapFromFiles` (see `memory.mjs`'s own comment)
 * reads every drawer up to three times over, and three such strings
 * alive at once — even briefly, before a GC gets around to them —
 * measured WORSE than the one-array original at 100k rows
 * (`test/p11-ladder.test.mjs`'s first cut, kept as a comment there: this
 * is the actual dead end that made the chunked version necessary, not a
 * hypothetical). Reading in bounded chunks via `fs.readSync` keeps
 * memory bounded by `chunkBytes`, not by the file — regardless of how
 * many passes read it, and regardless of how large it has grown.
 * `node:string_decoder`'s `StringDecoder` is used rather than
 * `buf.toString('utf8')` per chunk because a multi-byte UTF-8 character
 * WILL sometimes straddle a chunk boundary in real drawers (this project
 * ships its own bidi/language handling; assuming ASCII would corrupt
 * exactly the entries most worth reading correctly) — `StringDecoder`
 * buffers an incomplete trailing sequence and completes it on the next
 * chunk instead of mangling it.
 *
 * There is still no byte-offset index to seek by (that would be the
 * "register" the build plan describes, and it is out of scope for what
 * this house asked for this round — see the report): every byte of the
 * file is still read and every line still parsed for a caller that scans
 * to the end. What is bounded is how much of it is EVER resident at
 * once. A caller that walks every entry anyway gets no benefit from
 * this over `readLog` besides that bound; it should still prefer
 * `readLog` when it truly wants everything materialised.
 */
export function* iterLogFile(absPath, { chunkBytes = 256 * 1024 } = {}) {
  let fd;
  try { fd = fs.openSync(absPath, 'r'); } catch { return; }
  try {
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(chunkBytes);
    let pending = '';
    for (;;) {
      let bytesRead;
      try { bytesRead = fs.readSync(fd, buf, 0, chunkBytes, null); }
      catch { break; }
      if (bytesRead === 0) break;
      pending += decoder.write(buf.subarray(0, bytesRead));
      let start = 0;
      let nl = pending.indexOf('\n', start);
      while (nl !== -1) {
        const line = pending.slice(start, nl);
        if (line.trim()) {
          try { yield JSON.parse(line); }
          catch { yield { __broken: true, raw: line }; }
        }
        start = nl + 1;
        nl = pending.indexOf('\n', start);
      }
      // Only the tail after the last newline carries forward — bounded
      // by the longest single LINE, never by how much of the file has
      // been read so far.
      pending = pending.slice(start);
    }
    pending += decoder.end();
    if (pending.trim()) {
      try { yield JSON.parse(pending); }
      catch { yield { __broken: true, raw: pending }; }
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/** {@link iterLogFile}, addressed the way every other reader is: by
 * (root, type, project) rather than an absolute path. */
export function iterLog(root, type, { project = null } = {}) {
  return iterLogFile(logPath(root, type, project));
}

/**
 * Search across many log files. Case-insensitive substring match.
 * Returns entries annotated with `_source` (relative path) and `_line`.
 *
 * **`capability`, required (P13, the deferred half; issue #136).**
 *
 * Until this change, "which drawers get read" was decided TWICE: once
 * here, by `projects === null ? [null, ...listProjects(root)] : projects`,
 * and once in `capability.mjs`'s lattice (`Capability#admits`), which
 * `retrieval.retrieve` and `search.search` already consult. The two
 * happened to agree — every caller that named a real project also read
 * `[null, project]`, matching what `capability.grantProject` would admit
 * — but nothing enforced that agreement, and it is exactly the kind of
 * thing that drifts silently: a caller changed here, or a new lattice
 * rule added there, and one lane sees more or less than the others with
 * no red test until someone measures it by hand. A rule written down
 * twice is a defect even while both copies still say the same thing.
 *
 * So: a capability now decides directly. `admits()` is asked once per
 * scope this memory actually has (`global` plus every real project),
 * and that IS the drawer list — nothing here re-derives "does a project
 * capability also see global" or spells out `[null, project]` by hand
 * any more. That question has exactly one answer in the codebase now,
 * and it lives in `capability.mjs`.
 *
 * **Required, not optional, and that is a deliberate choice, not the
 * default shape of a refactor.** An optional third parameter that
 * defaults to "everything" would be a silent hole exactly where the
 * guarantee is supposed to live: every call site written before this
 * change compiles and runs unchanged, quietly seeing every project
 * again, and the one thing this change was for — no caller can omit the
 * scope question — would be exactly as false as it was before. A
 * required parameter breaks every existing caller LOUDLY instead, at
 * the first call, which is the right failure mode for a boundary: it
 * forces every one of them to say, in its own file, whose reach this
 * read actually uses. See `retrieval.retrieve`, which took this shape
 * first — this function follows its convention rather than inventing a
 * second one.
 *
 * Failure is closed but shaped by WHY it failed, matching the two guard
 * clauses `retrieve` already uses:
 *   - not a `Capability` at all -> throws. This is not a caller that
 *     legitimately has no reach, it is a caller that forgot the
 *     argument or passed the wrong kind of value — a programming
 *     mistake, and `find` returns a bare array with no room to explain
 *     itself, so the loud failure has to happen here instead of coming
 *     back as a result that merely LOOKS like "found nothing".
 *   - a real `Capability` that does not carry `read` -> returns `[]`.
 *     This is a legitimate value (a write-only capability, say), not a
 *     mistake, and an empty read is the honest answer to it.
 *
 * `projects`, if given, NARROWS within what `capability` admits — "I may
 * see everything, show me only this one" — and can only ever shrink the
 * answer. A name in `projects` that the capability does not admit is
 * dropped from the request rather than honoured or used to widen
 * anything: the same rule `Capability#narrow` already applies to a
 * scope list, so a caller asking for a drawer it may not open gets
 * exactly what it would get asking for a drawer that does not exist —
 * nothing from it, never an error that leaks whether it exists, never a
 * silent grant of it either. See `test/p13-memory-find-capability.
 * test.mjs` for the probes (required capability, the read/write split,
 * the red/green scope check, and this narrowing/over-reach case), and
 * `test/p13-lattice-wiring.test.mjs` / `test/scope-lattice-redteam.
 * test.mjs` for the callers that mint the capabilities this function
 * now consumes.
 */
export function find(root, pattern, capability, {
  types = Object.keys(TYPES),
  projects = null,   // narrows WITHIN what `capability` admits; null = everything it admits
  since = null,
  withRetired = false,  // include retired (done/discarded/superseded)?
} = {}) {
  if (!(capability instanceof capabilityMod.Capability)) {
    throw new TypeError(
      "memory.find(root, pattern, capability, opts) — 'capability' is required and must be "
      + 'a capability.mjs Capability. There is no default: an omitted or optional capability '
      + 'that quietly meant "everything" is the exact second-spelling hole this parameter '
      + 'exists to close (see this function\'s doc comment). Pass capability.grantAll(subject) '
      + 'for a caller that legitimately has full reach, or capability.grantProject(name, '
      + '{ subject }) for one scoped to a single project.');
  }
  // Every scope this capability admits, computed against what the
  // memory actually has — `global` plus every real project directory.
  // This IS the drawer list now; nothing below re-derives it.
  const admitted = capability.has('read')
    ? [null, ...listProjects(root)]
      .filter((p) => capability.admits(capabilityMod.scopeOf({ project: p })))
    : [];
  const scopes = projects === null
    ? admitted
    : projects.filter((p) => admitted.includes(p));
  const needle = String(pattern).toLowerCase();

  // Pass 1: parse every line of the target logs. Only after that is it
  // known what is retired — a tombstone sits in the same log as its
  // target, but possibly further down.
  const raw = [];
  for (const project of scopes) {
    for (const type of types) {
      const p = logPath(root, type, project);
      if (!fs.existsSync(p)) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); }
        catch { entry = { __broken: true, raw: line }; }
        raw.push({ entry, p, line: i + 1, text: line });
      }
    }
  }
  const retired = retiredMap(raw.map((r) => r.entry));

  // Pass 2: filter and emit. Tombstone lines never surface as hits;
  // retired entries only with withRetired (then annotated _retired).
  const hits = [];
  const sinceTs = since ? (since instanceof Date ? since.toISOString() : String(since)) : null;
  for (const { entry, p, line, text } of raw) {
    if (isClosingLine(entry)) continue;
    if (needle && !text.toLowerCase().includes(needle)) continue;
    if (sinceTs && (!entry.ts || entry.ts < sinceTs)) continue;
    const info = entry.id ? retired.get(entry.id) : null;
    if (info && !withRetired) continue;
    hits.push({
      ...entry,
      _source: asSource(root, p),
      _line: line,
      ...(info ? { _retired: info } : {}),
    });
  }
  return hits;
}

export function listProjects(root) {
  const dir = path.join(root, 'projects');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    // A directory whose name logPath would reject must not be handed
    // back either — enumeration would otherwise feed an invalid name
    // straight into the function that refuses it, and every read across
    // all projects (context, core, search) would throw on one stray
    // directory rather than skip it.
    .filter((name) => { try { checkProjectName(name); return true; } catch { return false; } })
    .sort();
}

/**
 * Compact context dump for session start.
 * Recent errors, decisions, and events across global + all projects.
 */
/**
 * Current facts across global + every project, resolved for freshness.
 * Reads only the `timeline` log — facts meant to change — and folds each
 * `key` down to its current value, dropping retired versions. Pure over
 * the files it reads; no model, no network.
 *
 * **A fact is identified by SCOPE plus key (external audit, 2026-09-17).**
 * This function used to pour every project's timeline into one list and
 * hand it to `resolveFacts`, which groups by key alone. Two projects that
 * both record `db.engine` — the most ordinary thing a key can be — were
 * therefore folded into one fact: alpha's Postgres came back as the
 * HISTORY of beta's SQLite, so alpha appeared to have migrated. Nothing
 * was written and nothing was wrong in the files; the reader invented it.
 *
 * `resolveFacts` stays scope-blind on purpose — its job is to fold the
 * versions of ONE fact — and the scope is applied here, where projects
 * are known, by resolving each project on its own. Every result carries
 * its `project` (null = global) so a caller cannot lose the distinction
 * again by accident.
 */
export function currentFacts(root, { now = new Date(), staleDays = 120, project } = {}) {
  const bereiche = project === undefined
    ? [null, ...listProjects(root)]
    : [project === 'global' ? null : project];
  const out = [];
  for (const bereich of bereiche) {
    const entries = readLog(root, 'timeline', { project: bereich }).entries
      .filter((e) => !e.__broken);
    if (!entries.length) continue;
    for (const f of freshness.resolveFacts(entries, {
      now, staleDays, retired: retiredMap(entries),
    })) out.push({ ...f, project: bereich });
  }
  out.sort((a, b) => String(a.project ?? '').localeCompare(String(b.project ?? ''))
    || a.key.localeCompare(b.key));
  return out;
}

/**
 * Every entry in the memory, indexed by id — the substrate the link graph
 * is traversed against. Ids are unique across types, so one flat map is
 * enough. Closing lines are bookkeeping, not content, and stay out.
 */
export function entriesById(root) {
  const byId = new Map();
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      let res;
      try { res = readLog(root, type, { project }); } catch { continue; }
      // Retirement is per log file, so the map is built from the same
      // lines. Everything downstream of this — links, standing,
      // experiences, and through them `mem core` — inherits the answer,
      // which is why a retired learning used to keep showing up as
      // something the memory stands behind.
      const retired = retiredMap(res.entries);
      for (const e of res.entries) {
        if (!e.id || !holds(e, retired)) continue;
        if (!byId.has(e.id)) byId.set(e.id, { ...e, _type: type, _project: project });
      }
    }
  }
  return byId;
}

/**
 * The link graph around one entry: what points at it, and what it points
 * at. Both directions, because "why did this break" and "what did this
 * cause" are the same edge read from opposite ends.
 *
 * **Model-free.** The edges were written by the digest — the one place a
 * model runs — but walking them is pure code. That is the whole trade:
 * pay a model once, at sorting time, to earn a structure that costs
 * nothing to use forever after.
 *
 * A link whose `from`/`to` does not resolve is reported as `dangling`
 * rather than silently skipped: an edge into nothing is a real defect,
 * and hiding it would make the graph look healthier than it is.
 */
export function linksOf(root, id, { withRetired = false, byId: prebuilt = null } = {}) {
  // The caller may bring its own entry-overview. `question.all` calls
  // this function once PER QUESTION, and every call used to re-read the
  // whole memory — quadratic in the number of questions. The overview
  // depends only on the root, not on `id`, so it can be built once
  // outside. The default stays: build it yourself, so a caller does not
  // HAVE to get anything right.
  const byId = prebuilt ?? entriesById(root);
  const out = [];
  const incoming = [];
  const dangling = [];
  for (const project of [null, ...listProjects(root)]) {
    let res;
    try { res = readLog(root, 'link', { project }); } catch { continue; }
    // **A discarded edge is not an edge (external audit, 2026-09-17).**
    // A `resolves` link retired as `discarded` went on closing its
    // question: `question.all` walks these edges, and this loop skipped
    // broken and closing lines but never asked whether the edge itself
    // had been withdrawn. Retiring it looked like it worked — the entry
    // WAS marked — and changed nothing anyone could see.
    const withdrawn = retiredMap(res.entries);
    for (const l of res.entries) {
      if (l.__broken || isClosingLine(l)) continue;
      if (!withRetired && l.id && withdrawn.has(l.id)) continue;
      const from = l.from ?? l.source ?? null;
      const to = l.to ?? l.target ?? null;
      if (!from || !to) continue;
      if (from !== id && to !== id) continue;
      const other = from === id ? to : from;
      const rec = { link: l, kind: l.kind ?? '?', from, to, other, entry: byId.get(other) ?? null };
      if (!byId.has(from) || !byId.has(to)) dangling.push(rec);
      else if (from === id) out.push(rec);
      else incoming.push(rec);
    }
  }
  return { id, entry: byId.get(id) ?? null, out, incoming, dangling };
}

/**
 * How well each entry is BACKED by the rest of the memory.
 *
 * **What makes an experience real.** A conclusion drawn once is a guess.
 * It becomes experience when reality keeps re-confirming it — so strength
 * here is not a usage counter and not a model's opinion, it is simply
 * *how many other entries lean on this one*: entries that cite it in
 * `origin.derived_from`, and link edges that point at it.
 *
 * That choice matters. Counting how often something is *retrieved* would
 * reward popularity, not usefulness, and would need per-machine telemetry
 * that never travels with the repo. Citations are already in the corpus,
 * are written deliberately, and every clone computes the same number.
 *
 * `contested` is the falsifiability half: a `contradicts` edge pointing at
 * an entry does NOT delete or weaken it silently — it flags it, so the
 * claim keeps standing in the open, with its challenge attached. An
 * experience you cannot argue with is a dogma.
 */
export function standing(root) {
  const byId = entriesById(root);
  const rec = new Map();
  const of = (id) => {
    if (!rec.has(id)) rec.set(id, { id, cited: 0, contested: false, by: [] });
    return rec.get(id);
  };

  for (const [, e] of byId) {
    // Both spellings, via derivedFrom — previously `standing` only
    // counted `origin.derived_from`, and an origin written in the other
    // form gave the cited entry no weight at all.
    for (const src of derivedFrom(e)) {
      if (!byId.has(src)) continue;
      const r = of(src);
      r.cited += 1;
      r.by.push(e.id);
    }
  }

  for (const project of [null, ...listProjects(root)]) {
    let res;
    try { res = readLog(root, 'link', { project }); } catch { continue; }
    for (const l of res.entries) {
      if (l.__broken || isClosingLine(l)) continue;
      const to = l.to ?? l.target ?? null;
      const fromId = l.from ?? l.source ?? null;
      if (!to || !byId.has(to)) continue;
      const r = of(to);
      if (l.kind === 'contradicts') r.contested = true;
      else { r.cited += 1; if (fromId) r.by.push(fromId); }
    }
  }
  return rec;
}

/**
 * The experiences the memory is prepared to stand behind: learnings,
 * strongest first, each with what backs it and whether anything disputes
 * it. Deterministic — no model, no telemetry.
 */
export function experiences(root, { minCited = 0, type = 'learning' } = {}) {
  const back = standing(root);
  const out = [];
  for (const [, e] of entriesById(root)) {
    if (e._type !== type) continue;
    const r = back.get(e.id) ?? { cited: 0, contested: false, by: [] };
    if (r.cited < minCited) continue;
    out.push({ ...e, cited: r.cited, contested: r.contested, backedBy: r.by });
  }
  out.sort((a, b) => (b.cited - a.cited)
    || String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  return out;
}

// --- Flood grouping: a key that always exists, closeness instead of ---
// --- exact match -------------------------------------------------------
//
// `potentialConflicts` (src/retrieval.mjs) groups claims by `scope` +
// `topic` to flag a flood as contested. Measured against a corpus of
// learnings and errors — the two types a flood realistically arrives
// as, since an attacker picks the entry type and neither carries a
// `topic` unless someone sets one: with a topic field, 3 of 3 flood
// variants were flagged; without one, 0 of 3. The detector was present
// and inert for whole entry types.
//
// Two things had to change, and this section is deliberately kept
// separate from `potentialConflicts` rather than reworking it in place:
// this file cannot reach into src/retrieval.mjs, and the two also serve
// different questions. `potentialConflicts` asks "are these claims
// disputed" (needs overlapping validity, because a settled supersession
// is not a dispute). Flood grouping asks a narrower question — "do many
// near-identical entries exist at once" — and does not need validity
// windows to answer it.
//
//   1. A key that always exists. `topic` stays the key where an entry
//      carries one (unchanged from `potentialConflicts`); everything
//      else falls back to a signature built from the entry's own words,
//      so "no topic" no longer means "never grouped".
//
//   2. Closeness, not identity, for the fallback. Bucketing fallback-key
//      entries by the EXACT signature string is still exact-match
//      underneath — changing one word (a swapped synonym, an added
//      index) changes the signature and evades it, which is precisely
//      the case security-model.md's flood curve calls "stranger": a
//      flood of identical bodies is collapsed by `canonicalBody` before
//      this ever runs (confirmed below, and directly: 20 byte-identical
//      flood entries plus one truth entry come back from `mem retrieve`
//      as ONE flood claim, not 20), while a flood that varies survives
//      untouched and is exactly the shape this section exists to catch.

/**
 * A short English stopword list, deliberately duplicated from
 * `src/language.mjs` (`EN_STOP`) rather than imported from it.
 *
 * `test/entry-version.test.mjs` sandboxes `memory.mjs` by copying it plus
 * a hand-checked list of its dependencies into a temp directory; adding
 * an import here would have to be added there too, in a file outside
 * this change's scope, or every sandboxed test in it breaks on a
 * `Cannot find module` it has nothing to do with — confirmed by trying
 * the import first and watching exactly that happen. Flood text is
 * treated as English regardless of the memory's configured language,
 * because the fallback signature only needs "which words are common
 * enough to ignore", not a full per-language pipeline; keep this in
 * sync with `EN_STOP` by hand if that list ever changes.
 */
const FLOOD_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these',
  'not', 'no', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from',
  'by', 'as', 'if', 'so', 'than', 'then', 'too', 'very', 'just', 'only',
]);

/**
 * The scope a claim belongs to, for flood grouping purposes.
 *
 * Independent of `capability.scopeOf` in src/retrieval.mjs (out of reach
 * from here) — this only needs a stable partition so a flood in one
 * project cannot mask, or be masked by, one in another. A raw JSONL
 * entry (as written directly to a log, with no `scope`/`project` field)
 * falls back to `fallback`, which callers set to whatever they already
 * know the entries share.
 */
function floodScopeOf(entry, fallback = 'global') {
  const s = entry?.scope ?? entry?.project ?? entry?._project;
  return typeof s === 'string' && s.trim() ? s.trim() : fallback;
}

/**
 * The words a flood signature is built from: lowercased, split on
 * anything that is not a letter/digit/underscore/hyphen, hyphenated
 * forms contribute both the whole word and its parts (so
 * "ap-southeast-3" also offers "southeast"), stopworded and short
 * fragments dropped, and — the one deliberate departure from a plain
 * tokenizer — anything containing a digit is dropped outright.
 *
 * That last rule is doing real work. An attacker's easiest lever is a
 * counter: a suffixed id, a port, a date. Keeping digit-bearing tokens
 * in the signature would make every copy look distinct for free; a
 * flood built by incrementing a number is the case this rule exists
 * for, and it costs nothing against a claim that genuinely differs.
 */
function floodWords(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .flatMap((w) => (w.includes('-') ? [w, ...w.split('-')] : [w]))
    .filter((w) => w.length >= 3 && !FLOOD_STOPWORDS.has(w) && !/\d/.test(w));
  return [...new Set(words)].sort();
}

/**
 * The normalised short form of one entry: its title and text reduced to
 * a sorted, deduplicated word signature. Always defined — an entry with
 * no words left after filtering signs with the literal `(empty)`, which
 * is still a valid, always-present key rather than an empty string that
 * would silently coincide with every other contentless entry across
 * every scope.
 */
/**
 * The text a flood signature is taken from, in ONE place.
 *
 * A stored entry carries `title` and `text`; a claim handed back by
 * `retrieval.retrieve()` carries neither — it has already folded both
 * into `body`. Measured 2026-09-20, the day this detector was wired
 * into the live retrieve path: reading only `title`/`text` gave EVERY
 * claim an empty signature, so all eight claims — the genuine user
 * claim among them — landed in one `(empty)` group. A detector that
 * flags everything is a latch that reports the innocent, and those get
 * switched off.
 *
 * Both shapes are read here rather than at the call site, so the
 * detector cannot disagree with itself depending on who called it.
 */
function floodTextOf(entry) {
  return [entry?.title, entry?.text, entry?.body].filter(Boolean).join(' ');
}

export function floodShortForm(entry) {
  const words = floodWords(floodTextOf(entry));
  return words.length ? words.join(',') : '(empty)';
}

/**
 * The grouping key that always exists: `topic` where an entry carries
 * one (matching `potentialConflicts`), the normalised short form plus
 * scope otherwise. Exported as the single source of truth for "what
 * bucket is this entry in" — `floodGroups` below uses the same words
 * `floodShortForm` reports, so the key a caller can print and the key
 * the detector actually groups by never drift apart.
 */
export function floodGroupKey(entry, { scope: fallbackScope = 'global' } = {}) {
  const scope = floodScopeOf(entry, fallbackScope);
  const topic = typeof entry?.topic === 'string' ? entry.topic.trim().toLowerCase() : '';
  return topic
    ? `${scope}\u0000topic\u0000${topic}`
    : `${scope}\u0000shape\u0000${floodShortForm(entry)}`;
}

/**
 * Union-find over array indices. Nothing fancier is needed: every
 * caller here does one pass of unions followed by one pass of reads.
 */
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  return { find, union };
}

/**
 * Every claim in one connected shape-cluster shares a "leave one word
 * out" key with at least one other member of the cluster.
 *
 * This is the closeness step, and it is deliberately not a similarity
 * SCORE with a threshold to calibrate (the docs reject exactly that for
 * `enforceAuthorShare`, for having "no calibratable threshold"). Instead:
 * for a signature of k words, generate k+1 keys — the full signature and
 * one for each word removed. Two entries that differ by exactly one word
 * share the key produced by removing THAT word from each, so they land
 * in the same bucket without either ever being compared to a fixed
 * closeness cutoff. Entries differing by two or more words share no key
 * and are never joined by this step alone — which is exactly the
 * boundary the innocence probe in test/flood-grouping.test.mjs is built
 * to sit right on top of.
 *
 * Bounded on purpose: only entries with at most `maxWords` significant
 * words generate leave-one-out keys at all (12 is generous for a claim's
 * title+text signature), so this stays linear in the corpus size and
 * never quadratic in a claim's own length.
 */
function looClusters(entries, maxWords = 12) {
  const uf = makeUnionFind(entries.length);
  const byKey = new Map();
  entries.forEach((e, i) => {
    const words = e._floodWords;
    // No words is not a shape, it is the absence of one. Clustering on
    // the empty key would union every contentless entry with every
    // other — grouping by what they do not have. They stay singletons
    // and fall out below on the group-size floor.
    if (words.length === 0) return;
    const keys = [words.join(',')];
    if (words.length >= 2 && words.length <= maxWords) {
      for (let skip = 0; skip < words.length; skip += 1) {
        keys.push(words.filter((_, j) => j !== skip).join(','));
      }
    }
    for (const k of keys) {
      const bucket = byKey.get(k);
      if (bucket !== undefined) uf.union(bucket, i);
      else byKey.set(k, i);
    }
  });
  const clusters = new Map();
  entries.forEach((_, i) => {
    const r = uf.find(i);
    const list = clusters.get(r) ?? [];
    list.push(i);
    clusters.set(r, list);
  });
  return [...clusters.values()];
}

/**
 * Flood groups across a set of claims: entries that land on the same
 * always-present key (`floodGroupKey`), joined by closeness rather than
 * exact text where no `topic` exists, and written by enough distinct
 * authors that a coincidence is unlikely.
 *
 * Deliberately narrower than `potentialConflicts`: no validity-overlap
 * check, because a flood is a quantity-and-similarity question, not a
 * disputed-fact question — the same subject revisited by ONE author over
 * months (a correction, a supersession) already falls out on author
 * count alone, whatever its content looks like.
 *
 * Every group reports its own denominator: `matched` is the cluster
 * size, `of` is how many claims shared that claim's scope in the input
 * — "3 grouped" means nothing without knowing whether that was 3 of 3
 * or 3 of 3000.
 */
export function floodGroups(claims, { scope: fallbackScope = 'global', minAuthors = 2 } = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const byScope = new Map();
  for (const c of list) {
    const scope = floodScopeOf(c, fallbackScope);
    const bucket = byScope.get(scope) ?? [];
    bucket.push(c);
    byScope.set(scope, bucket);
  }

  const out = [];
  for (const [scope, scoped] of byScope) {
    const of = scoped.length;

    // Entries WITH a topic: unchanged from `potentialConflicts` — exact
    // (case-folded) topic match is the key, because that guarantee
    // already held (3 of 3 flagged) and nothing here should weaken it.
    const withTopic = new Map();
    const noTopic = [];
    for (const c of scoped) {
      const topic = typeof c?.topic === 'string' ? c.topic.trim().toLowerCase() : '';
      if (topic) { const g = withTopic.get(topic) ?? []; g.push(c); withTopic.set(topic, g); } else {
        noTopic.push({ ...c, _floodWords: floodWords(floodTextOf(c)) });
      }
    }

    const candidateGroups = [];
    for (const [topic, g] of withTopic) candidateGroups.push({ topic, members: g });
    for (const idxs of looClusters(noTopic)) {
      if (idxs.length < 2) continue;
      candidateGroups.push({ topic: null, members: idxs.map((i) => noTopic[i]) });
    }

    for (const { topic, members } of candidateGroups) {
      if (members.length < 2) continue;
      const authors = [...new Set(members.map((m) => m.author ?? '(none)'))].sort();
      if (authors.length < minAuthors) continue;
      out.push({
        scope,
        topic,
        key: topic ? `topic:${topic}` : `shape:${floodShortForm(members[0])}`,
        authors,
        ids: members.map((m) => m.id).filter(Boolean).sort(),
        matched: members.length,
        of,
      });
    }
  }
  return out;
}

/**
 * Every entry that belongs to a topic, across all types and projects.
 *
 * **Why topics exist.** `timeline` already folds a changing FACT onto its
 * current value via `key`. But most knowledge is not a fact with a value —
 * it is a subject that keeps developing: `architecture/auth-model` gathers
 * a decision, later an error against it, later a learning. Without a
 * handle for that, the only way to see "where does X stand now" is to
 * search and read everything. A `topic` is that handle: entries of ANY
 * type that share one, read newest-first, are the thread of a subject.
 *
 * Append-only stays intact — nothing is updated in place. The newest entry
 * is simply the current state, the rest is how it got there. Retired
 * (done/discarded/superseded) entries and closing lines drop out.
 *
 * Pure over the logs: no model, no network, no write.
 */
export function topicEntries(root, key = null) {
  const alias = topicAliases(root);
  const all = [];
  const seen = [];
  let seq = 0;
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      let res;
      try { res = readLog(root, type, { project }); } catch { continue; }
      for (let i = 0; i < res.entries.length; i += 1) {
        const e = res.entries[i];
        seen.push(e);
        seq += 1;
        if (e.__broken || isClosingLine(e)) continue;
        const raw = typeof e.topic === 'string' ? e.topic.trim() : '';
        if (!raw) continue;
        // Merged topics resolve on READ. The line on disk stays exactly
        // as it was written.
        const t = alias.get(raw) ?? raw;
        if (key !== null && t !== key) continue;
        all.push({ ...e, _type: type, _project: project, _topic: t, _topic_raw: raw, _seq: seq });
      }
    }
  }
  const retired = retiredMap(seen);
  const live = all.filter((e) => holds(e, retired));
  // Timestamps are second-resolution, so three entries logged in one second
  // tie — and "what is the current state of this topic" must not then be
  // decided at random. `_seq` is the read order, which inside one log file
  // IS the write order. Across files within the same second it is merely
  // stable, not chronological; sub-second timestamps would be the real fix.
  live.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')) || (b._seq - a._seq));
  return live;
}

/** All topics with how big and how fresh they are, busiest first. */
export function topics(root) {
  const byKey = new Map();
  for (const e of topicEntries(root)) {
    if (!byKey.has(e._topic)) {
      byKey.set(e._topic, {
        topic: e._topic, count: 0, last: '', types: new Set(), projects: new Map(),
      });
    }
    const t = byKey.get(e._topic);
    t.count += 1;
    t.types.add(e._type);
    // The project of an entry IS the topic's area — not a prefix somebody
    // has to type into the name. See topicTree(): this is what the
    // grouping hangs off.
    const pj = e._project ?? '(global)';
    t.projects.set(pj, (t.projects.get(pj) ?? 0) + 1);
    if (String(e.ts ?? '') > t.last) t.last = String(e.ts ?? '');
  }
  return [...byKey.values()]
    .map((t) => ({
      ...t,
      types: [...t.types].sort(),
      // The area is whichever project contributes most of the topic's
      // entries. A topic that spans projects belongs where its centre of
      // gravity is, and `projects` stays beside it so you can see the rest.
      area: [...t.projects.entries()].sort((a, b) => b[1] - a[1])[0][0],
      projects: Object.fromEntries(t.projects),
    }))
    .sort((a, b) => (b.last.localeCompare(a.last)) || (b.count - a.count));
}

/** One topic folded to its current state plus the trail that led there. */
export function topicState(root, key) {
  const entries = topicEntries(root, key);
  return {
    topic: key,
    current: entries[0] ?? null,
    history: entries.slice(1),
    count: entries.length,
  };
}

/**
 * The always-load core — cheap-mem's answer to "bake context into the
 * model" (Engram), minus the training. Instead of retraining weights or
 * re-retrieving every turn, it distills the *settled* facts worth carrying
 * in EVERY session into a small, bounded block you load once at the top.
 *
 * A fact belongs in the core when it is current, not stale, and not in
 * conflict — a truth that has stopped moving. The block is bounded (`max`)
 * so it stays cheap enough to always load; when more stable facts exist
 * than the budget, the *freshest* survive and the rest are counted, never
 * silently dropped.
 *
 * Pure over the `timeline` log: no model, no network, no write. Same
 * contract as search and facts.
 */
export function coreFacts(root, { now = new Date(), staleDays = 120, max = 40 } = {}) {
  const stable = currentFacts(root, { now, staleDays })
    // `current` may be null now: a key whose every version starts in the
    // future, or has run out, holds nothing today. It is not a stable
    // fact, and printing the future value here would be exactly the
    // defect the audit found.
    .filter((f) => f.current && !f.stale && !f.conflict);
  const when = (f) => Date.parse(f.current.valid_from ?? f.current.ts ?? 0) || 0;
  // Rank by recency so the budget keeps the freshest truths ...
  const byFresh = [...stable].sort((a, b) => when(b) - when(a));
  const kept = byFresh.slice(0, Math.max(0, max));
  // ... but present in key order, so the block reads like a settled table.
  kept.sort((a, b) => a.key.localeCompare(b.key));
  return { kept, omitted: Math.max(0, stable.length - kept.length), total: stable.length };
}

export function core(root, {
  now = new Date(), staleDays = 120, max = 40, maxExperiences = 8,
} = {}) {
  const { kept, omitted } = coreFacts(root, { now, staleDays, max });
  const out = [];
  out.push('=== cheap-mem core (stable facts, always-load) ===');
  out.push('# Current, non-stale, non-conflicting timeline facts. Deterministic, no model.');
  out.push('');
  if (kept.length === 0) {
    out.push('(no stable facts yet — log some with '
      + '`mem log timeline --key ... --value ... --valid_from ...`)');
  } else {
    for (const f of kept) out.push(freshness.formatFact(f));
  }
  if (omitted > 0) {
    out.push('');
    out.push(`(${omitted} more stable fact${omitted === 1 ? '' : 's'} beyond the budget `
      + `of ${max}; raise --max to include them)`);
  }

  // Backed experience rides the same rail as the facts: a lesson the rest
  // of the memory keeps leaning on belongs in EVERY session, not only in
  // the one that happens to search for it. Only cited ones — an uncited
  // learning is still just a claim — and a contested one says so rather
  // than quietly passing as settled.
  if (maxExperiences > 0) {
    const exp = experiences(root, { minCited: 1 }).slice(0, maxExperiences);
    if (exp.length) {
      out.push('');
      out.push('--- experience (backed by the rest of the memory) ---');
      for (const e of exp) {
        const mark = e.contested ? '  [CONTESTED]' : '';
        out.push(`${e.title ?? e.text ?? e.id}  (backed x${e.cited})${mark}`);
      }
    }
  }
  return out.join('\n');
}

/**
 * How a character budget is turned into a token number, and why it is
 * only ever an ESTIMATE here.
 *
 * Counting tokens needs the tokenizer of the model that will read the
 * block, and cheap-mem does not carry one — no heavy dependency, no
 * network, deterministic on every clone. Four characters per token is
 * the usual rule of thumb for English prose and it is WRONG for ids,
 * paths and timestamps, which is most of what a context block is made
 * of.
 *
 * So the budget is measured in CHARACTERS, which is exact, and the
 * token figure is printed next to it, labelled as an estimate. A budget
 * that calls itself tokens while secretly counting characters would be
 * the same lie in nicer clothes.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * The smallest budget that can still keep its own promise.
 *
 * **Derived, not guessed.** The first version of this floor was the
 * round number 200, and it was wrong: at `--budget 250` the header and
 * the footer alone came to 265 characters, and the guarantee check at
 * the end of `context()` threw — correctly, but a caller should never
 * get that far. A limit written by hand ages badly; the moment someone
 * adds a line to the header it is a lie again.
 *
 * So it is computed from the two pieces that are always present, with
 * the footer taken at its longest (the "cut to fit" wording, longer than
 * "everything fitted"), plus a little air.
 */
export const MIN_CONTEXT_CHARS = (() => {
  const head = '=== cheap-mem context ===\n\nFacts snapshot: see FACTS.md and '
    + 'global/facts.yaml\nPeople:         see global/people.yaml\n\n';
  const foot = '--- budget 999999 chars (~249999 tokens, estimated at 4 chars/token) ---\n'
    + '  cut to fit: 99 errors, 99 decisions, 99 events, 99 facts, 99 projects not shown. '
    + 'Raise --budget or narrow with --n.';
  return head.length + foot.length;
})();

/** The order sections give way in when the budget runs out. */
const CONTEXT_SECTIONS = Object.freeze(['errors', 'decisions', 'events', 'facts', 'projects']);

/**
 * A compact digest of this memory, for pasting at the start of a session.
 *
 * **`maxChars` is the point of this function, not a decoration.** Until
 * 2026-09-17 the only dial was `--n`, a COUNT of entries — and a context
 * block is not paid for by the entry, it is paid for by the character.
 * Twenty short events and twenty pasted stack traces are the same `n`
 * and differ by an order of magnitude in what they cost the model that
 * reads them. So the caller with a real limit could not express it, and
 * had to guess an `n` and hope.
 *
 * When the budget bites, three things must hold, and each one is a
 * probe:
 *
 *  1. The result never exceeds `maxChars`. A budget that is "mostly"
 *     kept is not a budget.
 *  2. Nothing is cut mid-entry. A half-written error line reads as a
 *     fact about the error, not as a truncation.
 *  3. The block SAYS what did not fit, per section. A silently shortened
 *     digest is indistinguishable from a quiet memory, and that is the
 *     one reading it must never make.
 *
 * Sections give way in the order of `CONTEXT_SECTIONS`, last first:
 * projects and facts are cheap to look up elsewhere, the recent errors
 * are why anyone pastes this block at all.
 */
export function context(root, { n = 20, maxChars = null } = {}) {
  const half = Math.max(1, Math.floor(n / 2));

  const head = [
    '=== cheap-mem context ===',
    '',
    'Facts snapshot: see FACTS.md and global/facts.yaml',
    'People:         see global/people.yaml',
    '',
  ];

  // Every section is built as a list of ITEMS, each item a block of lines
  // that belong together. The budget is then spent on whole items — which
  // is what keeps rule 2 above true by construction rather than by a
  // length check somewhere downstream.
  const entryLines = (e) => {
    const lines = [`  [${e.ts}] ${e._source}:${e._line}`];
    const short = shortText(e);
    if (short) lines.push(`    ${short}`);
    return lines;
  };

  const errors = recentEntries(root, 'error', n);
  const decisions = recentEntries(root, 'decision', half);
  const events = recentEntries(root, 'event', half);
  const facts = currentFacts(root);
  const projects = listProjects(root);

  const sections = {
    errors: { heading: (k) => `--- last ${k} errors ---`, empty: '  (none)',
      items: errors.map(entryLines) },
    decisions: { heading: (k) => `--- last ${k} decisions ---`, empty: '  (none)',
      items: decisions.map(entryLines) },
    events: { heading: (k) => `--- last ${k} events ---`, empty: '  (none)',
      items: events.map(entryLines) },
    facts: { heading: (k) => `--- current facts (${k}) ---`, empty: null,
      items: facts.slice(0, n).map((f) => ['  ' + freshness.formatFact(f)]) },
    projects: { heading: (k) => `--- projects (${k}) ---`, empty: '  (none)',
      items: projects.map((p) => [`  ${p}`]) },
  };

  // No budget: the shape this function has always had, unchanged.
  if (!Number.isFinite(maxChars)) {
    const out = [...head];
    for (const name of CONTEXT_SECTIONS) {
      const s = sections[name];
      if (name === 'facts' && !s.items.length) continue;
      out.push(s.heading(s.items.length));
      if (!s.items.length && s.empty) out.push(s.empty);
      for (const item of s.items) out.push(...item);
      if (name !== 'projects') out.push('');
    }
    return out.join('\n');
  }

  // With a budget. Reserve room for the head and for the footer that
  // reports the cut — a footer that itself did not fit would put the
  // block silently over budget, which is the failure this whole branch
  // exists to prevent.
  const lineBytes = (lines) => lines.reduce((sum, l) => sum + l.length + 1, 0);
  const FOOTER_RESERVE = 160;
  let left = maxChars - lineBytes(head) - FOOTER_RESERVE;

  const taken = {};
  const dropped = {};
  const reportedEmpty = {};
  for (const name of CONTEXT_SECTIONS) {
    const s = sections[name];
    taken[name] = [];
    dropped[name] = 0;
    // **An EMPTY section still gets its "(none)".** Three states again:
    // "measured, nothing there" is not the same as "cut for space", and
    // without the line the reader cannot tell them apart — the footer
    // only names what WAS cut, so a missing heading would be ambiguous.
    // It costs two lines and it is the whole point of the footer.
    if (!s.items.length) {
      if (!s.empty) continue;
      const cost = s.heading(0).length + 1 + s.empty.length + 2;
      if (cost <= left) { left -= cost; reportedEmpty[name] = true; }
      continue;
    }
    // The heading is part of the cost. A section that can only afford its
    // own title contributes nothing and is dropped whole.
    const headingCost = s.heading(s.items.length).length + 2;
    if (left - headingCost <= 0) { dropped[name] = s.items.length; continue; }
    left -= headingCost;
    for (const item of s.items) {
      const cost = lineBytes(item);
      if (cost > left) { dropped[name] += 1; continue; }
      left -= cost;
      taken[name].push(item);
    }
    if (!taken[name].length) { left += headingCost; dropped[name] = s.items.length; }
  }

  const out = [...head];
  for (const name of CONTEXT_SECTIONS) {
    const s = sections[name];
    if (reportedEmpty[name]) { out.push(s.heading(0), s.empty, ''); continue; }
    if (!taken[name].length) continue;
    out.push(s.heading(taken[name].length));
    for (const item of taken[name]) out.push(...item);
    out.push('');
  }

  // The footer. Not decoration: without it a shortened block and a quiet
  // memory look the same, and the reader cannot tell which one they hold.
  const missing = CONTEXT_SECTIONS
    .filter((name) => dropped[name] > 0)
    .map((name) => `${dropped[name]} ${name}`);
  const usedBeforeFooter = lineBytes(out);
  out.push(`--- budget ${maxChars} chars (~${Math.floor(maxChars / CHARS_PER_TOKEN)} tokens, `
    + `estimated at ${CHARS_PER_TOKEN} chars/token) ---`);
  out.push(missing.length
    ? `  cut to fit: ${missing.join(', ')} not shown. Raise --budget or narrow with --n.`
    : '  everything fitted.');
  const text = out.join('\n');

  // The guarantee, checked where it is made. If this ever throws, the
  // accounting above is wrong — and a wrong budget must fail loudly
  // rather than hand back an oversized block that nobody measures.
  if (text.length > maxChars) {
    throw new Error(`context: budget accounting is wrong — ${text.length} chars for a `
      + `budget of ${maxChars} (used ${usedBeforeFooter} before the footer). This is a bug `
      + 'in context(), not something the caller did.');
  }
  return text;
}

export function recentEntries(root, type, n) {
  const all = [];
  for (const project of [null, ...listProjects(root)]) {
    const p = logPath(root, type, project);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); }
      catch { e = { __broken: true, raw: line, ts: '0' }; }
      all.push({ ...e, _source: asSource(root, p), _line: i + 1 });
    }
  }

  // Retired entries and their tombstones are BOTH dropped here, and that
  // is not tidiness. This feeds `mem context` and `mem core`, which the
  // SessionStart hook prints into every session — so without it, advice
  // the user explicitly discarded keeps being loaded as current, while
  // `mem find` correctly hides it. Two answers from one memory about the
  // same entry is worse than either answer alone.
  //
  // The tombstone has to go too: it carries only `why`, so it rendered
  // as an entry of its own ("because vendor X shut down") with no hint
  // that it is a retraction of the line above it.
  const retired = retiredMap(all);
  const live = all.filter((e) => holds(e, retired));

  live.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  return live.slice(0, n);
}

/**
 * The one line `context()` shows per entry — and therefore what a
 * SessionStart hook (`mem context`, see install/hooks/session-start.sh)
 * hands straight into a fresh agent's context. Passed through
 * `bidi.visible()` for exactly that reason: this is text an agent reads
 * automatically, before it has decided to trust anything in this
 * memory, so a Trojan-Source reorder landing here is the worst place it
 * could land.
 */
function shortText(e) {
  const parts = [];
  if (e.title) parts.push(e.title);
  if (e.topic) parts.push(`[${e.topic}]`);
  if (e.class) parts.push(`[${e.class}]`);
  if (e.text) parts.push(e.text.slice(0, 120).replace(/\s+/g, ' '));
  if (e.choice) parts.push(`→ ${e.choice}`);
  if (e.why) parts.push(`because ${e.why.slice(0, 80)}`);
  if (e.tags && Array.isArray(e.tags) && e.tags.length) parts.push(`#${e.tags.join(' #')}`);
  return bidi.visible(parts.join(' — '));
}

/**
 * Create a project directory idempotently.
 * Missing files get written, existing files stay untouched.
 */
export function projectInit(root, name, { title = null } = {}) {
  checkProjectName(name);
  const dir = path.join(root, 'projects', name);
  const created = [];
  const existed = [];

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    created.push('.');
  } else {
    existed.push('.');
  }

  const files = [
    ['README.md', defaultReadme(name, title)],
    ['facts.yaml', `# stable facts about ${name}\nname: ${name}\n${title ? `title: ${JSON.stringify(title)}\n` : ''}`],
    ['sources.yaml', '# pointers to external files\nrepos: []\ndrives: []\n'],
    ['decisions.jsonl', ''],
    ['errors.jsonl', ''],
    ['events.jsonl', ''],
  ];

  for (const [name2, content] of files) {
    const p = path.join(dir, name2);
    if (fs.existsSync(p)) {
      existed.push(name2);
    } else {
      fs.writeFileSync(p, content, 'utf8');
      created.push(name2);
    }
  }

  return { dir, created, existed };
}

function defaultReadme(name, title) {
  const t = title ?? name;
  return `# Project: ${t}

- **key**: \`${name}\`
- **purpose**: TBD (fill in during first substantive session)
- **repos / sources**: see \`sources.yaml\`

Log entries land in the three JSONL files here.
`;
}

/**
 * Write a correction entry that supersedes an earlier one.
 *
 * Backwards-editing is forbidden: the wrong line stays visible; the
 * correction is a NEW line with `replaces_id: <old-id>`.
 */
export function correctionEntry(root, type, oldId, newData, { project = null } = {}) {
  if (typeof oldId !== 'string' || !oldId) {
    throw new Error('Correction needs an old id');
  }
  // P12: wants ONE entry by id, not the whole drawer — `iterLog` stops
  // parsing the moment it is found instead of materialising every other
  // entry first. See the comment on `iterLogFile` for why this, and not
  // a bounded window, is the right shape for an id lookup.
  let old = null;
  for (const e of iterLog(root, type, { project })) {
    if (e.id === oldId) { old = e; break; }
  }
  if (!old) {
    throw new Error(
      `Old id '${oldId}' not found in ${type}${project ? ` (project ${project})` : ''}. Correction without original is not allowed.`);
  }
  return logEntry(root, type, { ...newData, replaces_id: oldId }, { project });
}


/**
 * Fold the duty log into "still open" and "closed".
 *
 * A line with `closes_id` closes the duty with that id. The original
 * line stays exactly where it is — this function is a view, not a
 * mutation. It is the only folded view in the whole memory, and it
 * exists because an unfolded duty list is useless: nobody can read
 * fifty lines to work out which three things they still owe.
 */
export function openDuties(root, { project = undefined } = {}) {
  const targets = project === undefined
    ? [null, ...listProjects(root)]
    : [project === 'global' ? null : project];

  const all = new Map();      // id -> entry
  const closed = new Map();   // id -> {state, by, ts}

  for (const p of targets) {
    const file = logPath(root, 'duty', p);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.closes_id) {
        closed.set(e.closes_id, {
          state: e.state ?? DUTY_STATE.DONE,
          by: e.id,
          ts: e.ts,
          why: e.why ?? e.text ?? null,
        });
        continue;
      }
      if (!e.id) continue;
      all.set(e.id, {
        ...e,
        _source: asSource(root, file),
        _line: i + 1,
        _project: p,
      });
    }
  }

  const open = [];
  const done = [];
  for (const [id, e] of all) {
    const shut = closed.get(id);
    if (shut) done.push({ ...e, _closed: shut });
    else open.push(e);
  }
  open.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  done.sort((a, b) => (b._closed.ts ?? '').localeCompare(a._closed.ts ?? ''));
  return { open, done };
}

/**
 * Close a duty. Appends a line; never touches the original.
 * Refuses if the id does not exist — closing a duty that was never
 * opened means someone mistyped, and a memory that accepts that is
 * quietly wrong.
 */
export function closeDuty(root, id, { state = DUTY_STATE.DONE, why = null, project = null } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('closeDuty needs an id');
  if (!Object.values(DUTY_STATE).includes(state)) {
    throw new Error(`Unknown duty state '${state}'. Known: ${Object.values(DUTY_STATE).join(', ')}`);
  }
  const { open } = openDuties(root, { project: project ?? undefined });
  if (!open.some((d) => d.id === id)) {
    throw new Error(`No open duty with id '${id}'.`);
  }
  return logEntry(root, 'duty', { closes_id: id, state, why }, { project });
}

// --- Lifecycle: discarded / done / superseded ----------------------
//
// A memory that shows the user stale material in everyday recall loses
// its trust. A discarded thought or a finished task must stop surfacing
// as if it were still live — but append-only means never delete, never
// rewrite. So: append a "tombstone" line pointing at the id. The
// original stays put (the viewer still shows it, marked); recall hides
// it from here on.
//
// Three sources of a retirement, all append-only, all in the SAME log
// as their target:
//   - retires_id  : the general tombstone (mem discard / mem done)
//   - closes_id   : closing a duty (already existed)
//   - replaces_id : a correction supersedes the original (already existed)

/**
 * Build the map of retired ids from parsed entries:
 * id -> { state, why, by, ts }. Pure, no I/O, so the BM25 index
 * (search.mjs), memory.find and the viewer share one truth.
 */
/**
 * One entry's effect on a retirement map already under construction.
 *
 * Factored out of `retiredMap` for P11 (see `retiredMapFromFiles` below):
 * this is the ONE place the retirement rule is written, and both the
 * array-based reader and the streaming one call it, so a memory-shaped
 * change to how `deriveState` reads its input can never quietly drift
 * from what `retiredMap` decides for the exact same data. `byId` may
 * hold FULL entries (as `retiredMap` builds it) or the slim
 * {@link authorityProjection} (as `retiredMapFromFiles` builds it) —
 * this function only ever reads `byId.get(...)` and hands the result to
 * `authority.maySupersede`, which only reads the five projected fields,
 * so both inputs are correct.
 */
function applyRetirement(map, byId, e) {
  if (!e) return;
  if (e.retires_id) {
    map.set(e.retires_id, {
      state: e.state ?? DUTY_STATE.DONE,
      why: e.why ?? e.text ?? null, by: e.id ?? null, ts: e.ts ?? null,
    });
  }
  if (e.closes_id) {
    map.set(e.closes_id, {
      state: e.state ?? DUTY_STATE.DONE,
      why: e.why ?? e.text ?? null, by: e.id ?? null, ts: e.ts ?? null,
    });
  }
  if (e.replaces_id) {
    const target = byId.get(e.replaces_id);

    // Target not in this set: a drawer read in isolation cannot see a
    // correction that lives elsewhere. Allowing it preserves the
    // behaviour every caller had before the rule existed; the GLOBAL
    // check, where every entry is visible, is `mem doctor` (integrity).
    // Refusing here would break legitimate cross-drawer corrections to
    // catch an attacker who can simply write in the same drawer anyway.
    const verdict = target
      ? authority.maySupersede(e, target)
      : { ok: true, reason: 'target not in this view — checked globally by doctor' };

    if (verdict.ok) {
      map.set(e.replaces_id, {
        state: 'superseded', why: null, by: e.id ?? null, ts: e.ts ?? null,
        // `supersededAt` — the moment the OLD claim stopped being true,
        // DERIVED, never stored twice. This is the fix for a defect
        // named in the 2026-09-17 review: `valid_until` and
        // supersession both answer "when did this stop being true",
        // and until this field existed they answered it independently
        // — so `--as-of` a date BEFORE a correction was written still
        // excluded the corrected claim outright (measured: a decision
        // logged 2026-01-01 and corrected later came back empty for
        // `--as-of 2026-03-01`, a moment at which only the correction
        // existed in the future). `retrieval.validAt` is the one place
        // that reads this field; nowhere else computes it from raw
        // fields again.
        //
        // Preferring the successor's `valid_from` over its `ts` is the
        // same choice `freshness.mjs` already makes for "when did this
        // version start holding" — a human-stated moment beats the
        // moment the correction happened to be typed. Falling back to
        // `ts` covers the common case where nobody bothered to state
        // one explicitly; the predecessor is then still considered
        // true right up until the correction was recorded, which is
        // the least surprising reading of "there was no stated date".
        supersededAt: e.valid_from ?? e.ts ?? null,
      });
    } else if (e.id) {
      // Append-only: the attempt is NOT rejected and NOT removed. The
      // target simply stays active, and the attempting claim is marked
      // disputed — which keeps it out of retrieval while leaving it
      // fully readable in the log, in `doctor`, and in the viewer.
      //
      // That asymmetry is the defence against flooding: writing
      // disputed claims costs the attacker writes and the defender
      // bytes, and buys no influence over any assembled context.
      map.set(e.id, {
        state: 'disputed', why: verdict.reason,
        by: e.replaces_id, ts: e.ts ?? null,
      });
    }
  }
}

export function retiredMap(entries) {
  const map = new Map();

  // A supersession has to be checked against the claim it supersedes, so
  // the log is indexed first. Two passes, because a correction may appear
  // before its target in file order — merge=union makes no promise about
  // which side lands first.
  const byId = new Map();
  for (const e of entries) {
    if (e && typeof e.id === 'string' && e.id && !byId.has(e.id)) byId.set(e.id, e);
  }

  for (const e of entries) applyRetirement(map, byId, e);
  return map;
}

/** The only fields `authority.authorOf`/`tierOf` ever read off a
 * supersession TARGET (see `src/authority.mjs`). Projecting an entry
 * down to these before it goes into `retiredMapFromFiles`'s `byId` is
 * what keeps that map small: the entry's own body — usually most of a
 * drawer's bytes — is never the reason a target is looked up. */
function authorityProjection(e) {
  return { id: e.id, author: e.author, agent: e.agent, origin: e.origin, authority: e.authority };
}

/**
 * P11 · same result as `retiredMap([...every entry across these
 * files])`, without ever holding "every entry" in memory at once.
 *
 * **The measured problem (2026-09-20, `test/p11-ladder.test.mjs`).**
 * `state.mjs`'s old `deriveState` read every log file, `JSON.parse`d
 * every line, and pushed the result into one array before handing it to
 * `retiredMap` — so the memory cost was the size of the WHOLE memory,
 * for a function whose actual output is a handful of retirement
 * records. Bauplan measurement (5,000,000 entries, 1.33 KB/entry):
 * ~6.4 GB.
 *
 * **Why three passes over the same files, not one.** `retiredMap`'s own
 * algorithm needs two things from the corpus: (a) every line that
 * carries `retires_id`/`closes_id`/`replaces_id` (there are always few
 * of these — see `state.mjs`'s header comment, "the clever path… tested
 * every line against every wanted id"), and (b) for a `replaces_id`
 * line specifically, the FEW fields of the entry it points at that
 * `authority.maySupersede` reads. Neither of those is "every entry",
 * but the single-pass array version could only get at them by holding
 * every entry at once. Splitting the same algorithm into three
 * sequential, disk-backed passes gets the same two things without that:
 *
 *   1. which ids are ever NAMED by a `replaces_id` — a `Set<string>`,
 *      not an array of entries.
 *   2. for exactly those ids, {@link authorityProjection} — never the
 *      entry's full body.
 *   3. `applyRetirement` itself, run against that slim `byId` — the
 *      EXACT same function `retiredMap` calls, so this can never decide
 *      a case differently than `retiredMap` would for the same data.
 *      `test/p11-equivalence.test.mjs` checks the two against each
 *      other directly, over a corpus with retirements, corrections,
 *      cycles and dangling references — the case the OLD `deriveState`
 *      was never actually tested against (see the bauplan note this
 *      was built from).
 *
 * Trade made explicit: three sequential reads of the same bytes instead
 * of one, for a memory footprint that no longer grows with the corpus —
 * see the ladder in the build report for the honest before/after on
 * both axes. `iterLogFile` is used for every pass, so no single pass
 * ever holds more than one parsed entry.
 *
 * The JSONL stays the one source of truth throughout: nothing here is
 * cached or persisted, every call recomputes from the files given to
 * it, exactly like the function it replaces.
 */
export function retiredMapFromFiles(absPaths) {
  const wanted = new Set();
  for (const abs of absPaths) {
    for (const e of iterLogFile(abs)) {
      if (e && e.replaces_id) wanted.add(e.replaces_id);
    }
  }

  const byId = new Map();
  for (const abs of absPaths) {
    for (const e of iterLogFile(abs)) {
      if (e && typeof e.id === 'string' && e.id && wanted.has(e.id) && !byId.has(e.id)) {
        byId.set(e.id, authorityProjection(e));
      }
    }
  }

  const map = new Map();
  for (const abs of absPaths) {
    for (const e of iterLogFile(abs)) applyRetirement(map, byId, e);
  }
  return map;
}

/**
 * Is this a pure closing/tombstone line with no content of its own?
 * (Correction lines carrying `replaces_id` DO carry the new content and
 * do NOT count — they are the current truth.)
 */
export function isClosingLine(e) {
  return Boolean(e && (e.retires_id || e.closes_id));
}

/**
 * Does this entry still count? — THE one derivation.
 *
 * Three reasons an entry stops being an answer, and until now they
 * were assembled by hand at twelve call sites:
 *
 *   __broken           the line would not parse
 *   isClosingLine      it is a tombstone, not a statement
 *   retired.has(id)    a later line replaced it
 *
 * Counted on 2026-09-12: twelve sites, writing the filter in three
 * different combinations. Checked one by one they agreed — most had
 * already handled two of the three a loop earlier. Agreeing by
 * accident is not a guarantee, though: whoever adds the next condition
 * (and the supersession chain has gained two in half a year) adds it
 * in one place and not in eleven. Then the memory gives two answers
 * about the same entry, and a reader holding both cannot say which one
 * is lying.
 *
 * So the verdict lives here, once, and every surface renders it. The
 * conditions are deliberately NOT individually switchable: a switch
 * would be the twelve versions coming back through the side door.
 */
export function holds(e, retired = null) {
  if (!e || e.__broken) return false;
  if (isClosingLine(e)) return false;
  if (retired && e.id && retired.has(e.id)) return false;
  return true;
}

/** Allowed states when retiring an entry. */
export const RETIRE_STATE = Object.freeze(['done', 'discarded', 'obsolete']);

/**
 * Retire an entry — mark it done/discarded/obsolete without deleting it.
 * Appends a tombstone line into the SAME log:
 *   { id, ts, retires_id: <id>, state, why? }
 */
export function retireEntry(root, type, id, { state = 'done', why = null, project = null } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('Retiring needs an id');
  if (!RETIRE_STATE.includes(state)) {
    throw new Error(`Unknown state '${state}'. Allowed: ${RETIRE_STATE.join(', ')}`);
  }
  // P12: same shape as `correctionEntry` above — one id, stop at the
  // first match instead of materialising the whole drawer to find it.
  let target = null;
  for (const e of iterLog(root, type, { project })) {
    if (e.id === id && !isClosingLine(e)) { target = e; break; }
  }
  if (!target) {
    throw new Error(`id '${id}' not found in ${type}${project ? ` (project ${project})` : ''}.`);
  }
  const data = { retires_id: id, state };
  if (why) data.why = why;
  return logEntry(root, type, data, { project });
}

/**
 * Where does this id live? Scans every log (global + projects) for the
 * CONTENT entry with this id (not a tombstone). Returns { type, project }
 * or null.
 */
export function findEntryLocation(root, id) {
  // P12: this used to build the FULL entries array for every (type,
  // project) pair before asking `.some()` whether the id was in it —
  // paying for the whole drawer on every miss, of which there are many
  // (every type/project combination the id does NOT live in). `iterLog`
  // lets the loop stop the instant it finds the id, or exhaust the file
  // with nothing ever fully materialised, without changing which id it
  // finds first (same file order as `readLog` would have given it).
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      for (const e of iterLog(root, type, { project })) {
        if (e.id === id && !isClosingLine(e)) return { type, project };
      }
    }
  }
  return null;
}

/**
 * Fetch one entry by id — the second stage of retrieval. `find` returns
 * compact hits; when the caller wants the FULL text of one of them, it
 * pulls it here instead of every hit landing full in the prompt. Returns
 * the entry (with _source/_type/_project) or null.
 */
export function getEntry(root, id) {
  const loc = findEntryLocation(root, id);
  if (!loc) return null;
  // P12: `findEntryLocation` already knows WHICH drawer; this second
  // pass only has to find the one line in it, so it stops there instead
  // of materialising that drawer too.
  let e = null;
  for (const x of iterLog(root, loc.type, { project: loc.project })) {
    if (x.id === id && !isClosingLine(x)) { e = x; break; }
  }
  if (!e) return null;
  return { ...e, _type: loc.type, _project: loc.project,
    _source: `${loc.type}${loc.project ? `/${loc.project}` : ''}` };
}

// ---------------------------------------------------------------------
// Topics: the shape, not just the content
//
// **Measured on 2026-09-05, on a real 553-entry memory.** 69 entries
// carried a `topic`, and those produced 69 distinct topics. Ratio 1.00.
// Of 65 first-path-segment roots, 63 had exactly one child. Several
// "topics" were whole sentences.
//
// A topic with exactly one entry is not a topic. It is a second title
// field. The thread a topic is supposed to carry — a decision, later the
// error against it, later the lesson from that — only exists once a LATER
// entry reuses the same topic.
//
// The cause was a missing rule, not a model failure: the digest spec
// listed `topic` as required without ever saying what a topic IS. Given a
// required field and no definition, a model fills it per entry. That is
// rational behaviour.
//
// What follows is the deterministic half of the repair: a check that
// reports broken shapes at write time, and a tree that makes an existing
// pile of singletons legible without rewriting one line of history.

// --- Merging topics without rewriting history -------------------------
//
// Even after deriving the area from the project, one memory still had 40
// topics for 40 entries in a single area — four of which (`payments`,
// `payment-transfer`, `payment-details`, `payment-class`) were plainly the
// same subject. Renaming them would mean touching lines that were already
// written; the memory is append-only, and that is precisely what makes it
// trustworthy.
//
// So: a second log rather than a correction. A merge is a NEW line saying
// "these two names mean the same thing". It is applied on READ; nothing
// about writing changes. Whoever opens the raw file still sees what stood
// there at the time — and, beside it, how it reads today.

export const ALIAS_LOG = 'global/topic-aliases.jsonl';

/**
 * The merges as a resolved map: old name -> final name.
 *
 * Chains are followed (a->b, b->c yields a->c); cycles stop instead of
 * spinning. A cycle is an operator mistake, not a reason to crash.
 */
export function topicAliases(root) {
  const p = path.join(root, ALIAS_LOG);
  const raw = new Map();
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.from === 'string' && typeof e.to === 'string' && e.from !== e.to) {
          raw.set(e.from, e.to);
        }
      } catch { /* skip a broken line */ }
    }
  }
  const resolved = new Map();
  for (const start of raw.keys()) {
    let target = raw.get(start);
    const seen = new Set([start]);
    while (raw.has(target) && !seen.has(target)) { seen.add(target); target = raw.get(target); }
    resolved.set(start, target);
  }
  return resolved;
}

/** Fold two or more topics into one name. */
export function mergeTopics(root, from, to, { why = '', agent = null, now = new Date() } = {}) {
  const target = String(to ?? '').trim();
  if (!target) throw new Error('mergeTopics: no target topic.');
  const sources = (Array.isArray(from) ? from : [from]).map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!sources.length) throw new Error('mergeTopics: no source topic.');
  const p = path.join(root, ALIAS_LOG);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const written = [];
  for (const src of sources) {
    if (src === target) continue;
    const line = { ts, from: src, to: target, why: String(why || ''), ...(agent ? { agent } : {}) };
    appendLine(p, `${JSON.stringify(line)}\n`);
    written.push(line);
  }
  return { target, written };
}

/** A topic is at most this long. Past it, it is a title. */
export const TOPIC_MAX = 40;

/**
 * Checks the SHAPE of a topic — not whether it is the right one.
 *
 * Deliberately a warning and never an abort: `mem log` is the path along
 * which things get saved that would otherwise be forgotten. A write that
 * fails on a naming rule loses the content. Better recorded and flagged
 * than clean and gone.
 */
export function checkTopic(topic, { area = null } = {}) {
  const t = String(topic ?? '').trim();
  if (!t) return { ok: true, warnings: [] };
  const w = [];
  if (t.length > TOPIC_MAX) {
    w.push(`${t.length} characters (over ${TOPIC_MAX}) — that is a title, not a topic`);
  }
  if (/[.!?,;:]|\s\(/.test(t)) {
    w.push('punctuation — a topic is a handle like "viewer/design", not a sentence');
  }
  if (t.split(/\s+/).length > 4) {
    w.push('more than four words — shorter, and split it with /');
  }
  // No "/" is NOT an error any more. Until 2026-09-05 this check demanded
  // a prefix — and that was backwards: the area comes from the entry's
  // project, not from the name. A prefix repeating the project is, if
  // anything, noise.
  if (area && t.startsWith(`${area}/`)) {
    w.push(`repeats the project ('${area}') — the area already comes from there, `
      + `shorter: '${t.slice(area.length + 1)}'`);
  }
  return { ok: w.length === 0, warnings: w, topic: t };
}

/**
 * Topics as a TREE over their path segments, biggest branch first.
 *
 * Why this is half the fix: `viewer/design`, `viewer/motion` and
 * `viewer/pwa` are three rows among sixty-six in a flat list. As a branch
 * they are one row with three children — and you can see at a glance what
 * is actually a thread and what is orphaned.
 *
 * Computed purely from the existing names. No model, no rewriting, no new
 * field: today's singletons become legible immediately rather than after
 * a cleanup pass.
 */
export function topicTree(root) {
  const flat = topics(root);
  const branches = new Map();
  for (const t of flat) {
    // The area comes from the PROJECT, not from a prefix in the name.
    // That is the 2026-09-05 correction: 72 topics looked like 72 areas
    // when in truth there were four. The grouping people were asking for
    // had been there all along — it was called `project`. A prefix in the
    // topic name was a duplicate of it (`cheap-mem/retrieval` inside
    // `project: cheap-mem`) and helped precisely where it was not needed.
    const area = t.area;
    // If the name repeats the area, the prefix goes — otherwise the same
    // word would stand twice in one row.
    const parts = t.topic.split('/');
    const leaf = (parts.length > 1 && parts[0] === area) ? parts.slice(1).join('/') : t.topic;
    if (!branches.has(area)) {
      branches.set(area, { area, count: 0, last: '', children: [] });
    }
    const b = branches.get(area);
    b.children.push({ ...t, leaf });
    b.count += t.count;
    if (String(t.last ?? '') > b.last) b.last = String(t.last ?? '');
  }
  return [...branches.values()]
    .map((b) => ({
      ...b,
      // A branch with one child is itself a singleton — the tree should
      // show that, not hide it.
      orphan: b.children.length === 1,
      children: b.children.sort((x, y) => String(y.last ?? '').localeCompare(String(x.last ?? ''))),
    }))
    .sort((x, y) => y.children.length - x.children.length
      || String(y.last ?? '').localeCompare(String(x.last ?? '')));
}

/**
 * What there is to say about the topic landscape, as numbers.
 *
 * So that "the digest slices topics too finely" stops being taste and
 * becomes a figure you measure before and after a change. `mem doctor`
 * reads this.
 */
export function topicQuality(root) {
  const flat = topics(root);
  const tree = topicTree(root);
  const withTopic = topicEntries(root).length;
  const singles = flat.filter((t) => t.count === 1).length;
  const malformed = flat.filter((t) => !checkTopic(t.topic, { area: t.area }).ok).length;
  return {
    topics: flat.length,
    entriesWithTopic: withTopic,
    // 1.00 means every topic has exactly one entry — then the field
    // carries no thread, it duplicates the title.
    entriesPerTopic: flat.length ? Number((withTopic / flat.length).toFixed(2)) : 0,
    singleTopics: singles,
    singleShare: flat.length ? Number((singles / flat.length).toFixed(2)) : 0,
    areas: tree.length,
    orphanAreas: tree.filter((b) => b.orphan).length,
    malformed,
  };
}


// ---------------------------------------------------------------------
// Agents as a second axis
//
// `project` says WHAT ABOUT, `agent` says WHO. Two axes, not substitutes:
// the same entry belongs to `project: payments` and to `agent: vm-admin`.
// The field is an address, not a fence — every agent still reads
// everything, and the single digest still sees it all together.
//
// It is read from the entry itself (`agent`) or, failing that, from the
// origin stamp (`origin.agent`). The stamp is the older form and is never
// rewritten after the fact.

const agentOf = (e) => {
  const a = e.agent ?? (e.origin && (e.origin.agent ?? e.origin.agent_name));
  return typeof a === 'string' && a.trim() ? a.trim() : null;
};

/**
 * What the memory knows about ONE agent: what it contributed, what it
 * works on, when it last left something behind.
 *
 * This is the data behind the agent board. Deliberately from the same
 * logs as everything else — an agent gets no store of its own, only its
 * own view of the shared one.
 */
export function agentState(root, name) {
  const wanted = String(name ?? '').trim();
  const entries = [];
  const seen = [];
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      let res;
      try { res = readLog(root, type, { project }); } catch { continue; }
      for (const e of res.entries) {
        seen.push(e);
        if (e.__broken || isClosingLine(e)) continue;
        if (agentOf(e) !== wanted) continue;
        entries.push({ ...e, _type: type, _project: project });
      }
    }
  }
  const retired = retiredMap(seen);
  const live = entries.filter((e) => holds(e, retired));
  live.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));

  const types = {};
  const projects = {};
  const topicSet = new Set();
  for (const e of live) {
    types[e._type] = (types[e._type] ?? 0) + 1;
    const p = e._project ?? '(global)';
    projects[p] = (projects[p] ?? 0) + 1;
    if (typeof e.topic === 'string' && e.topic.trim()) topicSet.add(e.topic.trim());
  }
  return {
    agent: wanted,
    count: live.length,
    retired: entries.length - live.length,
    last: live[0] ? String(live[0].ts ?? '') : '',
    types,
    projects,
    topics: [...topicSet].sort(),
    newest: live.slice(0, 10).map((e) => e.id).filter(Boolean),
  };
}

/**
 * Every agent that APPEARS in the memory — even without a folder under
 * `agents/`.
 *
 * That is the whole point: the board should show the difference. An agent
 * with a folder but no entries has never worked. An agent with entries but
 * no folder writes into the memory without anyone knowing its
 * instructions — at multi-agent scale, the more uncomfortable of the two
 * gaps.
 */
export function agentsInLog(root) {
  const tally = new Map();
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      let res;
      try { res = readLog(root, type, { project }); } catch { continue; }
      for (const e of res.entries) {
        if (e.__broken || isClosingLine(e)) continue;
        const a = agentOf(e);
        if (!a) continue;
        if (!tally.has(a)) tally.set(a, { agent: a, count: 0, last: '' });
        const t = tally.get(a);
        t.count += 1;
        if (String(e.ts ?? '') > t.last) t.last = String(e.ts ?? '');
      }
    }
  }
  return [...tally.values()].sort((a, b) => b.count - a.count);
}
