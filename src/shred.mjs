// src/shred.mjs — crypto-shredding: per-entry body encryption plus a
// small, NOT append-only keyring, built for P14 of the 2026-09-20
// build plan ("Append-only against a duty to delete").
//
// ---------------------------------------------------------------------
// The problem this answers
// ---------------------------------------------------------------------
//
// "Nothing is deleted, only its address changes" is right for a
// personal memory. An organisation gets real deletion requests, and
// append-only-plus-git-history means a genuine deletion would need
// `git filter-repo` and a force-push on a memory several agents share —
// explicitly out of this project's autonomy and never an everyday tool.
//
// The fix here does not touch history at all. Each entry's BODY is
// encrypted, under its OWN random key, before the line is ever written.
// The key lives in a small side file — the keyring — that is the one
// place in this house allowed to be mutated in place rather than only
// appended to. Deleting an entry means destroying its key here. The
// ciphertext line stays in the log forever, unreadable; nobody rewrites
// a single byte of it.
//
// ---------------------------------------------------------------------
// What is encrypted, and what must never be (write this down, not just
// believe it)
// ---------------------------------------------------------------------
//
// Encrypted: exactly the fields this codebase already calls "the body"
// — `SHREDDABLE_FIELDS` below, copied from `retrieval.mjs`'s own
// `BODY_FIELDS` (see the note at that constant for why it is copied,
// not imported). Nothing outside that list is ever touched by
// `shredWrite`.
//
// Never encrypted, and why — this list is the answer P14 explicitly
// demands: what must not be encrypted has to be named explicitly.
//
//   id       the register's own primary key. Encrypt it and no lookup,
//            no `mem shred`, no chain replay can ever find the line
//            again — the register could no longer verify itself.
//   ts       the timestamp. "When" is metadata about the register, not
//            content to protect; encrypting it breaks every --as-of
//            query and every retention/audit report without hiding
//            anything a body-only guarantee ever promised to hide.
//   v        the schema version — `entryVersionOf`/`adaptEntry`'s
//            dispatch key. Encrypt it and every entry stops being
//            readable AS an entry, before shredding even enters the
//            picture.
//   agent    who wrote it. `chain.mjs`'s `writerOf` reads this field
//            directly off the RAW entry to decide which writer's hash
//            chain a line belongs to (see the chain-compatibility note
//            below). Encrypt it and a sealed chain can no longer even
//            be replayed, let alone verified.
//   project  the scope, where it appears as a literal field in
//            addition to being the routing (directory). A capability
//            check that cannot read the field it filters on is not a
//            check — see `capability.mjs` and P13 of the same plan.
//   shredded_of / shredded_reason
//            the deletion marker itself (see "the marker entry" below).
//            The whole point of this mechanism is that the REGISTER
//            keeps reporting a deletion after the key is gone; a marker
//            whose own date and reason are unreadable would defeat
//            that on the very entry meant to prove it happened.
//
// Everything else on an entry (tags, class, topic, links, authority,
// ...) is untouched by this module. `shredWrite` only ever looks at, and
// only ever removes, the fields named in `SHREDDABLE_FIELDS`.
//
// ---------------------------------------------------------------------
// The keyring: the one mutable file in an append-only house
// ---------------------------------------------------------------------
//
// Lives at `<root>/.mem/keyring.json`, next to `.mem/config.json` — a
// small JSON object, id -> { key (base64), createdAt }, rewritten whole
// on every change (`putKey`/`destroyKey`). This is deliberate: the
// house's append-only rule protects entries, not this file. A keyring
// that could only ever grow could never actually forget a key, which is
// the one thing this whole build exists to make possible.
//
// **Three states, not two, for what a read finds:**
//   - keyring PRESENT, key found     -> the body decrypts.
//   - keyring PRESENT, key absent    -> shredded (or never existed for
//                                       this id) — reported as
//                                       `unreadable: no-key`.
//   - keyring ABSENT entirely        -> EVERY encrypted entry in this
//                                       memory is unreadable, not just
//                                       one — reported as
//                                       `unreadable: keyring-absent`,
//                                       never folded into "no entries"
//                                       or silently treated as an empty
//                                       keyring. A missing file and an
//                                       empty one are different facts:
//                                       one says "nothing was ever
//                                       shredded here", the other says
//                                       "this whole mechanism cannot
//                                       currently answer at all". See
//                                       `loadKeyring`/`readEntryBody`.
//
// **Do not commit this file's history to git the way a log is
// committed.** The whole point of `destroyKey` is that the OLD key
// stops existing anywhere reachable. If the keyring is tracked in git
// as an ordinary versioned file, `destroyKey`'s rewrite becomes a new
// COMMIT, not an erasure — the destroyed key is still sitting in the
// repository's history, in the very commit before the deletion, exactly
// as recoverable as the log lines this project already refuses to
// rewrite. A keyring kept under normal git history does not shred
// anything; it just moves the same problem one file to the left. See
// `test/p14-crypto-shred.test.mjs`'s "keyring under git history" case,
// which demonstrates this failure mode on purpose rather than asserting
// it in prose, and the build report for what that implies for
// deployment (the keyring needs a distribution mechanism that does not
// retain history — out of scope for this module, which only owns the
// file's shape and refuses to pretend the problem is solved).
//
// ---------------------------------------------------------------------
// Interaction with the hash chain (src/chain.mjs)
// ---------------------------------------------------------------------
//
// `chain.mjs` hashes the RAW JSONL LINE, byte for byte, exactly as
// written. Crypto-shredding never rewrites that line: the body is
// encrypted BEFORE the line is first appended (see `memory.mjs`'s
// `logEntry`), and destroying a key only removes an entry from the
// SEPARATE keyring file. The append-only log itself is never touched
// again after the moment it was written.
//
// The two mechanisms are therefore compatible by construction, not by
// coincidence: a chain sealed over a log that already contains
// encrypted lines stays exactly as valid after ten entries are
// shredded as before, because "shredding" never became a write to that
// log — it became a write to the keyring, plus one ordinary NEW
// append (the deletion marker, below), which the chain simply chains
// in like any other line. `test/p14-crypto-shred.test.mjs` proves this
// with a real seal, a real shred, and a real re-verification — not by
// asserting it from the design.
//
// ---------------------------------------------------------------------
// The deletion marker
// ---------------------------------------------------------------------
//
// Deleting an entry does not, and cannot, change its original line —
// that would be exactly the history-rewrite this build exists to
// avoid. Instead, `memory.shredEntry` appends a NEW, ordinary line
// carrying `shredded_of` (the id being deleted), `shredded_reason` and
// the usual `id`/`ts`/`agent` — the same "a correction is a new line,
// never an edit" shape this codebase already uses for `replaces_id`
// and duty's `closes_id`. `memory.shredStatus` folds an entry with any
// later marker naming it into one answer: shredded, since when, why.
//
// ---------------------------------------------------------------------
// Write cost — measured, and it FAILS the plan's own 20% abort criterion
// ---------------------------------------------------------------------
//
// `putKey` reads the WHOLE keyring, adds one entry, and rewrites the
// WHOLE keyring — on every single `shred: true` write. That cost grows
// with how many keys already exist, which is exactly the corpus-size
// dependence P16 of this same plan exists to remove from the write path
// in general.
//
// Measured 2026-09-20 (`test/p14-crypto-shred.test.mjs`'s COST test,
// median of 25 bare `memory.logEntry` calls, against a pre-seeded
// keyring): baseline (no `shred`) stays flat at ~0.08-0.09 ms
// regardless of keyring size, as expected. WITH `shred: true`:
//
//   keyring size     0 keys     500 keys    3000 keys
//   with shred    0.44 ms       1.38 ms       6.92 ms
//   overhead       +380 %       +1619 %       +8354 %
//
// This is reported as measured, per the build brief's own instruction,
// rather than adjusted to pass: crypto-shredding as built here COSTS
// FAR MORE than the plan's 20%-of-write-time abort line, even at an
// EMPTY keyring, and the cost gets worse, not flat, as more entries are
// ever encrypted. A memory that shreds routinely would see its write
// cost keep climbing for the rest of its life — a second instance of
// the exact defect P16 is a whole build point about fixing, introduced
// here by this build's own naive keyring. Fixing it (an append-only-ish
// keyring log with periodic compaction, or a per-key file, or an
// indexed store) is a real follow-up, not attempted here — see the
// build report.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KEYRING_DIR = '.mem';
export const KEYRING_FILE = 'keyring.json';
export const KEYRING_VERSION = 1;

export const ALGORITHM = 'aes-256-gcm';
export const KEY_BYTES = 32;
export const IV_BYTES = 12;

/**
 * The body of an entry, in this module's own words.
 *
 * Copied from `retrieval.mjs`'s `BODY_FIELDS`, not imported: `memory.mjs`
 * already imports THIS module, and `retrieval.mjs` imports `memory.mjs`
 * — importing `retrieval.mjs` from here would close that cycle
 * (`memory.mjs` -> `shred.mjs` -> `retrieval.mjs` -> `memory.mjs`).
 * `chain.mjs` duplicates `writerOf` for the identical reason; this is
 * the same house rule applied a second time. `test/audit-koerper.test.mjs`
 * is the audited source of truth for this list on the `retrieval.mjs`
 * side — if that list ever changes, this one has to change with it by
 * hand, and a mismatch would show up as a body field this module leaves
 * in the clear (or tries to encrypt) that `retrieval.mjs` disagrees
 * about.
 */
/**
 * **What encrypting `title` costs, measured 2026-09-20 and stated here
 * rather than discovered later.** `title` is in this list because it is
 * body: the sentence a person wrote. But it is also the field the
 * indexer weights most heavily. So an entry written with `shred: true`
 * is not merely "body hidden until decrypted" — it is UNFINDABLE:
 *
 *     logEntry(root, 'decision', {title:'zzztitle', ..., shred:true})
 *     retrieve(root, 'zzztitle', grantAll(), {top:5})  ->  0 claims
 *
 * `readEntryBody` returns the whole body correctly (`state: 'ok'`, key
 * intact), so nothing is lost — but no search lane, and no viewer, can
 * reach the entry to ask. That is why this ships OFF: turning it on by
 * default would quietly remove entries from every answer this memory
 * gives, while every test that checks "is the body still readable"
 * stayed green.
 *
 * The fix is not to drop `title` from this list — that would leak the
 * one field most likely to name the person. It is a decrypt hook in
 * `search.mjs`'s indexer and `retrieval.mjs`'s body read, which is a
 * coordinated change across files this build point does not own.
 */
export const SHREDDABLE_FIELDS = Object.freeze([
  'choice', 'learning', 'duty', 'rule', 'question', 'skill',
  'why', 'title', 'text', 'fact', 'description', 'excerpt', 'rejected',
]);

/** The fields this module refuses to encrypt, with the reason recorded
 *  in the module comment above — kept here too, as data, so a test can
 *  assert `shredWrite` never touches one of these without re-reading
 *  prose to know which ones matter. */
export const NEVER_ENCRYPT = Object.freeze([
  'id', 'ts', 'v', 'agent', 'project', 'shredded_of', 'shredded_reason',
]);

export function keyringPath(root) {
  return path.join(root, KEYRING_DIR, KEYRING_FILE);
}

/**
 * Read the keyring. Returns `{ present, keys }` — `keys` a
 * `Map<id, { key: base64, createdAt }>`.
 *
 * `present: false` means the file itself does not exist: a fact
 * distinct from "the file exists and holds zero keys" (`present: true,
 * keys: new Map()`), and the caller-facing distinction the whole
 * "third state" requirement rests on. See `readEntryBody`.
 *
 * A keyring that EXISTS but does not parse as JSON is a THIRD state
 * again — not absent, not a healthy empty keyring — and this throws
 * rather than quietly returning `present: false`, which would make a
 * corrupted keyring indistinguishable from one that was simply never
 * created.
 */
export function loadKeyring(root) {
  const p = keyringPath(root);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return { present: false, keys: new Map() };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`Keyring at ${p} exists but is not valid JSON: ${e.message}`);
    err.code = 'EKEYRINGCORRUPT';
    throw err;
  }
  const keys = new Map();
  if (obj && typeof obj === 'object' && obj.keys && typeof obj.keys === 'object') {
    for (const [id, rec] of Object.entries(obj.keys)) {
      if (rec && typeof rec.key === 'string') keys.set(id, rec);
    }
  }
  return { present: true, keys };
}

/**
 * Write the whole keyring back, atomically (write beside it, then
 * rename) — the same shape every other mutable file in this codebase
 * uses (`config.writeConfig`, `indexcache.writeIndexCache`), applied to
 * the one log-adjacent file that is allowed to be rewritten in place
 * rather than only appended to.
 */
function saveKeyring(root, keys) {
  const p = keyringPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const obj = { version: KEYRING_VERSION, keys: Object.fromEntries(keys) };
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

/** Record a new key for `id`. Creates the keyring file if it did not
 *  exist yet — the first shreddable write in a fresh memory. */
export function putKey(root, id, keyBuf, { now = new Date() } = {}) {
  const { keys } = loadKeyring(root);
  keys.set(id, { key: keyBuf.toString('base64'), createdAt: new Date(now).toISOString() });
  saveKeyring(root, keys);
}

/** Whether a decryptable key currently exists for `id`. `false` both
 *  when the keyring is present but lacks the id, and when the keyring
 *  is entirely absent — callers that need to tell those apart use
 *  `loadKeyring`/`readEntryBody` directly. */
export function hasKey(root, id) {
  const { present, keys } = loadKeyring(root);
  return present && keys.has(id);
}

/**
 * Destroy the key for `id` — the actual deletion. Rewrites the keyring
 * WITHOUT that entry; nothing about the log itself changes.
 *
 * Throws if the keyring does not exist at all: that is a different,
 * worse fact than "this one id was already shredded" (every encrypted
 * entry in this memory is currently unreadable, not just this one),
 * and collapsing the two would let a caller believe one targeted
 * deletion succeeded when the whole mechanism is actually down.
 *
 * Returns `{ destroyed: false, reason: 'no-such-key' }` — not an error
 * — when the keyring is present but never held this id: shredding an
 * already-shredded entry (or one that was never encrypted) is a no-op,
 * not a failure the caller needs to handle specially.
 */
export function destroyKey(root, id, { reason = null, now = new Date() } = {}) {
  const { present, keys } = loadKeyring(root);
  if (!present) {
    throw new Error(
      `No keyring at ${keyringPath(root)} — cannot destroy a key that was never recorded as `
      + 'kept here. This is a different, worse fact than "already shredded": every entry ever '
      + 'encrypted in this memory is currently unreadable (see readEntryBody\'s keyring-absent '
      + 'state), not specifically this one id.');
  }
  if (!keys.has(id)) {
    return { destroyed: false, reason: 'no-such-key' };
  }
  keys.delete(id);
  saveKeyring(root, keys);
  return { destroyed: true, reason, at: new Date(now).toISOString() };
}

// --- body encryption ---------------------------------------------------

/** Which `SHREDDABLE_FIELDS` are present on `data` as non-empty
 *  strings, and the object built from exactly those. */
export function extractBodyFields(data) {
  const present = {};
  let any = false;
  for (const f of SHREDDABLE_FIELDS) {
    if (typeof data?.[f] === 'string' && data[f]) {
      present[f] = data[f];
      any = true;
    }
  }
  return { present, any };
}

function encryptFields(fields, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(fields), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function decryptFields(enc, key) {
  const iv = Buffer.from(enc.iv, 'base64');
  const tag = Buffer.from(enc.tag, 'base64');
  const ct = Buffer.from(enc.ct, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/**
 * Build the encrypted form of one entry's data, and the key it was
 * encrypted under. Called from `memory.logEntry` BEFORE the line is
 * ever written — the plaintext body never touches disk at all, not
 * even transiently.
 *
 * `data` is whatever the caller passed to `logEntry` (already stripped
 * of `v`/`shred` by that point). Returns `{ redacted, key }`: `redacted`
 * is `data` with every present `SHREDDABLE_FIELDS` key removed and
 * `body_enc` added; `key` is a fresh random 32-byte `Buffer` the caller
 * still has to persist (`putKey`) — this function never touches the
 * keyring itself, so it stays a pure, easily tested transform.
 *
 * Throws if `data` carries none of `SHREDDABLE_FIELDS`: encrypting
 * nothing would still mint a key and a `body_enc` wrapper that protects
 * an empty object, which is not a mistake worth writing to disk
 * silently.
 */
export function shredWrite(data) {
  const { present, any } = extractBodyFields(data);
  if (!any) {
    throw new Error(
      'crypto-shredding requested (shred: true) but this entry has no body field to encrypt '
      + `(checked: ${SHREDDABLE_FIELDS.join(', ')}) — nothing would be protected.`);
  }
  const key = crypto.randomBytes(KEY_BYTES);
  const bodyEnc = encryptFields(present, key);
  const redacted = { ...data };
  for (const f of Object.keys(present)) delete redacted[f];
  redacted.body_enc = bodyEnc;
  return { redacted, key };
}

/** The `SHREDDABLE_FIELDS` present on an entry that was NEVER
 *  encrypted (no `body_enc`) — used by `readEntryBody` so a plain entry
 *  and a decrypted one hand back the same shape. */
function plainBodyFields(entry) {
  const out = {};
  for (const f of SHREDDABLE_FIELDS) {
    if (typeof entry?.[f] === 'string' && entry[f]) out[f] = entry[f];
  }
  return out;
}

/**
 * Read one entry's body, trying every step and naming exactly where it
 * stopped. Four outcomes, the house's own vocabulary:
 *
 *   `{ state: 'unknown', reason: 'no-entry' }`
 *       there is no entry here to read. Measured 2026-09-20: this used
 *       to answer `plain` with an empty `fields` map, folding "nothing
 *       was passed" into a VERDICT about an entry's body — "this one is
 *       not encrypted" — about something the function never saw. A
 *       caller that looked up an id and missed got back a confident
 *       "not encrypted" for an entry that does not exist. Absence is
 *       its own state here, as everywhere else in this house.
 *   `{ state: 'plain', fields }`
 *       a real entry with no `body_enc` at all — never routed through
 *       crypto-shredding. `fields` is whatever `SHREDDABLE_FIELDS` it
 *       carries in the clear, same shape a decrypted entry returns.
 *   `{ state: 'ok', fields }`
 *       encrypted, keyring present, key found, decryption succeeded.
 *   `{ state: 'unreadable', reason: 'keyring-absent' }`
 *       the keyring file does not exist AT ALL — every encrypted entry
 *       in this memory is unreadable right now, not only this one.
 *   `{ state: 'unreadable', reason: 'no-key' | 'key-corrupt' | 'decrypt-failed', error? }`
 *       the keyring exists but this entry's key is gone (shredded, or
 *       never recorded), unparsable, or does not decrypt the stored
 *       ciphertext (wrong key, or tampered ciphertext/tag).
 *
 * Never throws for an ordinary "cannot read this" outcome — a caller
 * walking many entries (`find`, a digest, a report) must be able to
 * keep going past one unreadable body without a try/catch around every
 * entry. A CORRUPT keyring (`loadKeyring`'s own thrown error) is the
 * one exception that DOES propagate: it is not "this entry is
 * unreadable", it is "this whole check cannot currently be trusted",
 * and swallowing that would let a caller print a false `no-key` for
 * every entry in a memory whose keyring is actually broken, not empty.
 */
export function readEntryBody(root, entry) {
  // Absence first, and on its own. Merged into the `plain` branch this
  // reported a definite verdict about a body it never inspected.
  if (!entry || typeof entry !== 'object') {
    return { state: 'unknown', reason: 'no-entry', fields: null };
  }
  if (!entry.body_enc) {
    return { state: 'plain', reason: null, fields: plainBodyFields(entry) };
  }
  const { present, keys } = loadKeyring(root);
  if (!present) {
    return { state: 'unreadable', reason: 'keyring-absent', fields: null };
  }
  const id = entry.id;
  const rec = id ? keys.get(id) : null;
  if (!rec) {
    return { state: 'unreadable', reason: 'no-key', fields: null };
  }
  let key;
  try {
    key = Buffer.from(rec.key, 'base64');
    if (key.length !== KEY_BYTES) throw new Error('wrong key length');
  } catch {
    return { state: 'unreadable', reason: 'key-corrupt', fields: null };
  }
  try {
    const fields = decryptFields(entry.body_enc, key);
    return { state: 'ok', reason: null, fields };
  } catch (e) {
    return { state: 'unreadable', reason: 'decrypt-failed', fields: null, error: e.message };
  }
}
