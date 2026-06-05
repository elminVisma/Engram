/**
 * Schema migration logic for the Engram DB.
 * Imported by lib/memory.ts (called on every DB open) and scripts/migrate.ts.
 * Do NOT import from scripts/ here — that would be circular.
 */

import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_VERSION = 7;

// Each migration: [fromVersion, toVersion, sql]
export const MIGRATIONS: [number, number, string][] = [
  [0, 1, `
    CREATE TABLE IF NOT EXISTS memories (
      id              INTEGER PRIMARY KEY,
      path            TEXT NOT NULL,
      title           TEXT,
      tags            TEXT,
      topic           TEXT,
      chunk           TEXT NOT NULL,
      session_id      TEXT,
      source_excerpt  TEXT,
      created_at      INTEGER DEFAULT (unixepoch()),
      supersedes      INTEGER,
      superseded_by   INTEGER,
      is_active       INTEGER DEFAULT 1
    );
  `],
  [1, 2, `
    ALTER TABLE memories ADD COLUMN memory_tier     TEXT DEFAULT 'short';
    ALTER TABLE memories ADD COLUMN project_scope   TEXT;
    ALTER TABLE memories ADD COLUMN confidence      REAL DEFAULT 1.0;
    ALTER TABLE memories ADD COLUMN decay_rate      REAL DEFAULT 0.02;
    ALTER TABLE memories ADD COLUMN access_count    INTEGER DEFAULT 0;
    ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER;
  `],
  [2, 3, `
    ALTER TABLE memories ADD COLUMN file_hash TEXT;
  `],
  [3, 4, `
    ALTER TABLE memories ADD COLUMN embedding BLOB;
  `],
  // Phase 0 of the true-memory overhaul: pinned/user/shared/provisional tiers,
  // pin_order for SessionStart-injected pins, scope_group for cross-project shared tier,
  // and an index to keep tier+scope filters cheap.
  [4, 5, `
    ALTER TABLE memories ADD COLUMN pin_order     INTEGER;
    ALTER TABLE memories ADD COLUMN scope_group   TEXT;
    ALTER TABLE memories ADD COLUMN previous_tier TEXT;
    CREATE INDEX IF NOT EXISTS idx_memories_tier_scope
      ON memories (memory_tier, project_scope);
  `],
  // Recall quality signal: counts how many times this memory was referenced
  // in a Claude response after being injected. Used by scripts/stats.ts to
  // surface injection effectiveness.
  [5, 6, `
    ALTER TABLE memories ADD COLUMN recall_hit INTEGER NOT NULL DEFAULT 0;
  `],
  // Consolidation: merging related high-value memories into a denser survivor.
  // archived_at marks when a memory was consolidated away (distinct from prune's
  // is_active=0); consolidated_into points at the surviving memory's id.
  [6, 7, `
    ALTER TABLE memories ADD COLUMN archived_at      INTEGER;
    ALTER TABLE memories ADD COLUMN consolidated_into INTEGER;
  `],
];

export function ensureSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0);`);
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();

  let version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;

  for (const [from, to, sql] of MIGRATIONS) {
    if (version === from) {
      try {
        db.exec(sql);
        db.prepare('UPDATE schema_version SET version = ?').run(to);
        version = to;
        process.stderr.write(`[Engram] migrated schema v${from} → v${to}\n`);
        if (from === 3) {
          process.stderr.write('[Engram] Schema v4: embeddings moved to memories table. Run npm run reindex to rebuild.\n');
        }
      } catch (e: unknown) {
        // Column already exists errors are OK (idempotent)
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
        db.prepare('UPDATE schema_version SET version = ?').run(to);
        version = to;
      }
    }
  }

  // Clean up the old sqlite-vec virtual table if it exists
  try { db.exec('DROP TABLE IF EXISTS memory_embeddings'); } catch { /* ignore */ }
}
