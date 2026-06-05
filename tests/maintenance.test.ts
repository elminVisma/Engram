/**
 * Maintenance scheduling tests.
 *
 * The daemon's idle timeout (120m) is shorter than the maintenance interval (8h),
 * so a plain setInterval rarely fires. Instead we persist the last-run timestamp
 * and run "if due" at startup + on a short check timer. isMaintenanceDue is pure;
 * runMaintenanceIfDue is tested with injected deps (no Claude calls).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema, MIGRATIONS } from '../lib/migrate.ts';
import { isMaintenanceDue } from '../lib/utils.ts';
import { runMaintenanceIfDue, type MaintenanceDeps } from '../lib/maintenance.ts';
import { getMeta, setMeta } from '../lib/memory.ts';
import type { TierCapacity } from '../lib/utils.ts';

const HOUR = 3600_000;

describe('isMaintenanceDue', () => {
  it('is due when never run before (null)', () => {
    expect(isMaintenanceDue(null, 1_000_000, 8 * HOUR)).toBe(true);
  });
  it('is not due before the interval elapses', () => {
    const now = 100 * HOUR;
    expect(isMaintenanceDue(now - 7 * HOUR, now, 8 * HOUR)).toBe(false);
  });
  it('is due exactly at the interval', () => {
    const now = 100 * HOUR;
    expect(isMaintenanceDue(now - 8 * HOUR, now, 8 * HOUR)).toBe(true);
  });
});

// ─── meta persistence ─────────────────────────────────────────────────────────

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'engram-maint-'));
  dbPath = join(workDir, 'memory.db');
});
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe('getMeta / setMeta', () => {
  it('round-trips a value and returns null for missing keys', () => {
    const db = new DatabaseSync(dbPath); ensureSchema(db); db.close();
    expect(getMeta('last_maintenance_at', dbPath)).toBeNull();
    setMeta('last_maintenance_at', '12345', dbPath);
    expect(getMeta('last_maintenance_at', dbPath)).toBe('12345');
    setMeta('last_maintenance_at', '67890', dbPath); // upsert
    expect(getMeta('last_maintenance_at', dbPath)).toBe('67890');
  });
});

describe('migration v7 → v8', () => {
  it('adds the meta table without losing memories', () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL DEFAULT 0)');
    db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    for (const [, to, sql] of MIGRATIONS) {
      if (to > 7) break;
      db.exec(sql);
      db.prepare('UPDATE schema_version SET version = ?').run(to);
    }
    db.prepare("INSERT INTO memories (path, title, chunk) VALUES ('x.md','x','keep')").run();
    db.close();

    const db2 = new DatabaseSync(dbPath); ensureSchema(db2);
    const tables = (db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).toContain('meta');
    expect((db2.prepare("SELECT chunk FROM memories WHERE title='x'").get() as { chunk: string }).chunk).toBe('keep');
    db2.close();
  });
});

// ─── runMaintenanceIfDue ───────────────────────────────────────────────────────

function makeDeps(over: Partial<MaintenanceDeps> = {}): MaintenanceDeps & { calls: string[]; lastRunSet: number[] } {
  const calls: string[] = [];
  const lastRunSet: number[] = [];
  const flagged: TierCapacity[] = [
    { tier: 'provisional', count: 180, cap: 200, ratio: 0.9, atThreshold: true, over: false },
  ];
  return {
    calls,
    lastRunSet,
    now: () => 100 * HOUR,
    intervalMs: 8 * HOUR,
    getLastRun: () => null,
    setLastRun: (ms: number) => { lastRunSet.push(ms); },
    promote: () => { calls.push('promote'); return 1; },
    prune: async () => { calls.push('prune'); return { softDeleted: 2, hardDeleted: 0 }; },
    capacityFlags: () => { calls.push('capacity'); return flagged; },
    consolidate: async (tier) => { calls.push(`consolidate:${tier}`); return { merged: 1, archived: 3 }; },
    ...over,
  };
}

describe('runMaintenanceIfDue', () => {
  it('runs the full pass when due and records the run timestamp', async () => {
    const deps = makeDeps();
    const res = await runMaintenanceIfDue(deps);
    expect(res.ran).toBe(true);
    expect(deps.calls).toEqual(['promote', 'prune', 'capacity', 'consolidate:provisional']);
    expect(res.consolidated).toEqual([{ tier: 'provisional', merged: 1, archived: 3 }]);
    expect(deps.lastRunSet).toEqual([100 * HOUR]);
  });

  it('does nothing when not due', async () => {
    const deps = makeDeps({ getLastRun: () => 100 * HOUR - 7 * HOUR });
    const res = await runMaintenanceIfDue(deps);
    expect(res.ran).toBe(false);
    expect(deps.calls).toEqual([]);
    expect(deps.lastRunSet).toEqual([]);
  });

  it('skips consolidation when no consolidate dep is provided (auto-consolidate off)', async () => {
    const deps = makeDeps({ consolidate: undefined });
    const res = await runMaintenanceIfDue(deps);
    expect(res.ran).toBe(true);
    expect(deps.calls).toEqual(['promote', 'prune']);
    expect(res.consolidated).toEqual([]);
  });
});
