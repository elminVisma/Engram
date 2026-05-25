/**
 * Phase 7 — End-to-end + migration tests.
 *
 * E2E: full save → search → inject pipeline across all tiers.
 *   Uses real in-process DB + mocked embedder (no daemon HTTP needed).
 *   Covers multi-tier scope filtering, provisional promotion, multiSearch
 *   deduplication, and injection threshold annotation.
 *
 * Migration: verifies ensureSchema migrates pre-Phase-0 DBs to v5 without
 *   data loss. Tests v0 (fresh), v2 (has data, no embedding column), and
 *   v4 → v5 (adds pin_order / scope_group / previous_tier).
 *
 * Perf budget: multiSearch completes within 200ms on a warm (already-loaded)
 *   model, measured against a 50-row DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema, CURRENT_VERSION } from '../lib/migrate.ts';
import { serialize } from '../lib/utils.ts';

// ─── Deterministic embedder (same registry as integration tests) ──────────────

const REGISTRY: Record<string, number[]> = {
  'jwt-base':   [1, 0, 0, 0],
  'jwt-near':   [0.999, 0.045, 0, 0],
  'ws-base':    [0, 1, 0, 0],
  'react-base': [0, 0, 1, 0],
  'auth-query': [0.98, 0.2, 0, 0],   // close to jwt cluster
};

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map(x => x / n);
}

function embedFor(text: string): Float32Array {
  if (text in REGISTRY) return new Float32Array(normalize(REGISTRY[text]));
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  const v = [
    ((h & 0xff) / 255) - 0.5,
    (((h >> 8) & 0xff) / 255) - 0.5,
    (((h >> 16) & 0xff) / 255) - 0.5,
    (((h >> 24) & 0xff) / 255) - 0.5,
  ];
  return new Float32Array(normalize(v));
}

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => async (text: string) => ({ data: embedFor(text) })),
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

let workDir: string;
let dbPath: string;
let rawDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'engram-e2e-'));
  dbPath = join(workDir, 'memory.db');
  rawDir = join(workDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
});

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  return db;
}

function seed(
  db: DatabaseSync,
  args: {
    title: string;
    embedKey: string;
    tier?: string;
    projectScope?: string | null;
    accessCount?: number;
    isActive?: number;
    confidence?: number;
  },
): number {
  const v = serialize(Array.from(embedFor(args.embedKey)));
  const result = db.prepare(`
    INSERT INTO memories
      (path, title, tags, topic, chunk, memory_tier, project_scope,
       confidence, decay_rate, access_count, is_active, embedding)
    VALUES (?, ?, 'test', 'test', ?, ?, ?, ?, 0.02, ?, ?, ?)
  `).run(
    `${args.title}.md`, args.title, args.title,
    args.tier ?? 'short', args.projectScope ?? null,
    args.confidence ?? 1.0, args.accessCount ?? 0, args.isActive ?? 1, v,
  );
  return Number(result.lastInsertRowid);
}

// ─── E2E: Full save → search pipeline ────────────────────────────────────────

describe('E2E: saveMemory → search', () => {
  it('saved memory is returned by a semantically similar query', async () => {
    const { saveMemory, search } = await import('../lib/memory.ts');
    openTestDb().close();

    await saveMemory('JWT auth flow', 'auth', 'jwt-base', {
      tier: 'short', projectScope: 'repo-A', dbPath, rawDir,
    });

    const results = await search('jwt-near', 5, 'repo-A', dbPath);
    expect(results.map(r => r.title)).toContain('JWT auth flow');
    expect(results[0].distance).toBeLessThan(0.05);
  });

  it('provisional memories are included in search results', async () => {
    const { saveMemory, search } = await import('../lib/memory.ts');
    openTestDb().close();

    await saveMemory('Provisional note', 'misc', 'jwt-base', {
      tier: 'provisional', projectScope: 'repo-A', dbPath, rawDir,
    });

    const results = await search('jwt-near', 5, 'repo-A', dbPath);
    expect(results.some(r => r.title === 'Provisional note')).toBe(true);
    expect(results.find(r => r.title === 'Provisional note')!.memory_tier).toBe('provisional');
  });

  it('user-tier memories surface across different project scopes', async () => {
    const { saveMemory, search } = await import('../lib/memory.ts');
    openTestDb().close();

    await saveMemory('User preference', 'style', 'jwt-base', {
      tier: 'user', projectScope: null, dbPath, rawDir,
    });

    // Different scope — user memory should still appear
    const results = await search('jwt-near', 5, 'repo-other', dbPath);
    expect(results.some(r => r.title === 'User preference')).toBe(true);
  });

  it('short-tier memories do NOT surface in a different project scope', async () => {
    const { saveMemory, search } = await import('../lib/memory.ts');
    openTestDb().close();

    await saveMemory('Scoped note', 'misc', 'jwt-base', {
      tier: 'short', projectScope: 'repo-A', dbPath, rawDir,
    });

    const results = await search('jwt-near', 5, 'repo-B', dbPath);
    expect(results.some(r => r.title === 'Scoped note')).toBe(false);
  });

  it('search increments access_count on matched memories', async () => {
    const { saveMemory, search } = await import('../lib/memory.ts');
    openTestDb().close();

    await saveMemory('Access tracked', 'misc', 'jwt-base', {
      tier: 'short', projectScope: null, dbPath, rawDir,
    });

    await search('jwt-near', 5, null, dbPath);
    await search('jwt-near', 5, null, dbPath);

    const db = new DatabaseSync(dbPath);
    const row = db.prepare(`SELECT access_count FROM memories WHERE title = ?`).get('Access tracked') as { access_count: number };
    db.close();
    expect(row.access_count).toBe(2);
  });
});

// ─── E2E: Provisional → short promotion pipeline ─────────────────────────────

describe('E2E: provisional promotion pipeline', () => {
  it('provisional memory is promoted to short after threshold accesses', async () => {
    const { promoteProvisional } = await import('../lib/memory.ts');
    const db = openTestDb();
    const id = seed(db, { title: 'earned-it', embedKey: 'jwt-base', tier: 'provisional', accessCount: 10 });
    db.close();

    const promoted = promoteProvisional(dbPath, 10);
    expect(promoted).toBe(1);

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare(`SELECT memory_tier, previous_tier FROM memories WHERE id = ?`).get(id) as
      { memory_tier: string; previous_tier: string };
    db2.close();
    expect(row.memory_tier).toBe('short');
    expect(row.previous_tier).toBe('provisional');
  });

  it('full cycle: save provisional → access via search → promote', async () => {
    const { saveMemory, search, promoteProvisional, PROMOTE_ACCESS_THRESHOLD } = await import('../lib/memory.ts');
    openTestDb().close();

    await saveMemory('Cycle test', 'misc', 'jwt-base', {
      tier: 'provisional', projectScope: null, dbPath, rawDir,
    });

    // Simulate enough searches to reach threshold
    for (let i = 0; i < PROMOTE_ACCESS_THRESHOLD; i++) {
      await search('jwt-near', 5, null, dbPath);
    }

    const promoted = promoteProvisional(dbPath, PROMOTE_ACCESS_THRESHOLD);
    expect(promoted).toBe(1);

    const db = new DatabaseSync(dbPath);
    const row = db.prepare(`SELECT memory_tier FROM memories WHERE title = ?`).get('Cycle test') as { memory_tier: string };
    db.close();
    expect(row.memory_tier).toBe('short');
  });
});

// ─── E2E: multiSearch deduplication + injection threshold ────────────────────

describe('E2E: multiSearch + injection threshold', () => {
  it('same memory matched by multiple concepts appears once in candidates', async () => {
    const { multiSearch } = await import('../lib/memory.ts');
    const db = openTestDb();
    const id = seed(db, { title: 'jwt-base', embedKey: 'jwt-base', tier: 'long' });
    db.close();

    // Both 'jwt-base' and 'jwt-near' map close to the same memory
    const result = await multiSearch('jwt-base jwt-near', null, dbPath);
    const matchingIds = result.candidates.filter(c => c.id === id);
    expect(matchingIds).toHaveLength(1);
  });

  it('candidates are sorted by distance ascending', async () => {
    const { multiSearch } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'close', embedKey: 'jwt-near',  tier: 'long' });
    seed(db, { title: 'far',   embedKey: 'react-base', tier: 'long' });
    db.close();

    const result = await multiSearch('jwt-base', null, dbPath);
    expect(result.candidates[0].title).toBe('close');
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i].distance).toBeGreaterThanOrEqual(result.candidates[i - 1].distance);
    }
  });

  it('handleExplainRecall marks candidates above threshold as would_inject:false', async () => {
    const { multiSearch, INJECTION_THRESHOLD } = await import('../lib/memory.ts');
    const { handleExplainRecall } = await import('../mcp/handlers.ts');
    const db = openTestDb();
    // Seed two memories: one close (will inject), one far (won't inject)
    seed(db, { title: 'close-mem',  embedKey: 'jwt-near',  tier: 'long' });
    seed(db, { title: 'far-mem',    embedKey: 'react-base', tier: 'long' });
    db.close();

    const result = await handleExplainRecall(
      { prompt: 'jwt-base' },
      {
        multiSearch: (p, s) => multiSearch(p, s, dbPath),
        defaultScope: () => null,
        injectionThreshold: INJECTION_THRESHOLD,
      },
    );

    expect(result.ok).toBe(true);
    const close = result.candidates!.find(c => c.title === 'close-mem');
    const far   = result.candidates!.find(c => c.title === 'far-mem');
    expect(close?.would_inject).toBe(true);
    expect(far?.would_inject).toBe(false);
  });
});

// ─── Migration: pre-Phase-0 DBs survive schema upgrade ───────────────────────

describe('Migration: ensureSchema handles old schemas', () => {
  it('migrates a fresh DB (v0) to current version without error', () => {
    const db = new DatabaseSync(dbPath);
    // Completely fresh — no schema_version table
    ensureSchema(db);
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    db.close();
    expect(row.version).toBe(CURRENT_VERSION);
  });

  it('v2 DB with existing rows survives migration to v5 without data loss', () => {
    // Build a v2 schema manually (memories table without embedding / pin_order)
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL DEFAULT 0)`);
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    db.exec(`
      CREATE TABLE memories (
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
        is_active       INTEGER DEFAULT 1,
        memory_tier     TEXT DEFAULT 'short',
        project_scope   TEXT,
        confidence      REAL DEFAULT 1.0,
        decay_rate      REAL DEFAULT 0.02,
        access_count    INTEGER DEFAULT 0,
        last_accessed_at INTEGER,
        file_hash       TEXT
      )
    `);
    db.prepare(`INSERT INTO memories (path, title, chunk, memory_tier) VALUES (?, ?, ?, ?)`).run(
      'legacy.md', 'Legacy memory', 'old content', 'short'
    );
    db.close();

    // Apply migrations
    const db2 = new DatabaseSync(dbPath);
    ensureSchema(db2);

    const vRow = db2.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(vRow.version).toBe(CURRENT_VERSION);

    // Original row survived
    const row = db2.prepare(`SELECT title, memory_tier, embedding, pin_order FROM memories WHERE title = ?`).get('Legacy memory') as
      { title: string; memory_tier: string; embedding: unknown; pin_order: unknown };
    db2.close();

    expect(row.title).toBe('Legacy memory');
    expect(row.memory_tier).toBe('short');
    expect(row.embedding).toBeNull();     // no embedding until reindex
    expect(row.pin_order).toBeNull();     // new column, null by default
  });

  it('v4 DB (missing pin_order/scope_group/previous_tier) migrates cleanly', () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL DEFAULT 0)`);
    db.prepare('INSERT INTO schema_version (version) VALUES (4)').run();
    db.exec(`
      CREATE TABLE memories (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL,
        title           TEXT,
        chunk           TEXT NOT NULL,
        memory_tier     TEXT DEFAULT 'short',
        project_scope   TEXT,
        confidence      REAL DEFAULT 1.0,
        decay_rate      REAL DEFAULT 0.02,
        access_count    INTEGER DEFAULT 0,
        is_active       INTEGER DEFAULT 1,
        created_at      INTEGER DEFAULT (unixepoch()),
        embedding       BLOB
      )
    `);
    db.prepare(`INSERT INTO memories (path, title, chunk) VALUES (?, ?, ?)`).run('v4.md', 'V4 memory', 'content');
    db.close();

    const db2 = new DatabaseSync(dbPath);
    ensureSchema(db2);

    const vRow = db2.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(vRow.version).toBe(CURRENT_VERSION);

    const row = db2.prepare(`SELECT pin_order, scope_group, previous_tier FROM memories WHERE title = ?`).get('V4 memory') as
      { pin_order: unknown; scope_group: unknown; previous_tier: unknown };
    db2.close();

    expect(row.pin_order).toBeNull();
    expect(row.scope_group).toBeNull();
    expect(row.previous_tier).toBeNull();
  });

  it('ensureSchema is idempotent — running twice does not corrupt data', () => {
    const db = new DatabaseSync(dbPath);
    ensureSchema(db);
    db.prepare(`INSERT INTO memories (path, chunk) VALUES ('x.md', 'body')`).run();
    ensureSchema(db); // second call
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
    db.close();
    expect(count).toBe(1);
  });
});

// ─── Perf budget: multiSearch < 200ms on warm model ──────────────────────────

describe('Perf budget', () => {
  it('multiSearch on a 50-row DB completes in under 200ms (warm model)', async () => {
    const { multiSearch } = await import('../lib/memory.ts');
    const db = openTestDb();

    // Seed 50 memories spread across the embedding space
    const keys = ['jwt-base', 'jwt-near', 'ws-base', 'react-base', 'auth-query'];
    for (let i = 0; i < 50; i++) {
      const key = keys[i % keys.length];
      const v = serialize(Array.from(embedFor(key)));
      db.prepare(`
        INSERT INTO memories (path, title, chunk, memory_tier, is_active, embedding)
        VALUES (?, ?, ?, 'long', 1, ?)
      `).run(`mem-${i}.md`, `Memory ${i}`, `content ${i}`, v);
    }
    db.close();

    // Warm up: one search to ensure the model mock is loaded
    await multiSearch('jwt-base', null, dbPath);

    // Timed run
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await multiSearch('jwt-near auth flow', null, dbPath);
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200 * 5); // 200ms budget per call × 5 calls
  });
});
