// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
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
import { appendLine } from './append.mjs';
import { cutMasked } from './outputguard.mjs';

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
    catch { out.push({ __broken: true, raw: cutMasked(line, 120) }); }
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
 * The folders the MCP bridge may read a file from (V2b, 2026-10-11).
 *
 * `mem_store_put` took ANY path the server could read: a connected agent
 * could have `/etc/...`, a key file or another project's database hashed and
 * kept in the store. The bridge now reads only from an intake folder:
 * `<root>/store/intake`, plus the folders the operator names in
 * `CHEAP_MEM_STORE_INTAKE` (a path-delimited list, `:` or `;`). The CLI
 * (`mem store put <path>`) is a person at a keyboard and keeps reading any
 * path.
 */
export const INTAKE_ENV = 'CHEAP_MEM_STORE_INTAKE';
const intakeEntries = (env) => String(env[INTAKE_ENV] ?? '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);

/**
 * `CHEAP_MEM_STORE_INTAKE` takes ABSOLUTE paths only: a relative entry would
 * mean a different folder for every process working directory, so it is
 * ignored (and named in the refusal). `/` as an entry opens everything; that
 * is the operator's decision, not the bridge's.
 */
export function intakeDirs(root, env = process.env) {
  return [path.join(root, STORE, 'intake'), ...intakeEntries(env).filter((d) => path.isAbsolute(d)).map((d) => path.resolve(d))];
}
const ignoredIntake = (env = process.env) => intakeEntries(env).filter((d) => !path.isAbsolute(d));

/**
 * The real path of `source` when it lies inside an intake folder, else a
 * refusal that does not say whether the path exists. Symlinks are resolved
 * on both sides (`realpath`), so a link inside the folder that points out of
 * it is outside; the path is compared by whole segments (`/a/in` is not
 * inside `/a/in-evil`). Returns the real path: read THAT, not the link.
 */
export function intakeFile(root, source, env = process.env) {
  const refuse = () => new Error(
    `Not in an intake folder: the bridge reads files only from ${path.join(STORE, 'intake')} under the memory root`
    + `${String(env[INTAKE_ENV] ?? '').trim() ? ' or the folders in CHEAP_MEM_STORE_INTAKE' : ' (the operator can add folders with CHEAP_MEM_STORE_INTAKE)'}. `
    + `${ignoredIntake(env).length ? ` Ignored (a relative path; the list takes absolute paths only): ${ignoredIntake(env).join(', ')}.` : ''} `
    + 'Put the file there, or ask a person to run `mem store put <path>`. Nothing was stored.');
  let real;
  try { real = fs.realpathSync(String(source)); } catch { throw refuse(); }
  for (const dir of intakeDirs(root, env)) {
    let base;
    try { base = fs.realpathSync(dir); } catch { continue; }
    const rel = path.relative(base, real);
    if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return real;
  }
  throw refuse();
}

/** Reads a descriptor to its end; `null` when it holds more than `max` bytes. */
function readBounded(fd, max) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.allocUnsafe(1 << 20);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > max) return null;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks, total);
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
  retention = null, large = false, noFollow = false, now = new Date(),
} = {}) {
  // The bytes are read from ONE open descriptor, and size and limit come from those bytes, not from stat
  // (a /proc file says 0). `noFollow` (the bridge): the last component must not be a link (O_NOFOLLOW) and
  // the path must still be its own real path after the read, so a link swapped in between the intake check
  // and the read - in the file or in a folder above it - is refused instead of followed.
  let before;
  try { before = noFollow ? fs.lstatSync(source) : fs.statSync(source); } catch { throw new Error(`Not found: ${source}`); }
  if (noFollow && before.isSymbolicLink()) throw new Error(`Refused: ${path.basename(source)} is a symbolic link.`);
  if (!before.isFile()) throw new Error(`Not a file: ${source}`);
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (noFollow ? (fs.constants.O_NOFOLLOW ?? 0) : 0));
  let data;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`Not a file: ${source}`);
    data = readBounded(fd, large ? Infinity : LARGE_OVER_BYTES);
  } catch (e) {
    if (e.code === 'ELOOP') throw new Error(`Refused: ${path.basename(source)} is a symbolic link.`);
    throw e;
  } finally { fs.closeSync(fd); }
  if (noFollow) {
    let now2 = null;
    try { now2 = fs.realpathSync(source); } catch { /* gone */ }
    if (now2 !== source) throw new Error('Refused: the path changed while it was read (a link was put in its place).');
  }
  if (data === null) {
    throw new Error(
      `The file exceeds ${LARGE_OVER_BYTES / 1048576} MB. `
      + 'Allow it explicitly with --large — the bytes live on local disk rather than '
      + 'in the repo, but disk is finite too.',
    );
  }
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
    size: data.length,
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
  appendLine(registerPath(root), `${JSON.stringify(line)}\n`);
  return { ...line, already, at: path.relative(root, target).split(path.sep).join('/') };
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
  appendLine(registerPath(root), `${JSON.stringify(line)}\n`);
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
