/**
 * DB snapshot + rollback.
 *
 * Every automated maintenance pass (consolidate, prune) takes a snapshot first
 * so it is reversible. A snapshot is a consistent single-file copy of the DB
 * produced with `VACUUM INTO` — safe even while the source DB is in WAL mode.
 *
 * Snapshots live under memory/snapshots/ as `<sortableId>.db`. The id is
 * `<epochMillis>-<seq>` with a zero-padded sequence so lexical sort == newest
 * first within a process, and epoch-millis ordering across processes.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, copyFileSync, rmSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ENGRAM_DIR, 'memory', 'memory.db');
export const SNAPSHOT_DIR = join(ENGRAM_DIR, 'memory', 'snapshots');

export const DEFAULT_RETENTION = parseInt(process.env.ENGRAM_SNAPSHOT_RETENTION ?? '10', 10);

export interface SnapshotInfo {
  id: string;
  path: string;
  createdAt: number;
  bytes: number;
}

export interface SnapshotOptions {
  dbPath?: string;
  snapshotDir?: string;
  /** Keep only the last N snapshots after this one. Default DEFAULT_RETENTION. */
  retention?: number;
}

// Module-level monotonic sequence so two snapshots in the same millisecond
// still get distinct, correctly-ordered ids within a single process.
let seq = 0;

function toSqlitePath(p: string): string {
  // SQLite SQL string literal — forward slashes work on every platform.
  return p.split('\\').join('/');
}

/** Take a consistent snapshot of the DB. Returns the new snapshot's id + path. */
export function snapshot(opts: SnapshotOptions = {}): SnapshotInfo {
  const dbPath = opts.dbPath ?? DB_PATH;
  const dir = opts.snapshotDir ?? SNAPSHOT_DIR;
  const retention = opts.retention ?? DEFAULT_RETENTION;

  if (!existsSync(dbPath)) throw new Error(`cannot snapshot — DB not found at ${dbPath}`);

  mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${String(seq++).padStart(6, '0')}`;
  const dest = join(dir, `${id}.db`);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`VACUUM INTO '${toSqlitePath(dest)}'`);
  } finally {
    db.close();
  }

  pruneRetention(dir, retention);

  const st = statSync(dest);
  return { id, path: dest, createdAt: st.mtimeMs, bytes: st.size };
}

/** List snapshots, newest first. */
export function listSnapshots(opts: { snapshotDir?: string } = {}): SnapshotInfo[] {
  const dir = opts.snapshotDir ?? SNAPSHOT_DIR;
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const path = join(dir, f);
      const st = statSync(path);
      return { id: f.replace(/\.db$/, ''), path, createdAt: st.mtimeMs, bytes: st.size };
    })
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Restore the DB from a snapshot id. Atomic from the reader's perspective:
 * copies the snapshot file over the live DB and clears any stale WAL/SHM
 * sidecars so the restored file is authoritative. Throws if id is unknown.
 */
export function restore(id: string, opts: { dbPath?: string; snapshotDir?: string } = {}): void {
  const dbPath = opts.dbPath ?? DB_PATH;
  const dir = opts.snapshotDir ?? SNAPSHOT_DIR;
  const src = join(dir, `${id}.db`);

  if (!existsSync(src)) throw new Error(`snapshot '${id}' not found in ${dir}`);

  copyFileSync(src, dbPath);
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
}

/** Delete all but the newest `keep` snapshots. */
export function pruneRetention(dir: string, keep: number): number {
  if (keep <= 0) return 0;
  const all = listSnapshots({ snapshotDir: dir });
  const stale = all.slice(keep);
  for (const s of stale) rmSync(s.path, { force: true });
  return stale.length;
}
