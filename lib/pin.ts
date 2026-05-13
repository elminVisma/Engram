/**
 * Pin / unpin / list pinned memories.
 *
 * A pinned memory is loaded at SessionStart for matching scope, regardless of
 * the prompt's semantic distance — the closest thing Engram has to "true memory."
 *
 * Pinning mutates `memory_tier` to 'pinned' and stores the previous tier in
 * `previous_tier`, so unpin can restore the original semantics.
 */

import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureSchema } from './migrate.ts';
import type { MemoryTier } from './utils.ts';

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ENGRAM_DIR, 'memory', 'memory.db');

export interface PinnedMemory {
  id: number;
  title: string;
  topic: string;
  chunk: string;
  pin_order: number;
  project_scope: string | null;
  previous_tier: MemoryTier | null;
}

function openDb(db?: DatabaseSync, dbPath: string = DB_PATH): { db: DatabaseSync; owned: boolean } {
  if (db) return { db, owned: false };
  const opened = new DatabaseSync(dbPath);
  ensureSchema(opened);
  return { db: opened, owned: true };
}

/**
 * Pin a memory so it loads at every SessionStart for matching scope.
 *
 * @param id          memory id
 * @param order       pin_order (lower number = injected first)
 * @param dbOrPath    optional db handle (tests) or path
 */
export function pin(id: number, order: number, dbOrPath?: DatabaseSync | string): void {
  const { db, owned } = typeof dbOrPath === 'string' || dbOrPath === undefined
    ? openDb(undefined, (dbOrPath as string) ?? DB_PATH)
    : openDb(dbOrPath);

  try {
    const row = db.prepare('SELECT memory_tier FROM memories WHERE id = ? AND is_active = 1')
      .get(id) as { memory_tier: MemoryTier } | undefined;
    if (!row) throw new Error(`memory ${id} not found or inactive`);
    if (row.memory_tier === 'pinned') {
      // Already pinned — just update the order
      db.prepare('UPDATE memories SET pin_order = ? WHERE id = ?').run(order, id);
      return;
    }

    db.prepare(
      `UPDATE memories
       SET previous_tier = memory_tier, memory_tier = 'pinned', pin_order = ?
       WHERE id = ?`
    ).run(order, id);
  } finally {
    if (owned) db.close();
  }
}

/**
 * Unpin a memory. Restores `memory_tier` to its previous value
 * (or 'short' if previous_tier was never set), clears pin_order.
 */
export function unpin(id: number, dbOrPath?: DatabaseSync | string): void {
  const { db, owned } = typeof dbOrPath === 'string' || dbOrPath === undefined
    ? openDb(undefined, (dbOrPath as string) ?? DB_PATH)
    : openDb(dbOrPath);

  try {
    const row = db.prepare('SELECT previous_tier, project_scope FROM memories WHERE id = ?')
      .get(id) as { previous_tier: MemoryTier | null; project_scope: string | null } | undefined;
    if (!row) throw new Error(`memory ${id} not found`);

    const restored: MemoryTier = row.previous_tier
      ?? (row.project_scope ? 'short' : 'long');

    db.prepare(
      `UPDATE memories
       SET memory_tier = ?, pin_order = NULL, previous_tier = NULL
       WHERE id = ?`
    ).run(restored, id);
  } finally {
    if (owned) db.close();
  }
}

/**
 * List pinned memories for a given project scope, ordered by pin_order.
 * Returns:
 *   - pins whose project_scope matches (or NULL — global pins)
 * Pass scope=null to get all pins regardless of scope.
 */
export function listPinned(
  scope: string | null,
  dbOrPath?: DatabaseSync | string,
): PinnedMemory[] {
  const { db, owned } = typeof dbOrPath === 'string' || dbOrPath === undefined
    ? openDb(undefined, (dbOrPath as string) ?? DB_PATH)
    : openDb(dbOrPath);

  try {
    const sql = scope === null
      ? `SELECT id, title, topic, chunk, pin_order, project_scope, previous_tier
         FROM memories
         WHERE memory_tier = 'pinned' AND is_active = 1
         ORDER BY pin_order ASC, id ASC`
      : `SELECT id, title, topic, chunk, pin_order, project_scope, previous_tier
         FROM memories
         WHERE memory_tier = 'pinned' AND is_active = 1
           AND (project_scope = ? OR project_scope IS NULL)
         ORDER BY pin_order ASC, id ASC`;

    const rows = scope === null
      ? db.prepare(sql).all() as PinnedMemory[]
      : db.prepare(sql).all(scope) as PinnedMemory[];

    return rows;
  } finally {
    if (owned) db.close();
  }
}
