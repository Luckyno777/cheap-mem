// store.mjs — every generated file provable, without bloating the repo.
//
// "Keep everything we generate" is the right goal for an audit trail. The
// obvious implementation — commit the files — breaks in four places, and
// each one alone is expensive:
//
//  1. **git is not a blob store.** A real memory's `.git` was already
//     49 MB at 553 text entries, and a session-start hook shallow-clones
//     it on EVERY cloud session. A 200 MB video then sits in every clone
//     forever, including after it is deleted — git does not forget.
//
//  2. **Redaction cannot read binaries.** `redact()` works on strings. A
//     generated PDF, PNG or XLSX can carry the same secrets and the
//     redactor is blind to them. "Store everything" would mean putting
//     unredactable content behind a promise that claims everything is
//     redacted.
//
//  3. **Append-only and the duty to erase contradict each other.** GDPR
//     Art. 17 requires erasure. Nothing comes out of append-only git
//     history without breaking every clone. A memory that CANNOT forget
//     is a liability in an enterprise sale, not a strength.
//
//  4. **"Everything generated" is the wrong scope.** One working session
//     produced about forty builds of the same page plus dozens of
//     screenshots. That is not an audit trail, it is noise. An audit
//     trail wants the RESULT, with provenance and integrity.
//
// So the store is split:
//
//     store/register.jsonl   IN the repo — one line per artifact: hash,
//                            size, type, origin, purpose, retention.
//                            Small, readable, redactable, append-only.
//                            THIS is the audit trail.
//     store/objects/<aa>/    NOT in the repo — the bytes, addressed by
//                            their SHA-256. Swappable for S3/MinIO.
//
// What that buys: the clone stays small, the bytes are deletable (the
// register line stays as a tombstone and still proves WHAT was there),
// and the hash proves integrity without the file living in the repo. An
// auditor gets more than with "commit everything", not less.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as redaction from './redaction.mjs';

export const STORE = 'store';
export const REGISTER = 'store/register.jsonl';

/** Larger than this needs an explicit --large. */
export const LARGE_OVER_BYTES = 25 * 1024 * 1024;

// What counts as text and therefore has to pass redaction. Everything
// else is not checkable — and is recorded as exactly that, rather than
// being passed over in silence.
const TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv',
  '.html', '.htm', '.svg', '.xml', '.js', '.mjs', '.ts', '.css', '.sh',
  '.py', '.sql', '.env', '.ini', '.conf', '.log',
]);

const MIME = new Map(Object.entries({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.jsonl': 'application/x-ndjson', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}));

export const mimeOf = (name) => MIME.get(path.extname(name).toLowerCase()) ?? 'application/octet-stream';
export const isText = (name) => TEXT_EXTS.has(path.extname(name).toLowerCase());

const registerPath = (root) => path.join(root, REGISTER);
export const objectPath = (root, sha) => path.join(root, STORE, 'objects', sha.slice(0, 2), sha);

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Every register line, oldest first. Broken lines are marked. */
export function readRegister(root) {
  const p = registerPath(root);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch { out.push({ __broken: true, raw: line.slice(0, 120) }); }
  }
  return out;
}

/**
 * The holdings: per hash the entry plus its deletion tombstone, if there
 * is one. Append-only means both stand side by side — the tombstone does
 * not cancel the line, it completes it.
 */
export function holdings(root) {
  const byHash = new Map();
  for (const line of readRegister(root)) {
    if (line.__broken || !line.sha256) continue;
    if (line.deleted_at) {
      const v = byHash.get(line.sha256);
      if (v) { v.deleted_at = line.deleted_at; v.delete_reason = line.reason ?? null; }
      continue;
    }
    byHash.set(line.sha256, { ...line });
  }
  return [...byHash.values()].sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
}

/**
 * Take one artifact in.
 *
 * Text files pass redaction and are REJECTED on a hit rather than quietly
 * cleaned: bytes that were altered hash differently from what the user
 * actually produced — and then the audit trail proves the wrong thing.
 * Better to reject and name the spot.
 *
 * Redaction cannot read binaries. That is recorded as `checked: false`,
 * not passed over.
 */
export function put(root, source, {
  purpose = '', agent = null, project = null, session = null, entry_id = null,
  retention = null, large = false, now = new Date(),
} = {}) {
  if (!fs.existsSync(source)) throw new Error(`Not found: ${source}`);
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error(`Not a file: ${source}`);
  if (stat.size > LARGE_OVER_BYTES && !large) {
    throw new Error(
      `${(stat.size / 1048576).toFixed(1)} MB exceeds ${LARGE_OVER_BYTES / 1048576} MB. `
      + 'Allow it explicitly with --large — the bytes live on local disk rather than '
      + 'in the repo, but disk is finite too.',
    );
  }

  const data = fs.readFileSync(source);
  const name = path.basename(source);
  const hash = sha256(data);
  let checked = false;
  if (isText(name)) {
    const { found } = redaction.redact(data.toString('utf8'));
    if (found && found.length) {
      const kinds = [...new Set(found.map((h) => h.type ?? h))].join(', ');
      throw new Error(
        `Rejected: redaction found something in ${name} (${kinds}). `
        + 'Not cleaned silently — cleaned bytes would hash differently from what you '
        + 'produced, and the audit trail would prove the wrong thing. '
        + 'Fix the source and store it again.',
      );
    }
    checked = true;
  }

  const target = objectPath(root, hash);
  const already = fs.existsSync(target);
  if (!already) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }

  const line = {
    ts: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sha256: hash,
    name,
    size: stat.size,
    mime: mimeOf(name),
    // Whether the content WENT THROUGH redaction — not whether it is
    // clean. For binaries the honest answer is `false`.
    checked,
    purpose: String(purpose || ''),
    ...(agent ? { agent } : {}),
    ...(project ? { project } : {}),
    ...(session ? { session } : {}),
    ...(entry_id ? { entry_id } : {}),
    ...(retention ? { retention } : {}),
  };
  fs.mkdirSync(path.dirname(registerPath(root)), { recursive: true });
  fs.appendFileSync(registerPath(root), `${JSON.stringify(line)}\n`, 'utf8');
  return { ...line, already, at: path.relative(root, target) };
}

/**
 * Delete the bytes, keep the proof.
 *
 * This is exactly what "commit everything" cannot do: there, every
 * version stays in history forever. Here the bytes go and the register
 * line stays with its hash — still proving WHAT was there and that it is
 * gone, without being able to hand it over.
 */
export function remove(root, hash, { reason = '', now = new Date() } = {}) {
  const h = String(hash ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`Not a SHA-256: ${hash}`);
  const p = objectPath(root, h);
  const wasThere = fs.existsSync(p);
  if (wasThere) fs.rmSync(p);
  const line = {
    ts: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sha256: h,
    deleted_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    reason: String(reason || ''),
  };
  fs.appendFileSync(registerPath(root), `${JSON.stringify(line)}\n`, 'utf8');
  return { hash: h, bytesRemoved: wasThere };
}

/**
 * Check the register against the disk: what is missing, what changed,
 * what is lying there that nobody registered.
 *
 * The hash is why this works at all — without it an "audit trail" would
 * only be a claim about a file that may have changed since.
 */
export function verify(root) {
  const registered = holdings(root);
  const missing = [];
  const changed = [];
  for (const line of registered) {
    if (line.deleted_at) continue;
    const p = objectPath(root, line.sha256);
    if (!fs.existsSync(p)) { missing.push(line); continue; }
    if (sha256(fs.readFileSync(p)) !== line.sha256) changed.push(line);
  }
  // Orphaned bytes: present on disk, in no register. For an audit store
  // that is as much a finding as a missing file.
  const known = new Set(registered.map((l) => l.sha256));
  const orphans = [];
  const dir = path.join(root, STORE, 'objects');
  if (fs.existsSync(dir)) {
    for (const sub of fs.readdirSync(dir)) {
      const d = path.join(dir, sub);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) if (!known.has(f)) orphans.push(f);
    }
  }
  return {
    registered: registered.filter((l) => !l.deleted_at).length,
    deleted: registered.filter((l) => l.deleted_at).length,
    missing,
    changed,
    orphans,
    unchecked: registered.filter((l) => !l.deleted_at && !l.checked).length,
    bytes: registered.filter((l) => !l.deleted_at).reduce((n, l) => n + (l.size ?? 0), 0),
  };
}
