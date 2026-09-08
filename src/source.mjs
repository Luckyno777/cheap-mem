/**
 * Sources — pointers at knowledge that already exists, indexed rather
 * than copied.
 *
 * **The design, and what it deliberately is not.** A company's
 * knowledge is already somewhere: drives, wikis, mailboxes. The
 * cheapest entrance is a BORING one — a pointer plus a searchable
 * excerpt. No connectors, no fetching, no synchronising.
 *
 *   - **Nothing is fetched.** This file opens no network connection. A
 *     memory that dereferences addresses is a crawler, and what it
 *     collects on the way nobody has read.
 *   - **A local file goes into the store** (content-addressed); the
 *     entry carries only the hash. The corpus stays text.
 *   - **The excerpt is capped** (see MAX_EXCERPT). Without a cap a
 *     40 MB PDF would drag the whole index down, and every search
 *     afterwards would answer with that one document.
 *   - **The excerpt goes through redaction.** A foreign document is
 *     exactly where a credential rides along. The CLI write path does
 *     not redact otherwise — here it does, before anything is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as store from './store.mjs';
import * as redaction from './redaction.mjs';

export const TYPE = 'source';

/**
 * How much text at most travels into the entry.
 *
 * 4000 characters is roughly two pages — enough for search to find the
 * document by its own words, little enough that a hundred sources do
 * not tip the index. Anyone who needs more fetches the file from the
 * store; the pointer to it is in the entry.
 */
export const MAX_EXCERPT = 4000;

/** The kinds. Closed, so `mem sources --kind` carries meaning. */
export const KINDS = Object.freeze({
  file: 'a local file — held content-addressed in the store',
  address: 'a URL — the pointer only, nothing is fetched',
});

/** Does this look like an address? Deliberately narrow: http(s), nothing else. */
export function isAddress(what) {
  return /^https?:\/\/\S+$/i.test(String(what ?? '').trim());
}

/**
 * An excerpt from a text file — capped and redacted.
 *
 * Returns `{ text, truncated, findings }`. `findings` says WHAT was
 * redacted (not which value); a silent redaction would be worse than
 * none, because nobody looks and the excerpt still differs from the
 * document.
 */
export function excerpt(content, { max = MAX_EXCERPT } = {}) {
  const raw = String(content ?? '');
  const truncated = raw.length > max;
  const cut = truncated ? raw.slice(0, max) : raw;
  const { object, found } = redaction.redactEntry({ text: cut });
  return { text: object.text, truncated, findings: found };
}

/**
 * Take a source in.
 *
 * Throws if redaction itself is out of order — then NOTHING is written.
 * A filter you cannot tell is running is worse than a refusal.
 */
export function take(root, what, {
  title = null, tags = null, project = null, agent = null,
  note = null, max = MAX_EXCERPT,
} = {}) {
  const selfTest = redaction.selfTest();
  if (!selfTest.ok) {
    throw new Error('Redaction out of order — no source is taken in.');
  }
  const target = String(what ?? '').trim();
  if (!target) throw new Error('source: without an address or a path there is nothing to do');

  const data = { title: title ?? null, tags: tags ?? undefined, agent: agent ?? undefined };
  let findings = [];

  if (isAddress(target)) {
    // Fetch nothing. The excerpt, if any, comes from the caller.
    data.kind = 'address';
    data.address = target;
    data.title = data.title ?? target;
    if (note) {
      const a = excerpt(note, { max });
      data.excerpt = a.text;
      findings = a.findings;
    }
  } else {
    const p = path.resolve(target);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error(`source: '${target}' is neither an http(s) address nor a file`);
    }
    const put = store.put(root, p, { agent: agent ?? undefined });
    data.kind = 'file';
    data.hash = put.sha256;
    data.filename = path.basename(p);
    data.bytes = fs.statSync(p).size;
    data.title = data.title ?? path.basename(p);
    // Only text gets excerpted. A PDF or an image as byte soup in the
    // index is noise that makes every search worse.
    if (store.isText(p)) {
      const a = excerpt(fs.readFileSync(p, 'utf8'), { max });
      data.excerpt = a.text;
      data.truncated = a.truncated || undefined;
      findings = a.findings;
    } else if (note) {
      const a = excerpt(note, { max });
      data.excerpt = a.text;
      findings = a.findings;
    }
  }

  const { path: p, entry } = memory.logEntry(root, TYPE, data, { project });
  return { path: p, entry, findings };
}

/** All sources, newest first. Retired ones stay out. */
export function all(root, { project = undefined, kind = null } = {}) {
  const projects = project === undefined ? [null, ...memory.listProjects(root)] : [project];
  const out = [];
  for (const p of projects) {
    let res;
    try { res = memory.readLog(root, TYPE, { project: p }); } catch { continue; }
    const retired = memory.retiredMap(res.entries);
    for (const e of res.entries) {
      if (e.__broken || !e.id || retired.has(e.id) || memory.isClosingLine(e)) continue;
      if (kind && e.kind !== kind) continue;
      out.push({ ...e, _project: p });
    }
  }
  out.reverse();
  return out;
}

/** One line per source. */
export function line(e) {
  const where = e.kind === 'address' ? e.address : `store:${String(e.hash ?? '?').slice(0, 12)}`;
  return `${String(e.kind ?? '?').padEnd(8)} ${String(e.id).padEnd(14)} `
    + `${String(e.title ?? '').slice(0, 50).padEnd(50)} ${where}`;
}
