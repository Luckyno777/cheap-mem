// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * chatgptimport — bring conversations from the official ChatGPT data
 * export into the raw capture, for the normal digest path.
 *
 * **Why.** Claude Code sessions reach the raw capture through the Stop
 * hook (`src/raw.mjs`). Conversations held in ChatGPT never did: the
 * data export is the one official way to get them out. Anyone who used
 * ChatGPT before (or beside) Claude has a history worth remembering, and
 * this reads it in. Ported from the sibling house's `chatgpt-import`
 * (lucky-mem S13, 2026-09-30); decided for this house as a product
 * feature on 2026-10-01.
 *
 * **What this does NOT do — on purpose.**
 *   - It never writes entries. Each conversation becomes a raw capture,
 *     and `mem digest` decides later, the same way it decides for every
 *     Claude session. A second write path into the drawers would be a
 *     second set of rules about what is worth keeping.
 *   - It never calls a model. Import is copying, redacting and filing —
 *     cost nothing, like the Stop hook.
 *   - It never guesses. A conversation without a readable `current_node`
 *     is skipped and counted, not reconstructed from a random branch.
 *
 * **The format — sources this is built against (read 2026-09-30 by the
 * sibling house, re-checked against its fixture here):**
 *   - OpenAI Help Center, "Exporting your ChatGPT history and data"
 *     https://help.openai.com/en/articles/7260999 — Settings -> Data
 *     controls -> Export data; a ZIP arrives by mail, link valid 24 h.
 *   - Community schema "ChatGPT Export Schema Documentation"
 *     https://github.com/xuy/docs-for-agents/blob/main/ChatGPT_export_schema.md
 *     — `conversations.json` is an ARRAY of conversations with `id`,
 *     `title`, `create_time`, `update_time` (Unix seconds, float),
 *     `mapping` (nodes `{id, message|null, parent, children}`) and
 *     `current_node`; a message has `author.role` (user/assistant/system/
 *     tool), `content.content_type` + `content.parts[]`, `create_time`
 *     (may be null), `weight`, `recipient`,
 *     `metadata.is_visually_hidden_from_conversation`,
 *     `metadata.attachments`; images are part objects with
 *     `content_type: "image_asset_pointer"`.
 *   - The visible history is the parent chain from `current_node`,
 *     reversed; `recipient` other than "all" is a tool call; a part may
 *     be an object with `.text`. Nodes with `message: null` are
 *     placeholders.
 * No field here is invented: what none of these sources names is not
 * read. A part of unknown kind becomes a placeholder `[attachment:
 * <kind>]`, never a guess.
 *
 * **Storage — exactly like a Claude capture.** One capture per
 * conversation through `raw.storeCapture()`: same naming rule
 * (`raw/YYYY/MM/<time>--<id>.jsonl.gz`), same archive (CHEAP_MEM_ARCHIVE
 * or the tracked `raw/`), same record in `raw-record.jsonl`, the same
 * redaction (`redaction.redactEntry`) BEFORE anything is written, and
 * the same canary in front of it.
 *
 * **Line shape.** Each message becomes one line in the shape the rest
 * of the house already reads (`raw.textOf`, `mem raw show`, the digest):
 *   `{type:'user'|'assistant', source:'chatgpt-export', timestamp,
 *     message:{role, content:'<text>'}}`
 * The digest therefore has nothing new to learn; the header tells it in
 * `__hint` that `assistant` here is ChatGPT, not Claude.
 *
 * **Duplicates and continuations — append-only, with reasons.** The key
 * is the conversation fingerprint (sha256 of the conversation id,
 * shortened — the raw id never enters the repository) together with
 * `update_time`.
 *   - same `update_time` already imported -> nothing (`already-imported`).
 *     This also holds for a capture whose BYTES were deleted later
 *     (`mem raw delete`): its record row stays, so a deliberate deletion
 *     is not undone by the next import.
 *   - the new path starts with the imported path (fingerprint of the
 *     first N node ids equal) -> a capture with ONLY the new messages
 *     (`continuation`, the header names its predecessor). No text twice
 *     in the memory; the digest only condenses what is new.
 *   - otherwise (an earlier message was edited, the branch changed) ->
 *     a new, complete version (`new-version`, the header names the one
 *     it replaces). The old capture stays (append-only).
 *
 * Rule: append-only (the record is never rewritten).
 * Rule: nothing rather than wrong.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import * as raw from './raw.mjs';
import * as redaction from './redaction.mjs';
import * as archive from './archive.mjs';
import { withLock, LockTimeoutError } from './filelock.mjs';

/** The mark on the stamp (`surface`) and on every line (`source`). */
export const SOURCE = 'chatgpt-export';

/** Roles kept as conversation. */
const KEPT_ROLES = new Set(['user', 'assistant']);

const HINT = 'ChatGPT conversation from the data export: "user" is the person who exported it, '
  + '"assistant" is ChatGPT (not Claude). Images and files appear as placeholders only.';

/** One import at a time: two would both read the same inventory and file every conversation twice. */
const LOCK_FILE = path.join('.mem', 'import-chatgpt.lock');

// --- reading the ZIP (only what is needed, no extra package) ----------
//
// The export is a ZIP that also carries every image; after long use it
// runs to gigabytes. So the whole file is NOT read into memory: find
// the end record, read the central directory, fetch exactly the one
// entry. ZIP64 is understood (archives above 4 GB). Methods 0 (stored)
// and 8 (deflate); anything else is an error with a name.

function readRange(fd, pos, length) {
  const b = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, b, got, length - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return b.subarray(0, got);
}

function u64(b, o) { return Number(b.readBigUInt64LE(o)); }

/** The bytes of `conversations.json` inside a ZIP. Throws with a readable message if it is not there. */
function conversationsFromZip(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLength = Math.min(size, 65535 + 22 + 20);
    const tail = readRange(fd, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a ZIP (end record missing)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdStart = tail.readUInt32LE(eocd + 16);
    if (cdStart === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('ZIP64 without locator');
      const z64 = readRange(fd, u64(tail, loc + 8), 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 end record broken');
      count = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdStart = u64(z64, 48);
    }
    const cd = readRange(fd, cdStart, cdSize);
    const candidates = [];
    const names = [];
    let o = 0;
    for (let i = 0; i < count && o + 46 <= cd.length; i += 1) {
      if (cd.readUInt32LE(o) !== 0x02014b50) throw new Error('central directory broken');
      const method = cd.readUInt16LE(o + 10);
      let packed = cd.readUInt32LE(o + 20);
      let unpacked = cd.readUInt32LE(o + 24);
      const nLen = cd.readUInt16LE(o + 28);
      const xLen = cd.readUInt16LE(o + 30);
      const cLen = cd.readUInt16LE(o + 32);
      let local = cd.readUInt32LE(o + 42);
      const name = cd.subarray(o + 46, o + 46 + nLen).toString('utf8');
      // ZIP64 extra field: the values appear in this order, and only
      // those whose fixed-part value is 0xffffffff.
      let x = o + 46 + nLen;
      const xEnd = x + xLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let p = x + 4;
          if (unpacked === 0xffffffff) { unpacked = u64(cd, p); p += 8; }
          if (packed === 0xffffffff) { packed = u64(cd, p); p += 8; }
          if (local === 0xffffffff) { local = u64(cd, p); p += 8; }
        }
        x += 4 + len;
      }
      names.push(name);
      if (path.posix.basename(name) === 'conversations.json') {
        candidates.push({ name, method, packed, unpacked, local });
      }
      o = xEnd + cLen;
    }
    if (!candidates.length) {
      const json = names.filter((n) => n.endsWith('.json')).slice(0, 10);
      throw new Error(`conversations.json not in the ZIP (JSON files in it: ${json.join(', ') || 'none'})`);
    }
    // The shallowest wins (the export puts it at the root).
    candidates.sort((a, b) => a.name.split('/').length - b.name.split('/').length);
    const k = candidates[0];
    const lh = readRange(fd, k.local, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('local header broken');
    const dataStart = k.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const bytes = readRange(fd, dataStart, k.packed);
    if (k.method === 0) return bytes;
    if (k.method === 8) return zlib.inflateRawSync(bytes);
    throw new Error(`compression method ${k.method} not supported`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read the export — a ZIP or `conversations.json` itself. Returns the array of conversations; throws if it is not one. */
function readExport(file) {
  if (!file || !fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  const fd = fs.openSync(file, 'r');
  let head;
  try { head = readRange(fd, 0, 4); } finally { fs.closeSync(fd); }
  const isZip = head.length === 4 && head.readUInt32LE(0) === 0x04034b50;
  const text = (isZip ? conversationsFromZip(file) : fs.readFileSync(file)).toString('utf8');
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`conversations.json is not JSON: ${e.message}`); }
  if (!Array.isArray(data)) throw new Error('conversations.json is not a list of conversations');
  return data;
}

// --- conversation -> lines ------------------------------------------

/**
 * The visible history: the parent chain from `current_node`, reversed.
 * `null` when `current_node` is missing or not in `mapping` — then
 * nothing is guessed (nothing rather than a wrong branch).
 */
function currentPath(conversation) {
  const m = conversation?.mapping;
  let id = conversation?.current_node;
  if (!m || typeof m !== 'object' || typeof id !== 'string' || !m[id]) return null;
  const chain = [];
  const seen = new Set();
  while (typeof id === 'string' && m[id] && !seen.has(id)) {
    seen.add(id);
    chain.push(id);
    id = m[id].parent ?? null;
  }
  return chain.reverse();
}

/** Unix seconds -> ISO without milliseconds; anything else -> null. */
function isoFromSeconds(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
  return new Date(Math.round(sec * 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Text of a message; images/files as placeholders. `null` = no `parts` at all. */
function textFromContent(content, metadata) {
  const parts = content?.parts;
  if (!Array.isArray(parts)) return null;
  const pieces = [];
  for (const p of parts) {
    if (typeof p === 'string') { if (p) pieces.push(p); continue; }
    if (p && typeof p === 'object') {
      if (p.content_type === 'image_asset_pointer') pieces.push('[image]');
      else if (typeof p.text === 'string') { if (p.text) pieces.push(p.text); }
      else pieces.push(`[attachment: ${typeof p.content_type === 'string' ? p.content_type : 'unknown'}]`);
    }
  }
  const files = Array.isArray(metadata?.attachments) ? metadata.attachments.length : 0;
  if (files > 0) pieces.push(`[${files} file${files === 1 ? '' : 's'} attached]`);
  return pieces.join('\n');
}

/**
 * One node -> `{line}` or `{reason}` (why it was left out). The reasons
 * are a closed vocabulary so the header and the dry run can count them.
 */
function nodeToLine(node) {
  const msg = node?.message;
  if (!msg || typeof msg !== 'object') return { reason: 'placeholder' };
  const role = msg.author?.role;
  if (role === 'system') return { reason: 'system' };
  if (msg.metadata?.is_visually_hidden_from_conversation === true || msg.weight === 0) {
    return { reason: 'hidden' };
  }
  if (role === 'tool') return { reason: 'tool' };
  if (!KEPT_ROLES.has(role)) return { reason: 'unknown-role' };
  if (role === 'assistant' && typeof msg.recipient === 'string' && msg.recipient !== 'all') {
    return { reason: 'tool-call' };
  }
  const text = textFromContent(msg.content, msg.metadata);
  if (text === null) return { reason: 'no-text' };
  if (!text.trim()) return { reason: 'empty' };
  return {
    line: {
      type: role,
      source: SOURCE,
      timestamp: isoFromSeconds(msg.create_time),
      message: { role, content: text },
    },
  };
}

/** Stable short fingerprint — sha256, NOT for security. */
function sha16(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

function conversationFingerprint(id) { return sha16(`chatgpt:${id}`); }
function pathFingerprint(ids) { return sha16(ids.join('\n')); }

// --- inventory: what is already imported ------------------------------

/**
 * From the record: per conversation fingerprint, the imported versions.
 * Reads EVERY capture row, including those whose bytes were deleted —
 * a deleted capture must not come back with the next import.
 */
function inventory(root) {
  const per = new Map();
  for (const rec of archive.records(root)) {
    if (rec?.record === archive.DELETED_MARK || rec?.stamp?.surface !== SOURCE || !rec?.chatgpt) continue;
    const c = rec.chatgpt.conversation;
    if (!c) continue;
    if (!per.has(c)) per.set(c, { times: new Set(), last: null });
    const e = per.get(c);
    e.times.add(rec.chatgpt.update_time);
    e.last = { path: rec.path, ...rec.chatgpt };
  }
  return per;
}

/** Read `--since`: YYYY-MM-DD or ISO. Returns Unix seconds, `null` for none, or throws. */
function sinceFrom(text) {
  if (text == null) return null;
  const ms = Date.parse(String(text));
  if (!Number.isFinite(ms)) throw new Error(`--since: not a date: ${text}`);
  return ms / 1000;
}

/**
 * The plan for an export: per conversation a kind and its lines. Writes
 * nothing. Kinds: new | continuation | new-version | already-imported |
 * unchanged | nothing-new | no-path | before-since | unreadable.
 */
function plan(root, conversations, { since = null } = {}) {
  const known = inventory(root);
  const out = [];
  for (const c of conversations) {
    const id = typeof c?.id === 'string' && c.id ? c.id
      : (typeof c?.conversation_id === 'string' && c.conversation_id ? c.conversation_id : null);
    if (!id || !c?.mapping) { out.push({ kind: 'unreadable' }); continue; }
    const fingerprint = conversationFingerprint(id);
    const updateTime = typeof c.update_time === 'number' ? c.update_time : null;
    const base = { fingerprint, id, title: typeof c.title === 'string' ? c.title : '', updateTime,
      createTime: typeof c.create_time === 'number' ? c.create_time : null };
    if (since != null && (updateTime ?? 0) < since) { out.push({ ...base, kind: 'before-since' }); continue; }
    const chain = currentPath(c);
    if (!chain) { out.push({ ...base, kind: 'no-path' }); continue; }
    const before = known.get(fingerprint);
    if (before?.times.has(updateTime)) { out.push({ ...base, kind: 'already-imported' }); continue; }
    const whole = pathFingerprint(chain);
    let kind = 'new';
    let from = 0;
    const last = before?.last;
    if (last) {
      if (last.path_fingerprint === whole) { out.push({ ...base, kind: 'unchanged' }); continue; }
      const n = Number(last.path_length);
      if (Number.isInteger(n) && n > 0 && n <= chain.length
          && pathFingerprint(chain.slice(0, n)) === last.path_fingerprint) {
        kind = 'continuation';
        from = n;
      } else {
        kind = 'new-version';
      }
    }
    const lines = [];
    const omitted = new Map();
    for (const nodeId of chain.slice(from)) {
      const r = nodeToLine(c.mapping[nodeId]);
      if (r.line) lines.push(r.line);
      else omitted.set(r.reason, (omitted.get(r.reason) ?? 0) + 1);
    }
    out.push({
      ...base, kind: lines.length ? kind : 'nothing-new', predecessor: last?.path ?? null,
      chain, from, lines, omitted,
    });
  }
  return out;
}

/** Redact lines + title; returns `{lines, title, found:Map}`. */
function redactPlanned(p) {
  const found = new Map();
  const lines = p.lines.map((l) => {
    const r = redaction.redactEntry(l);
    for (const f of r.found) found.set(f.type, (found.get(f.type) ?? 0) + f.count);
    return r.object;
  });
  const t = redaction.redactEntry({ title: p.title });
  for (const f of t.found) found.set(f.type, (found.get(f.type) ?? 0) + f.count);
  return { lines, title: t.object.title, found };
}

const WRITES = new Set(['new', 'continuation', 'new-version']);

function isoSeconds(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

/**
 * The import. `dryRun` writes NOTHING (no archive, no record, no bell,
 * no lock file) and returns the same report — counts included, so the
 * person can see what would happen before anything does.
 *
 * Statuses: `imported` | `checked` (dry run) | `broken` (redaction down
 * or the archive refused a write) | `already-running`.
 */
export function importExport(root, exportPath, { since = null, dryRun = false, now = new Date() } = {}) {
  // Canary BEFORE anything else, exactly like the Stop hook: if the
  // redaction no longer does what it claims, nothing is imported —
  // a gap in the memory is better than a secret in the history. The dry
  // run checks too: its counts of redaction findings would be lies.
  const health = redaction.selfTest();
  if (!health.ok) {
    return { status: 'broken', reason: 'redaction-failed',
      detail: health.failed.map((a) => `${a.type}:${a.reason}`).join(', ') };
  }
  const conversations = readExport(exportPath);
  const sinceSec = sinceFrom(since);

  const run = () => {
    const planned = plan(root, conversations, { since: sinceSec });
    const report = {
      status: dryRun ? 'checked' : 'imported',
      conversations: conversations.length,
      kinds: {},
      messages: 0,
      omitted: {},
      redacted: {},
      captures: [],
      errors: [],
    };
    for (const p of planned) {
      report.kinds[p.kind] = (report.kinds[p.kind] ?? 0) + 1;
      if (!WRITES.has(p.kind)) continue;
      report.messages += p.lines.length;
      for (const [g, n] of p.omitted) report.omitted[g] = (report.omitted[g] ?? 0) + n;
      const r = redactPlanned(p);
      for (const [t, n] of r.found) report.redacted[t] = (report.redacted[t] ?? 0) + n;
      if (dryRun) continue;

      const times = r.lines.map((l) => l.timestamp).filter(Boolean).sort();
      const stamp = raw.buildStamp({
        transcript: `chatgpt:${p.id}`, surface: SOURCE,
        tsFrom: times[0] ?? isoFromSeconds(p.createTime), tsTo: times.at(-1) ?? isoFromSeconds(p.updateTime),
      });
      const header = {
        __stamp: stamp,
        __captured_at: isoSeconds(now),
        __lines: r.lines.length,
        __offset_from: p.from,
        __offset_to: p.chain.length,
        __redacted: [...r.found].map(([type, count]) => ({ type, count })),
        // What was left out sits under `__chatgpt.omitted`, NOT under
        // `__dropped`: `__dropped` belongs to the Claude transcript
        // filter (`raw.dropReason`), and mixing a second vocabulary into
        // it would make every count of that filter wrong. Never silent
        // either way: header and report both carry it.
        __source: SOURCE,
        __hint: HINT,
        __chatgpt: {
          title: r.title,
          kind: p.kind,
          ...(p.kind === 'continuation' ? { continues: p.predecessor } : {}),
          ...(p.kind === 'new-version' ? { replaces: p.predecessor } : {}),
          omitted: [...p.omitted].map(([reason, count]) => ({ reason, count })),
          created: isoFromSeconds(p.createTime),
          updated: isoFromSeconds(p.updateTime),
        },
      };
      const kept = raw.storeCapture(root, {
        header, captured: r.lines, stamp, now,
        record: {
          ts_from: stamp.ts_from,
          ts_to: stamp.ts_to,
          source_bytes: Buffer.byteLength(JSON.stringify(p.lines)),
          // The repository keeps only fingerprints: no raw conversation
          // id, no title. Enough to recognise the conversation again.
          chatgpt: {
            conversation: p.fingerprint,
            update_time: p.updateTime,
            path_length: p.chain.length,
            path_fingerprint: pathFingerprint(p.chain),
            kind: p.kind,
          },
        },
      });
      if (kept.status === 'broken') { report.errors.push(kept); break; }
      report.captures.push({ path: kept.relPath, kind: p.kind, lines: r.lines.length });
    }
    if (!dryRun && report.captures.length) report.bell = raw.ring(root, now);
    if (report.errors.length) report.status = 'broken';
    report.archive = archive.readConfig(process.env, root).location;
    return report;
  };

  if (dryRun) return run();
  const lockPath = path.join(root, LOCK_FILE);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    // waitMs 0: a second import does not queue, it says so. staleS one
    // hour: a large export can take minutes, and a lock taken over in
    // the middle would let the second run file everything again.
    return withLock(lockPath, run, { waitMs: 0, staleS: 3600 });
  } catch (e) {
    if (e instanceof LockTimeoutError) return { status: 'already-running' };
    throw e;
  }
}

/** Human-readable report lines (CLI). */
export function reportLines(r, exportPath) {
  const k = r.kinds ?? {};
  const list = (o) => Object.entries(o).map(([key, v]) => `${key} ${v}`).join(', ') || 'none';
  const dry = r.status === 'checked';
  const lines = [
    `ChatGPT export: ${exportPath}${dry ? '  (dry run - nothing written)' : ''}`,
    `  conversations in the export: ${r.conversations}`,
    `  new ${k.new ?? 0}, continued ${k.continuation ?? 0}, new version ${k['new-version'] ?? 0}, `
      + `already imported ${(k['already-imported'] ?? 0) + (k.unchanged ?? 0)}`,
    `  skipped: before --since ${k['before-since'] ?? 0}, without current_node ${k['no-path'] ?? 0}, `
      + `no new message ${k['nothing-new'] ?? 0}, unreadable ${k.unreadable ?? 0}`,
    `  messages (current branch, ${dry ? 'would be' : 'were'} stored): ${r.messages}`,
    `  left out: ${list(r.omitted)}`,
    `  redaction findings (blacked out): ${list(r.redacted)}`,
  ];
  if (!dry) {
    lines.push(`  captures written: ${r.captures.length}  -> ${r.archive}`);
    if (r.captures.length) lines.push('  The next `mem digest` condenses them (bell rung). No model was called.');
  }
  for (const e of r.errors ?? []) lines.push(`  ERROR: ${e.reason}: ${e.detail ?? ''}`);
  return lines;
}
