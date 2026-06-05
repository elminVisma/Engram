/**
 * Snapshot + rollback tests.
 *
 * Every automated maintenance pass (consolidate, prune) must be reversible.
 * snapshot() captures a consistent single-file copy of the DB; restore() swaps
 * it back; retention keeps only the last N snapshots.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema } from '../lib/migrate.ts';
import { snapshot, listSnapshots, restore } from '../lib/snapshot.ts';
import { handleListSnapshots, handleRestoreSnapshot } from '../mcp/handlers.ts';
import type { SnapshotInfo } from '../lib/snapshot.ts';

let workDir: string;
let dbPath: string;
let snapshotDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'engram-snap-'));
  dbPath = join(workDir, 'memory.db');
  snapshotDir = join(workDir, 'snapshots');
});

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

function seedDb(): void {
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.prepare("INSERT INTO memories (path, title, chunk) VALUES ('a.md', 'a', 'first')").run();
  db.prepare("INSERT INTO memories (path, title, chunk) VALUES ('b.md', 'b', 'second')").run();
  db.close();
}

function rowCount(): number {
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
  db.close();
  return n;
}

describe('snapshot + restore', () => {
  it('round-trips: snapshot, mutate, restore brings the row count back', () => {
    seedDb();
    expect(rowCount()).toBe(2);

    const { id } = snapshot({ dbPath, snapshotDir });
    expect(id).toBeTruthy();

    const db = new DatabaseSync(dbPath);
    ensureSchema(db);
    db.prepare("INSERT INTO memories (path, title, chunk) VALUES ('c.md', 'c', 'third')").run();
    db.close();
    expect(rowCount()).toBe(3);

    restore(id, { dbPath, snapshotDir });
    expect(rowCount()).toBe(2);
  });

  it('lists the snapshot it just created', () => {
    seedDb();
    const { id } = snapshot({ dbPath, snapshotDir });
    const list = listSnapshots({ snapshotDir });
    expect(list.map(s => s.id)).toContain(id);
  });

  it('restore of an unknown id throws and does not mutate the DB', () => {
    seedDb();
    snapshot({ dbPath, snapshotDir });
    const db = new DatabaseSync(dbPath);
    ensureSchema(db);
    db.prepare("INSERT INTO memories (path, title, chunk) VALUES ('c.md', 'c', 'third')").run();
    db.close();
    expect(rowCount()).toBe(3);

    expect(() => restore('does-not-exist', { dbPath, snapshotDir })).toThrow();
    expect(rowCount()).toBe(3);
  });

  it('retention keeps only the last N snapshots', () => {
    seedDb();
    for (let i = 0; i < 5; i++) snapshot({ dbPath, snapshotDir, retention: 3 });
    expect(listSnapshots({ snapshotDir }).length).toBe(3);
  });

  it('listSnapshots returns newest first', () => {
    seedDb();
    const a = snapshot({ dbPath, snapshotDir }).id;
    const b = snapshot({ dbPath, snapshotDir }).id;
    const list = listSnapshots({ snapshotDir });
    expect(list[0].id).toBe(b);
    expect(list[1].id).toBe(a);
  });
});

describe('snapshot MCP handlers', () => {
  it('handleListSnapshots returns the snapshots from its dep', async () => {
    const fake: SnapshotInfo[] = [{ id: 'x', path: 'p', createdAt: 1, bytes: 2 }];
    const res = await handleListSnapshots({ listSnapshots: () => fake });
    expect(res.ok).toBe(true);
    expect(res.snapshots).toEqual(fake);
  });

  it('handleRestoreSnapshot rejects an empty id without calling restore', async () => {
    let restored = false;
    const res = await handleRestoreSnapshot(
      { id: '' },
      { restore: () => { restored = true; }, snapshot: () => ({ id: 's', path: 'p', createdAt: 0, bytes: 0 }) },
    );
    expect(res.ok).toBe(false);
    expect(restored).toBe(false);
  });

  it('handleRestoreSnapshot takes a safety snapshot before restoring', async () => {
    const calls: string[] = [];
    const res = await handleRestoreSnapshot(
      { id: 'target' },
      {
        restore: () => calls.push('restore'),
        snapshot: () => { calls.push('snapshot'); return { id: 'safety', path: 'p', createdAt: 0, bytes: 0 }; },
      },
    );
    expect(res.ok).toBe(true);
    expect(res.safetySnapshot).toBe('safety');
    expect(calls).toEqual(['snapshot', 'restore']);
  });
});
