/**
 * store — sqlite-vec wrapper.
 *
 * One file: `.mem/vectors.db`. Two tables:
 *   entries  metadata (source_file, line_number, jsonl_id, ts, text, provider, model)
 *   vecs     a sqlite-vec vec0 virtual table holding float[<dim>]
 *
 * **The import is lazy.** better-sqlite3 and sqlite-vec are optional
 * dependencies: anyone who does not use semantic search never installs
 * them, and cheap-mem keeps working without them. That matters — a
 * native build is the most common way a Node tool fails to install.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as memory from '../memory.mjs';

export const DB_PATH = path.join('.mem', 'vectors.db');

/**
 * The cached LOAD, not the loaded values.
 *
 * This used to cache `_sqlite` and `_vec` separately, and the guard read
 * `if (_sqlite) return { sqlite: _sqlite, vec: _vec }`. Between the two
 * awaits there is a window where `_sqlite` is set and `_vec` is still
 * null — a second caller arriving in that window got a `vec` of null and
 * failed somewhere else entirely, with an error naming the wrong thing.
 *
 * Found by the linter (`require-atomic-updates`) on its first run over
 * this file, 2026-09-08. Caching the promise removes the window
 * completely: everyone waits on the same load and nobody sees a half
 * one.
 */
let _laden = null;

async function loadSqliteVec() {
  if (_laden) return _laden;
  _laden = (async () => {
  try {
    const sqlite = (await import('better-sqlite3')).default;
    const vec = await import('sqlite-vec');
    return { sqlite, vec };
  } catch (e) {
    throw new Error(
      'sqlite-vec: better-sqlite3 and sqlite-vec are not installed.\n'
      + '  npm install better-sqlite3 sqlite-vec\n'
      + '  (Optional dependencies, needed only for semantic search.)\n'
      + `Original error: ${e.message}`);
  }
  })();
  // Ein gescheiterter Ladeversuch darf nicht fuer immer gecacht bleiben:
  // wer die optionalen Pakete NACHtraeglich installiert, soll nicht den
  // Prozess neu starten muessen.
  _laden.catch(() => { _laden = null; });
  return _laden;
}

/**
 * Open (or create) the database. The schema is set idempotently.
 * `dim` fixes the vector dimension and must match the provider config.
 */
export async function open(root, dim) {
  const { sqlite, vec } = await loadSqliteVec();
  const p = path.join(root, DB_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const db = new sqlite(p);
  vec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      source_file TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      jsonl_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      text TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      UNIQUE(source_file, line_number, jsonl_id)
    );
    CREATE INDEX IF NOT EXISTS idx_entries_jsonl_id ON entries(jsonl_id);
    CREATE INDEX IF NOT EXISTS idx_entries_source_line ON entries(source_file, line_number);
  `);

  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vecs'").get();

  if (!exists) {
    db.exec(`
      CREATE VIRTUAL TABLE vecs USING vec0(
        entry_id INTEGER PRIMARY KEY,
        embedding FLOAT[${dim}]
      );
    `);
  } else {
    // A database built for another provider has a different dimension.
    // sqlite-vec offers no introspection for it, so we probe with a
    // dry insert. Less elegant than reading the schema, but it fails
    // here with a clear message instead of months later as bad results.
    try {
      const probe = new Float32Array(dim).fill(0);
      db.prepare('INSERT INTO vecs(entry_id, embedding) VALUES (?, ?)')
        .run(-1, Buffer.from(probe.buffer));
      db.prepare('DELETE FROM vecs WHERE entry_id = ?').run(-1);
    } catch (e) {
      db.close();
      throw new Error(
        `sqlite-vec: the existing ${DB_PATH} does not match the current provider `
        + `dimension (dim=${dim}).\n`
        + `Fix: delete ${DB_PATH} and run 'mem embed backfill --force'.\n`
        + `Original error: ${e.message}`);
    }
  }

  return db;
}

/** Store one entry. Idempotent through the UNIQUE constraint. */
export function save(db, { sourceFile, lineNumber, jsonlId, ts, text, provider, model, vector }) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO entries
      (source_file, line_number, jsonl_id, ts, text, provider, model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);
  const { id } = insert.get(sourceFile, lineNumber, jsonlId, ts, text, provider, model);

  // vec0 has no UPSERT, so delete then insert.
  db.prepare('DELETE FROM vecs WHERE entry_id = ?').run(id);
  db.prepare('INSERT INTO vecs(entry_id, embedding) VALUES (?, ?)')
    .run(id, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));

  return id;
}

/** Top-K semantic search. Returns metadata plus a `score` in (0,1]. */
export function search(db, vector, { top = 5, type = null, project = null, since = null } = {}) {
  const where = [];
  const params = {};
  if (type) {
    where.push('source_file LIKE @type');
    params.type = `%/${memory.TYPES[type] ?? `${type}.jsonl`}`;
  }
  if (project !== null && project !== undefined) {
    if (project === 'global') {
      where.push("source_file LIKE 'global/%'");
    } else {
      where.push('source_file LIKE @project');
      params.project = `projects/${project}/%`;
    }
  }
  if (since) {
    where.push('ts >= @since');
    params.since = since instanceof Date ? since.toISOString() : String(since);
  }
  const filter = where.length ? `AND ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT e.id, e.source_file, e.line_number, e.jsonl_id, e.ts,
           e.text, e.provider, e.model, v.distance
    FROM vecs v
    JOIN entries e ON e.id = v.entry_id
    WHERE v.embedding MATCH @vec AND k = @top
    ${filter}
    ORDER BY v.distance
    LIMIT @top
  `).all({
    ...params,
    vec: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    top,
  });

  return rows.map((r) => ({
    ...r,
    // vec0 returns L2 distance; 1/(1+d) maps it into (0,1]. Monotonic,
    // so the ranking is right, but it is NOT cosine similarity — do not
    // compare these numbers with the BM25 scores from `mem find`.
    score: 1 / (1 + r.distance),
  }));
}

/** Is this entry already embedded? For the backfill. */
export function exists(db, sourceFile, lineNumber, jsonlId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM entries WHERE source_file = ? AND line_number = ? AND jsonl_id = ? LIMIT 1
  `).get(sourceFile, lineNumber, jsonlId));
}

export function count(db) {
  return db.prepare('SELECT COUNT(*) as n FROM entries').get().n;
}

export function deleteDb(root) {
  const p = path.join(root, DB_PATH);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
