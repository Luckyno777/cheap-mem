// src/chain.mjs — a per-writer hash chain over append-only logs.
//
// The problem this answers: `checkAppendOnlyGit` (src/doctor.mjs) compares
// the WORKING TREE against `git show HEAD:<path>`. That catches a change
// made before it is committed — exactly where carelessness happens — but
// once a rewrite is committed, HEAD *is* the rewritten content and the
// check is comparing clean history to itself. Measured detection rate
// against five tampers: 1 of 5 (only the working-tree edit). This module
// is a second, independent signal that does not read git at all: it
// recomputes a hash purely from the CURRENT file content and compares it
// against a value recorded earlier, inside the log itself. Whether that
// earlier value survived a commit, an amend, or a rewritten history is
// irrelevant to it — it only asks "does this content still hash to what
// was sealed."
//
// ---------------------------------------------------------------------
// What exactly is hashed
// ---------------------------------------------------------------------
//
// The raw JSONL line, byte for byte, exactly as `fs.readFileSync` returns
// it split on '\n' — never a re-serialisation of the parsed object.
//
// This is not a stylistic choice. On 2026-09-20 a first attempt at
// measuring a hash chain wrote with one hash function (over raw bytes)
// and verified with a different one (over `JSON.stringify` of the
// re-parsed entry). Both arms of that experiment failed, and the failure
// had nothing to do with tampering — `JSON.stringify` does not promise to
// reproduce the exact bytes a *different* JSON.stringify call produced
// (key order from `{...data}` spreads, numeric formatting), so the two
// sides were comparing two different, both "correct", serialisations of
// the same entry. Hashing the raw line sidesteps the question entirely:
// there is no re-serialisation step for the two sides to disagree about,
// because there is no second serialisation at all. What is on disk is
// what gets hashed.
//
// The corollary is `chainHash` below being the ONLY function in this
// module that touches a hash. `replay` (verification) and `appendSeal`
// (the write side) both call it, and neither hashes anything any other
// way — see `test/chain.test.mjs`'s structural check that `createHash`
// appears exactly once in this file's source, so a second hashing path
// introduced later fails loudly instead of drifting quietly.
//
// ---------------------------------------------------------------------
// Who a "writer" is
// ---------------------------------------------------------------------
//
// `entry.agent`, falling back to `entry.origin.agent` / `.agent_name` —
// the same two-step lookup `memory.mjs`'s (private, unexported) `agentOf`
// uses for the agent board. Duplicated rather than imported: exporting it
// from `memory.mjs` is a one-line change that belongs to whoever holds
// that file (see the report), and this module has no other reason to
// depend on `memory.mjs` at all.
//
// A line that carries neither is not excluded from the chain — it is
// filed under `UNATTRIBUTED_WRITER`, a fixed bucket key, and chained like
// any other writer's lines. Excluding unattributed lines would hand an
// attacker a free pass: strip the `agent` field and the line falls
// outside every chain's protection. Filing it under one shared,
// well-known bucket keeps it covered without inventing an identity for it
// that was never claimed.
//
// This chain is scoped to one (file, writer) pair, not to a writer across
// the whole memory. That scoping is what the 2026-09-20 merge experiment
// this module builds on actually measured: `*.jsonl merge=union` unions
// the lines of ONE file, preserving each side's own relative order among
// its own lines while interleaving the two sides. A chain that only
// follows one writer's own lines within one file sees exactly that
// preserved subsequence after the merge, undisturbed by the other
// writer's lines landing in between. A chain spanning every file, or
// spanning every writer, would have no way to agree on a single
// interleaving order after an independent merge of each file — which is
// the same failure the global-chain arm of that experiment already
// demonstrated (1 broken link, merge exit 0, silently).
//
// ---------------------------------------------------------------------
// The last-line window, and the seal that bounds it
// ---------------------------------------------------------------------
//
// Every hash chain has the same blind spot: the newest line has nothing
// chained to it yet. Whatever protects a line lives in the NEXT line, and
// there is no next line until the writer appends again — so a writer who
// goes quiet leaves their final line unprotected for as long as they stay
// quiet.
//
// The fix here is not to close that window (it cannot be, without a
// third party witnessing every write as it happens) but to bound it: a
// SEAL is an ordinary JSONL entry, appended like any other, that carries
// `chain_seal: { writer, through_id, hash }` — "as of the entry with this
// id, writer W's lines hash to this." A seal can be written by anyone
// (the writer itself, a periodic maintenance pass, `mem doctor`) at
// whatever interval that process chooses, and each seal shortens the
// unprotected tail back down to "since the last seal" instead of letting
// it grow for as long as the writer happens to stay silent. This module
// designs the seal and verifies it; nothing in this codebase writes one
// yet (see the report for the exact `memory.mjs` diff that would start
// doing so) — `test/chain.test.mjs` proves the gap this leaves is real
// and names it, rather than papering over it.
//
// ---------------------------------------------------------------------
// Verification result shape
// ---------------------------------------------------------------------
//
// Four states, the house's own vocabulary:
//
//   ok       at least one seal exists for this (file, writer) and every
//            seal recomputes to its declared hash.
//   error    a seal's declared hash does not match what its own covered
//            lines hash to, right now. Tampering, or the seal itself is
//            corrupt — either way the content no longer matches its own
//            record.
//   unknown  NO seal exists at all for this (file, writer). This is the
//            common case for every log written before this module
//            existed, and it must never be reported as "ok" — an absent
//            chain is not an intact one. See `verifyChain`'s own `state`
//            field and the dedicated test for a corpus written before
//            chaining existed.
//
// (`warn` is not produced here: seal presence is a binary fact per
// (file, writer) — either a seal exists and matches, exists and does
// not, or does not exist — and mixing outcomes across many writers into
// one corpus-wide "warn" would hide exactly the distinction — which
// writer, which file — that makes a finding actionable. The per-writer
// rows carry that distinction; only the finest-grained level needs a
// third state here.)

import fs from 'node:fs';
import crypto from 'node:crypto';

/** The hash chain has not started yet. Fixed, not random: reproducible
 *  across every machine that verifies the same content. */
export const GENESIS = '0'.repeat(64);

/** Where a line with no `agent` and no `origin.agent`/`agent_name` is filed. */
export const UNATTRIBUTED_WRITER = '(no-agent)';

export const CHAIN_SEAL_VERSION = 1;

/**
 * THE hash function. Called by both the write side (`appendSeal`) and the
 * read side (`replay`) — see the module comment above for why there must
 * be exactly one of these, and `test/chain.test.mjs` for the structural
 * check that holds it to exactly one call site.
 */
export function chainHash(prevHash, rawLine) {
  return crypto.createHash('sha256')
    .update(String(prevHash), 'utf8')
    .update('\u0000', 'utf8')   // an explicit separator: without one,
    // prevHash='ab' + rawLine='cd' and prevHash='a' + rawLine='bcd' would
    // hash identically. Hex hashes never contain this byte, so it cannot
    // itself be forged by choosing a line that starts with it.
    .update(String(rawLine), 'utf8')
    .digest('hex');
}

/** Same two-step lookup as `memory.mjs`'s private `agentOf` — see the
 *  module comment on why it is duplicated rather than imported. */
export function writerOf(entry) {
  const a = entry?.agent ?? (entry?.origin && (entry.origin.agent ?? entry.origin.agent_name));
  const s = typeof a === 'string' ? a.trim() : '';
  return s || UNATTRIBUTED_WRITER;
}

/** Does this parsed entry carry a well-formed seal? Presence of the
 *  `chain_seal` object is the sole marker — no separate `type` field
 *  exists on these entries (they live inside whichever ordinary drawer
 *  the sealer chose), so recognising a seal has to be structural. */
export function isSealEntry(entry) {
  return !!(entry && typeof entry === 'object' && entry.chain_seal
    && typeof entry.chain_seal === 'object' && !Array.isArray(entry.chain_seal));
}

/** The `chain_seal` payload for a seal covering `writer` through
 *  `throughId`, at running hash `hash`. Exported so a seal built here and
 *  a seal built by whatever eventually wires this into the write path
 *  are constructed the same way. */
export function sealPayload(writer, throughId, hash) {
  return { v: CHAIN_SEAL_VERSION, writer, through_id: throughId, hash };
}

function randomSealId() {
  // Not `memory.mjs`'s `shortId` (private, unexported, and this module
  // has no other reason to depend on that file) — same idea, different
  // bytes. Collision odds are irrelevant here: a seal id is never looked
  // up by id, only walked in file order.
  return crypto.randomBytes(9).toString('base64url');
}

function isoNow(now) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Replay every line of ONE file's raw content once, computing the running
 * per-writer hash after each line and collecting every seal found.
 *
 * Pure and read-only: this never writes, and never throws on a broken
 * line — an unparseable or non-object line is simply skipped, the same
 * recovery `integrity.scanIntegrity` uses, and reported there, not here.
 * A skipped line still changes the hash the SURVIVING lines resolve to
 * (because it is gone from the sequence a seal's hash was computed
 * over), so silently skipping it does not silently forgive it — a seal
 * covering a range that lost a line will not verify.
 */
export function replay(raw) {
  const rawLines = String(raw ?? '').split('\n');
  const running = new Map();          // writer -> hash after the last line seen
  const counts = new Map();           // writer -> lines attributed to them so far
  const lastId = new Map();           // writer -> id of their most recent line
  const sealsByWriter = new Map();    // writer -> [{ line, id, throughId, declared, computed, ok, coveredCount }]
  let sealTotal = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    if (isSealEntry(entry)) {
      sealTotal += 1;
      const w = typeof entry.chain_seal.writer === 'string' ? entry.chain_seal.writer.trim() : '';
      if (w) {
        const before = running.get(w) ?? GENESIS;
        const declared = typeof entry.chain_seal.hash === 'string' ? entry.chain_seal.hash : null;
        const list = sealsByWriter.get(w) ?? [];
        list.push({
          line: i + 1,
          id: typeof entry.id === 'string' ? entry.id : null,
          throughId: entry.chain_seal.through_id ?? null,
          declared,
          computed: before,
          ok: declared !== null && declared === before,
          coveredCount: counts.get(w) ?? 0,
        });
        sealsByWriter.set(w, list);
      }
      // An unattributed seal (missing/blank `chain_seal.writer`) names no
      // chain to check, so nothing above records a verdict for it. It is
      // not silently "fine" — `sealTotal` still counts it, so a corpus
      // full of unattributable seals reports seals seen but zero writer
      // rows, which is visibly different from a corpus with none at all.
    }

    const w = writerOf(entry);
    const prev = running.get(w) ?? GENESIS;
    running.set(w, chainHash(prev, line));
    counts.set(w, (counts.get(w) ?? 0) + 1);
    if (typeof entry.id === 'string' && entry.id) lastId.set(w, entry.id);
  }

  return { running, counts, lastId, sealsByWriter, sealTotal };
}

/**
 * Verify one file (`{ rel, raw, project?, type? }`) and return one row
 * per writer that appears in it — either through an entry or through a
 * seal naming them — plus how many seals the file held in total
 * (including any whose `chain_seal.writer` did not resolve to a row).
 */
export function verifyFile(f) {
  const { running, counts, sealsByWriter, sealTotal } = replay(f.raw);
  const writers = new Set([...running.keys(), ...sealsByWriter.keys()]);
  const rows = [];

  for (const writer of [...writers].sort()) {
    const seals = sealsByWriter.get(writer) ?? [];
    const firstBad = seals.find((s) => !s.ok) ?? null;
    const total = counts.get(writer) ?? 0;
    const lastSeal = seals.length ? seals[seals.length - 1] : null;

    let state;
    if (firstBad) state = 'error';
    else if (seals.length === 0) state = 'unknown';
    else state = 'ok';

    rows.push({
      file: f.rel,
      project: f.project ?? null,
      type: f.type ?? null,
      writer,
      state,
      seals: seals.length,
      verifiedThroughId: firstBad ? null : (lastSeal ? lastSeal.throughId : null),
      // Lines by this writer that no seal covers yet — the bounded
      // last-line window this module trades the unbounded one for. When
      // no seal exists, everything this writer has ever written is, by
      // definition, in that window.
      unsealedSince: firstBad ? null : (total - (lastSeal ? lastSeal.coveredCount : 0)),
      brokenAt: firstBad,
    });
  }
  return { rows, sealTotal };
}

/**
 * Verify every file. `files` is `[{ rel, raw, project?, type? }]` — the
 * caller reads the bytes (typically already has them, from
 * `integrity.scanIntegrity`'s own pass) and hands them over rather than
 * this module reading `root` itself, so this stays a pure function over
 * data a test can construct without touching a filesystem at all.
 */
export function verifyChain(files) {
  const writers = [];
  let sealTotal = 0;
  for (const f of files) {
    const { rows, sealTotal: n } = verifyFile(f);
    writers.push(...rows);
    sealTotal += n;
  }
  const tampered = writers.filter((w) => w.state === 'error');
  const ok = writers.filter((w) => w.state === 'ok');
  const unsealed = writers.filter((w) => w.state === 'unknown');
  return {
    filesChecked: files.length,
    sealsFound: sealTotal,
    writers,
    ok,
    tampered,
    unsealed,
    // 'unknown' here answers "has this mechanism ever vouched for
    // anything in this corpus" — not merely "the check ran". A corpus
    // with zero seals is exactly the state every log written before this
    // module existed is in, and it must read the same way a check that
    // never ran would: unknown, never ok. See the dedicated test.
    state: tampered.length ? 'error' : (sealTotal === 0 ? 'unknown' : 'ok'),
  };
}

/**
 * ---------------------------------------------------------------------
 * Sealing the TAIL, not the file
 * ---------------------------------------------------------------------
 *
 * The naive `appendSeal` (what this used to be) called `replay(raw)` —
 * a full parse of the ENTIRE file — every time it sealed, even when the
 * writer had appended exactly one line since the last seal. Measured:
 * 9.3 ms at 1k rows, 432.6 ms at 100k, 2624.3 ms at 500k — linear in
 * FILE size, not in what actually changed. Sealing every N writes on
 * that implementation would make the cost of a write grow with the
 * memory's age, which is precisely the defect this whole build exists
 * to remove (see the report for the extrapolation to 5 M rows).
 *
 * The fix rests on one fact: the log is append-only, so the running
 * hash after any line is `chainHash(previous-running-hash, that line)`.
 * The "previous running hash" for THIS writer is exactly what their most
 * recent seal already declared (`chain_seal.hash` — see the module
 * comment: that value is the running hash as of just BEFORE the seal
 * line itself). So instead of replaying from the top of the file, this
 * reads the file BACKWARDS in bounded chunks until it finds this
 * writer's most recent seal, then hashes forward only from that seal's
 * OWN line (inclusive — the seal line is itself chained into the
 * writer's running hash, exactly as `replay` does; see the "self-seals"
 * note on `unsealedSince`) through to the end of file. Cost is bounded
 * by how much was appended since the last seal — the TAIL — never by
 * how large the file has grown.
 *
 * `recoverWriterTail` below does the backward read and returns the
 * predecessor hash plus the tail lines to hash forward; `appendSeal` and
 * `maybeSeal` both hash that tail through `chainHash` — the SAME
 * function `replay` uses, so this can never drift into a second hashing
 * path (the structural test on the hashing call count still holds:
 * neither function below touches a hash directly).
 *
 * No cache is kept anywhere. Every call re-derives the predecessor from
 * the log itself, on disk, right now — the seal already IN the file is
 * the only source of truth this reads. There is nothing to go stale and
 * nothing that could disagree with the content it protects.
 */

/** Default chunk size for the backward read in `recoverWriterTail`, in
 *  bytes. Large enough that ordinary tails (a handful to a few hundred
 *  recent lines) are almost always found in the FIRST chunk read — see
 *  the cost-ladder test — small enough to stay a bounded read rather
 *  than "most of the file" for a writer who seals rarely. */
export const DEFAULT_REVERSE_CHUNK_BYTES = 64 * 1024;

/**
 * Read `absPath` BACKWARDS in `chunkSize`-byte chunks until `writer`'s
 * most recent seal is found, or the start of the file is reached.
 *
 * Returns `{ predecessorHash, tailLines, sealFound, bytesScanned }`:
 *
 *   - `predecessorHash` — the found seal's declared hash (the running
 *     hash as of just before that seal line), or `GENESIS` if no seal
 *     for this writer exists anywhere in the file. That second case is
 *     not an error and not "genesis by assumption" — it is what actually
 *     scanning the whole file and finding nothing means. See the "first
 *     seal has no predecessor" test: this function reads every line back
 *     to byte 0 before concluding that, so a real earlier seal it failed
 *     to find is not a way to reach this branch.
 *   - `tailLines` — every line from the found seal (inclusive) through
 *     the end of file, in correct FORWARD order, ready to hash forward
 *     with `chainHash`. When no seal is found, this is every line in the
 *     file, forward — i.e. exactly what a full `replay` would walk.
 *   - `bytesScanned` — for the cost tests: how much was actually read
 *     backwards, which should stay bounded by the tail, not the file.
 *
 * Splitting is done on the raw `\n` byte (0x0A) in `Buffer`s, never on
 * decoded text — 0x0A cannot appear as any byte of a multi-byte UTF-8
 * sequence (continuation bytes are 0x80-0xBF, leading bytes 0xC2-0xF4),
 * so a chunk boundary can split a MULTI-BYTE CHARACTER apart without any
 * risk of misreading a `\n`, and decoding each byte-exact line slice on
 * its own is always safe once a full line's bytes are assembled. What a
 * chunk boundary CAN split is a LINE: the byte in the middle of a JSON
 * record straddling two reads. `confirmedStart` below exists exactly for
 * that — a chunk's leading fragment (before its first `\n`) is treated
 * as unresolved and carried into the NEXT (further back) read, joined
 * with what comes before it, until a complete line is assembled or the
 * true start of the file is reached. See the dedicated chunk-boundary
 * test, which forces this with a chunk size of a few bytes.
 */
export function recoverWriterTail(absPath, writer, { chunkSize = DEFAULT_REVERSE_CHUNK_BYTES } = {}) {
  let fd;
  try { fd = fs.openSync(absPath, 'r'); }
  catch { return { predecessorHash: GENESIS, tailLines: [], sealFound: false, bytesScanned: 0 }; }

  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize === 0) return { predecessorHash: GENESIS, tailLines: [], sealFound: false, bytesScanned: 0 };

    let filePos = fileSize;        // unread region is file[0, filePos)
    let carry = Buffer.alloc(0);   // an unresolved fragment, known to sit
                                    // immediately AFTER filePos in the file
    const collected = [];          // confirmed lines, EOF-first (reverse order)
    let sealFound = null;
    let bytesScanned = 0;

    while (filePos > 0 && !sealFound) {
      const readLen = Math.min(chunkSize, filePos);
      const readStart = filePos - readLen;
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, readStart);
      bytesScanned += readLen;
      filePos = readStart;

      const combined = Buffer.concat([buf, carry]);
      const atFileStart = filePos === 0;
      const firstNl = combined.indexOf(0x0A);

      if (!atFileStart && firstNl === -1) {
        // No newline anywhere in what has been read yet — the leading
        // fragment is still unresolved. Keep everything and read further
        // back rather than guess where a line starts.
        carry = combined;
        continue;
      }
      // Everything from `confirmedStart` onward has both a known start
      // and a known end — either bounded by `\n` bytes we can see, or
      // (at `atFileStart`) bounded by byte 0 of the file itself.
      const confirmedStart = atFileStart ? 0 : firstNl + 1;

      let end = combined.length;   // exclusive end of the next line to read
      while (end > confirmedStart) {
        const nlIdx = combined.lastIndexOf(0x0A, end - 1);
        const lineStart = nlIdx === -1 ? confirmedStart : nlIdx + 1;
        const lineStr = combined.subarray(lineStart, end).toString('utf8');
        if (lineStr.trim()) {
          collected.push(lineStr);
          let entry;
          try { entry = JSON.parse(lineStr); } catch { entry = null; }
          if (entry && isSealEntry(entry)) {
            const w = typeof entry.chain_seal.writer === 'string' ? entry.chain_seal.writer.trim() : '';
            if (w === writer) {
              const declared = typeof entry.chain_seal.hash === 'string' ? entry.chain_seal.hash : GENESIS;
              sealFound = { declared };
              break;   // the CLOSEST seal to EOF for this writer — stop here
            }
          }
        }
        end = nlIdx;   // -1 ends the inner loop; a real index resumes just before it
      }
      if (!sealFound) carry = combined.subarray(0, confirmedStart);
    }

    return {
      predecessorHash: sealFound ? sealFound.declared : GENESIS,
      tailLines: collected.reverse(),
      sealFound: !!sealFound,
      bytesScanned,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Hash `tailLines` forward from `predecessorHash`, exactly the way
 * `replay` would for this one writer — restricted to lines whose
 * `writerOf(...)` matches, in file order. Shared by `appendSeal` and
 * `maybeSeal` so the two never compute a seal two different ways.
 */
function forwardHashTail(writer, { predecessorHash, tailLines }) {
  let hash = predecessorHash;
  let throughId = null;
  for (const rawLine of tailLines) {
    let entry;
    try { entry = JSON.parse(rawLine); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (writerOf(entry) !== writer) continue;
    hash = chainHash(hash, rawLine);
    if (typeof entry.id === 'string' && entry.id) throughId = entry.id;
  }
  return { hash, throughId };
}

/**
 * Build and append a seal for `writer` to `absPath`, covering everything
 * that writer has written there so far.
 *
 * Cost is bounded by the TAIL since this writer's last seal (see
 * `recoverWriterTail` above), not by the file — the one property this
 * whole module exists to give `memory.logEntry`'s write path. The FIRST
 * seal for a writer that has never been sealed is the honest exception:
 * there is no predecessor to recover, so the entire file is the tail
 * exactly once, by necessity, not by a bug — see the cost-ladder test
 * and `test/chain.test.mjs`'s dedicated "no predecessor" case.
 *
 * Not JSONL-atomic beyond what `fs.appendFileSync` already gives a
 * single write — the same guarantee every other append in this codebase
 * relies on (see `test/concurrent-append.test.mjs`).
 */
export function appendSeal(absPath, writer, {
  agent = writer, now = new Date(), id = null, chunkSize = DEFAULT_REVERSE_CHUNK_BYTES,
} = {}) {
  const recovered = recoverWriterTail(absPath, writer, { chunkSize });
  const { hash, throughId } = forwardHashTail(writer, recovered);
  const entry = {
    id: id ?? randomSealId(),
    ts: isoNow(now),
    agent,
    chain_seal: sealPayload(writer, throughId, hash),
  };
  const line = JSON.stringify(entry);
  fs.appendFileSync(absPath, `${line}\n`, 'utf8');
  return entry;
}

/**
 * Seal `writer`'s tail in `absPath` ONLY IF it has grown to at least
 * `cadence` lines since their last seal (or, when no seal exists yet,
 * `cadence` lines in the file at all) — otherwise a no-op, returning
 * `null`. This is the hook `memory.logEntry` calls on every write; see
 * `CHAIN_SEAL_CADENCE` there for the cadence itself and the measurement
 * behind it.
 *
 * The check and the seal share ONE backward scan (`recoverWriterTail`):
 * "how much is unsealed" is answered by re-reading the log itself, the
 * same way the seal's own hash is — never by a separate counter that
 * could disagree with the file. On the common case (not due yet) this
 * costs exactly the same bounded backward read `appendSeal` would, and
 * nothing is written.
 */
export function maybeSeal(absPath, writer, {
  cadence, agent = writer, now = new Date(), chunkSize = DEFAULT_REVERSE_CHUNK_BYTES,
} = {}) {
  if (!Number.isFinite(cadence) || cadence < 1) {
    throw new Error('maybeSeal: cadence must be a positive number of lines');
  }
  const recovered = recoverWriterTail(absPath, writer, { chunkSize });
  if (recovered.tailLines.length < cadence) return null;
  const { hash, throughId } = forwardHashTail(writer, recovered);
  const entry = {
    id: randomSealId(),
    ts: isoNow(now),
    agent,
    chain_seal: sealPayload(writer, throughId, hash),
  };
  fs.appendFileSync(absPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}
