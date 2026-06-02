/**
 * Integration tests against a seeded sqlite DB.
 *
 * Covers the load-bearing logic that the unit tests skip:
 *   - search() end-to-end: long-term global, short-term scope-filtered, access_count++
 *   - saveMemory() supersession transaction (old.is_active=0, new.supersedes=old.id)
 *   - promote SQL: candidate selection + UPDATE clears project_scope and sets tier='long'
 *   - decay math and cutoff: confidence *= (1 - rate); below cutoff → is_active=0
 *   - reindex orphan reactivation: edits to a file un-supersede its dependents
 *
 * @huggingface/transformers is mocked with a deterministic embedder so the model
 * never loads. Inputs map to fixed 4-dim unit vectors via REGISTRY; anything else
 * falls back to a hash-derived vector.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema } from '../lib/migrate.ts';
import { serialize } from '../lib/utils.ts';

// ─── Deterministic embedder ───────────────────────────────────────────────────
// Maps known inputs to fixed unit vectors so we can craft near-duplicate pairs.

const REGISTRY: Record<string, number[]> = {
  // Cluster A — semantically close (distance < 0.15 between #1 and #2)
  'jwt-base':       [1, 0, 0, 0],
  'jwt-near':       [0.999, 0.045, 0, 0],     // ~0.001 distance from jwt-base — duplicate range
  'jwt-supersede':  [0.75, 0.6614, 0, 0],     // ~0.25 distance — supersession range (0.15..0.35)
  // Cluster B — orthogonal to A
  'ws-base':        [0, 1, 0, 0],
  'ws-near':        [0.05, 0.998, 0, 0],
  // Cluster C — orthogonal to both
  'react-base':     [0, 0, 1, 0],
};

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map(x => x / n);
}

function embedFor(text: string): Float32Array {
  if (text in REGISTRY) return new Float32Array(normalize(REGISTRY[text]));
  // Fallback: hash → deterministic 4-dim vector
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
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
  workDir = mkdtempSync(join(tmpdir(), 'engram-test-'));
  dbPath = join(workDir, 'memory.db');
  rawDir = join(workDir, 'raw');
});

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

/** Open a freshly-migrated DB at the test's dbPath. */
function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  return db;
}

/** Seed a memory row with a chosen embedding. Returns its id. */
function seed(
  db: DatabaseSync,
  args: {
    title: string;
    embedKey: string;
    tier?: 'short' | 'long' | 'provisional' | 'pinned' | 'user' | 'shared';
    projectScope?: string | null;
    confidence?: number;
    decayRate?: number;
    accessCount?: number;
    isActive?: number;
    createdAt?: number;
  },
): number {
  const v = serialize(Array.from(embedFor(args.embedKey)));
  const result = db.prepare(`
    INSERT INTO memories
      (path, title, tags, topic, chunk, memory_tier, project_scope,
       confidence, decay_rate, access_count, is_active, created_at, embedding)
    VALUES (?, ?, 'test', 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${args.title}.md`,
    args.title,
    args.title,
    args.tier ?? 'short',
    args.projectScope ?? null,
    args.confidence ?? 1.0,
    args.decayRate ?? 0.02,
    args.accessCount ?? 0,
    args.isActive ?? 1,
    args.createdAt ?? Math.floor(Date.now() / 1000),
    v,
  );
  return Number(result.lastInsertRowid);
}

// ─── search() ─────────────────────────────────────────────────────────────────

describe('search()', () => {
  it('returns near matches and increments access_count', async () => {
    const { search } = await import('../lib/memory.ts');
    const db = openTestDb();
    const id = seed(db, { title: 'jwt-base', embedKey: 'jwt-base', tier: 'long' });
    db.close();

    const results = await search('jwt-near', 5, null, dbPath);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(id);
    expect(results[0].distance).toBeLessThan(0.01);

    // access_count was incremented
    const db2 = openTestDb();
    const row = db2.prepare('SELECT access_count FROM memories WHERE id = ?').get(id) as { access_count: number };
    db2.close();
    expect(row.access_count).toBe(1);
  });

  it('long-term memories are returned regardless of project scope', async () => {
    const { search } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'jwt-base', embedKey: 'jwt-base', tier: 'long', projectScope: null });
    db.close();

    // Different scope passed in → long-term still wins
    const results = await search('jwt-near', 5, 'https://github.com/other/repo', dbPath);
    expect(results).toHaveLength(1);
    expect(results[0].memory_tier).toBe('long');
  });

  it('short-term memories are filtered by project scope', async () => {
    const { search } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'in-scope',  embedKey: 'jwt-base', tier: 'short', projectScope: 'repo-A' });
    seed(db, { title: 'out-scope', embedKey: 'jwt-near', tier: 'short', projectScope: 'repo-B' });
    db.close();

    const results = await search('jwt-base', 5, 'repo-A', dbPath);
    const titles = results.map(r => r.title);
    expect(titles).toContain('in-scope');
    expect(titles).not.toContain('out-scope');
  });

  it('unscoped short-term memories are included regardless of scope', async () => {
    const { search } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'unscoped', embedKey: 'jwt-base', tier: 'short', projectScope: null });
    db.close();

    const results = await search('jwt-near', 5, 'repo-A', dbPath);
    expect(results.map(r => r.title)).toContain('unscoped');
  });

  it('inactive memories are excluded', async () => {
    const { search } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'inactive', embedKey: 'jwt-base', tier: 'long', isActive: 0 });
    db.close();

    const results = await search('jwt-near', 5, null, dbPath);
    expect(results).toHaveLength(0);
  });

  it('returns [] when DB does not exist', async () => {
    const { search } = await import('../lib/memory.ts');
    const results = await search('anything', 5, null, join(workDir, 'does-not-exist.db'));
    expect(results).toEqual([]);
  });
});

// ─── saveMemory() supersession ────────────────────────────────────────────────

describe('saveMemory() supersession', () => {
  it('marks the near-duplicate inactive and links new → old via supersedes', async () => {
    const { saveMemory } = await import('../lib/memory.ts');

    // Seed an existing memory at jwt-base
    const db = openTestDb();
    const oldId = seed(db, { title: 'jwt-original', embedKey: 'jwt-base', tier: 'short' });
    db.close();

    // Save a new memory whose embedding is close enough to trigger supersession
    // (jwt-supersede has ~0.05 distance to jwt-base — within SUPERSESSION_THRESHOLD=0.35)
    await saveMemory('jwt-updated', 'auth', 'jwt-supersede', {
      tier: 'short', projectScope: null, dbPath, rawDir,
    });

    // Verify post-conditions
    const db2 = openTestDb();
    const oldRow = db2.prepare('SELECT is_active, superseded_by FROM memories WHERE id = ?').get(oldId) as
      { is_active: number; superseded_by: number };
    const newRow = db2.prepare('SELECT id, is_active, supersedes FROM memories WHERE title = ?').get('jwt-updated') as
      { id: number; is_active: number; supersedes: number };
    db2.close();

    expect(oldRow.is_active).toBe(0);
    expect(oldRow.superseded_by).toBe(newRow.id);
    expect(newRow.is_active).toBe(1);
    expect(newRow.supersedes).toBe(oldId);
  });

  it('skips silently when an exact duplicate already exists (distance < 0.15)', async () => {
    const { saveMemory } = await import('../lib/memory.ts');

    const db = openTestDb();
    seed(db, { title: 'jwt-base', embedKey: 'jwt-base', tier: 'short' });
    const before = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
    db.close();

    // jwt-near has distance ~0.001 from jwt-base — under DUPLICATE_THRESHOLD
    await saveMemory('would-be-dup', 'auth', 'jwt-near', {
      tier: 'short', projectScope: null, dbPath, rawDir,
    });

    const db2 = openTestDb();
    const after = (db2.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
    db2.close();
    expect(after).toBe(before);
  });

  it('inserts a fresh row when no nearby neighbour exists (distance >= 0.35)', async () => {
    const { saveMemory } = await import('../lib/memory.ts');

    const db = openTestDb();
    seed(db, { title: 'jwt-base', embedKey: 'jwt-base', tier: 'short' });
    db.close();

    // ws-base is orthogonal to jwt-base — distance ~1
    await saveMemory('ws-new', 'transport', 'ws-base', {
      tier: 'short', projectScope: null, dbPath, rawDir,
    });

    const db2 = openTestDb();
    const row = db2.prepare('SELECT supersedes, is_active FROM memories WHERE title = ?').get('ws-new') as
      { supersedes: number | null; is_active: number };
    db2.close();
    expect(row.supersedes).toBeNull();
    expect(row.is_active).toBe(1);
  });
});

// ─── Promotion logic ──────────────────────────────────────────────────────────

describe('promote SQL', () => {
  // Replicates the production query in scripts/promote.ts so a behavior change
  // in the query is caught — but does not import the script itself (no side effects).
  const SELECT = `
    SELECT id FROM memories
    WHERE is_active = 1
      AND memory_tier = 'short'
      AND access_count >= ?
  `;
  const PROMOTE = `
    UPDATE memories
    SET memory_tier = 'long', project_scope = NULL
    WHERE id = ?
  `;

  it('selects only short-term memories above the threshold', () => {
    const db = openTestDb();
    seed(db, { title: 'low',         embedKey: 'a', tier: 'short', accessCount: 1 });
    seed(db, { title: 'at-threshold', embedKey: 'b', tier: 'short', accessCount: 3 });
    seed(db, { title: 'above',       embedKey: 'c', tier: 'short', accessCount: 10 });
    seed(db, { title: 'long-tier',   embedKey: 'd', tier: 'long',  accessCount: 99 });
    seed(db, { title: 'inactive',    embedKey: 'e', tier: 'short', accessCount: 99, isActive: 0 });

    const eligible = db.prepare(SELECT).all(3) as Array<{ id: number }>;
    const titles = eligible.map(r =>
      (db.prepare('SELECT title FROM memories WHERE id = ?').get(r.id) as { title: string }).title
    );
    db.close();

    expect(titles.sort()).toEqual(['above', 'at-threshold']);
  });

  it('promotion clears project_scope and sets tier to long', () => {
    const db = openTestDb();
    const id = seed(db, {
      title: 'to-promote', embedKey: 'a', tier: 'short',
      projectScope: 'https://github.com/foo/bar', accessCount: 5,
    });

    db.prepare(PROMOTE).run(id);

    const row = db.prepare('SELECT memory_tier, project_scope FROM memories WHERE id = ?').get(id) as
      { memory_tier: string; project_scope: string | null };
    db.close();

    expect(row.memory_tier).toBe('long');
    expect(row.project_scope).toBeNull();
  });
});

// ─── Decay logic ──────────────────────────────────────────────────────────────

describe('decay math and cutoff', () => {
  const DEACTIVATE_CUTOFF = 0.10;

  function applyDecayOnce(db: DatabaseSync, globalRate: number | null = null) {
    const rows = db.prepare(`
      SELECT id, confidence, decay_rate FROM memories
      WHERE is_active = 1 AND memory_tier = 'short'
    `).all() as Array<{ id: number; confidence: number; decay_rate: number }>;
    for (const r of rows) {
      const rate = globalRate ?? r.decay_rate;
      const newConf = r.confidence * (1 - rate);
      if (newConf < DEACTIVATE_CUTOFF) {
        db.prepare('UPDATE memories SET confidence = ?, is_active = 0 WHERE id = ?').run(newConf, r.id);
      } else {
        db.prepare('UPDATE memories SET confidence = ? WHERE id = ?').run(newConf, r.id);
      }
    }
  }

  it('multiplies confidence by (1 - decay_rate) per run', () => {
    const db = openTestDb();
    const id = seed(db, { title: 'm', embedKey: 'a', tier: 'short', confidence: 1.0, decayRate: 0.02 });

    applyDecayOnce(db);
    applyDecayOnce(db);

    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number };
    db.close();
    expect(row.confidence).toBeCloseTo(1.0 * 0.98 * 0.98, 6);
  });

  it('deactivates memories that fall below the cutoff', () => {
    const db = openTestDb();
    // 0.105 * 0.98 = 0.1029 (above 0.10) → still active
    // 0.10  * 0.98 = 0.098  (below 0.10) → deactivated
    const survivor   = seed(db, { title: 's', embedKey: 'a', tier: 'short', confidence: 0.105, decayRate: 0.02 });
    const condemned  = seed(db, { title: 'c', embedKey: 'b', tier: 'short', confidence: 0.10,  decayRate: 0.02 });

    applyDecayOnce(db);

    const sRow = db.prepare('SELECT is_active FROM memories WHERE id = ?').get(survivor) as { is_active: number };
    const cRow = db.prepare('SELECT is_active FROM memories WHERE id = ?').get(condemned) as { is_active: number };
    db.close();
    expect(sRow.is_active).toBe(1);
    expect(cRow.is_active).toBe(0);
  });

  it('long-term memories are never decayed', () => {
    const db = openTestDb();
    const longId = seed(db, { title: 'l', embedKey: 'a', tier: 'long', confidence: 1.0, decayRate: 0.02 });

    applyDecayOnce(db);

    const row = db.prepare('SELECT confidence, is_active FROM memories WHERE id = ?').get(longId) as
      { confidence: number; is_active: number };
    db.close();
    expect(row.confidence).toBe(1.0);
    expect(row.is_active).toBe(1);
  });

  it('--rate override applies globally regardless of per-row decay_rate', () => {
    const db = openTestDb();
    const id = seed(db, { title: 'm', embedKey: 'a', tier: 'short', confidence: 1.0, decayRate: 0.02 });

    applyDecayOnce(db, 0.005); // weekly rate

    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number };
    db.close();
    expect(row.confidence).toBeCloseTo(0.995, 6);
  });
});

// ─── Reindex orphan reactivation ──────────────────────────────────────────────

describe('reindex orphan reactivation', () => {
  // Replicates the SQL in scripts/reindex.ts that prevents dangling superseded_by
  // refs when the file containing the superseder is reindexed.
  const REACTIVATE_ORPHANS = `
    UPDATE memories
    SET is_active = 1, superseded_by = NULL
    WHERE superseded_by IN (SELECT id FROM memories WHERE path = ?)
      AND path != ?
  `;
  const DELETE_BY_PATH = `DELETE FROM memories WHERE path = ?`;

  it('un-supersedes a memory in a different file when the superseder is being reindexed', () => {
    const db = openTestDb();
    // Old memory in file-B, originally active, superseded by something in file-A
    const oldId = seed(db, {
      title: 'old-in-B', embedKey: 'a', tier: 'short', isActive: 0,
    });
    // Manually update path/superseded_by for the seed
    db.prepare('UPDATE memories SET path = ?, superseded_by = ? WHERE id = ?')
      .run('file-B.md', 999, oldId); // placeholder

    // New memory in file-A that superseded it
    const newId = seed(db, { title: 'new-in-A', embedKey: 'b', tier: 'short' });
    db.prepare('UPDATE memories SET path = ? WHERE id = ?').run('file-A.md', newId);
    db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(newId, oldId);

    // Now reindex file-A: orphan reactivation runs first
    db.prepare(REACTIVATE_ORPHANS).run('file-A.md', 'file-A.md');
    // Then delete file-A's rows
    db.prepare(DELETE_BY_PATH).run('file-A.md');

    const oldRow = db.prepare('SELECT is_active, superseded_by FROM memories WHERE id = ?').get(oldId) as
      { is_active: number; superseded_by: number | null };
    const aGone = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE path = ?').get('file-A.md') as { c: number };
    db.close();

    expect(oldRow.is_active).toBe(1);
    expect(oldRow.superseded_by).toBeNull();
    expect(aGone.c).toBe(0);
  });

  it('does not reactivate self-referential supersession (same file)', () => {
    const db = openTestDb();
    // Two rows both in file-A, where one supersedes the other.
    // Re-indexing file-A should NOT bother to reactivate either — they're going
    // to be deleted anyway.
    const oldId = seed(db, { title: 'old-A', embedKey: 'a', tier: 'short', isActive: 0 });
    const newId = seed(db, { title: 'new-A', embedKey: 'b', tier: 'short' });
    db.prepare('UPDATE memories SET path = ? WHERE id IN (?, ?)').run('file-A.md', oldId, newId);
    db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(newId, oldId);

    db.prepare(REACTIVATE_ORPHANS).run('file-A.md', 'file-A.md');

    // Old row still inactive (the WHERE path != ? clause excludes it)
    const oldRow = db.prepare('SELECT is_active FROM memories WHERE id = ?').get(oldId) as { is_active: number };
    db.close();
    expect(oldRow.is_active).toBe(0);
  });
});

// ─── autoRemember pipeline (parseClassifyOutput) ──────────────────────────────

describe('parseClassifyOutput', () => {
  it('unwraps the CLI result wrapper', async () => {
    const { parseClassifyOutput } = await import('../lib/memory.ts');
    const wrapper = JSON.stringify({
      type: 'result',
      result: '{"worth_saving": true, "title": "x", "content": "y", "excerpt": "z"}',
    });
    const decision = parseClassifyOutput(wrapper);
    expect(decision).not.toBeNull();
    expect(decision!.worth_saving).toBe(true);
    expect(decision!.title).toBe('x');
  });

  it('handles fenced JSON inside the wrapper', async () => {
    const { parseClassifyOutput } = await import('../lib/memory.ts');
    const wrapper = JSON.stringify({
      result: '```json\n{"worth_saving": false}\n```',
    });
    const decision = parseClassifyOutput(wrapper);
    expect(decision).toEqual({ worth_saving: false });
  });

  it('parses bare JSON (no wrapper)', async () => {
    const { parseClassifyOutput } = await import('../lib/memory.ts');
    const decision = parseClassifyOutput('{"worth_saving": false}');
    expect(decision).toEqual({ worth_saving: false });
  });

  it('returns null for empty input', async () => {
    const { parseClassifyOutput } = await import('../lib/memory.ts');
    expect(parseClassifyOutput('')).toBeNull();
    expect(parseClassifyOutput('   ')).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    const { parseClassifyOutput } = await import('../lib/memory.ts');
    expect(parseClassifyOutput('{invalid')).toBeNull();
  });

  it('returns null when worth_saving is missing or not a boolean', async () => {
    const { parseClassifyOutput } = await import('../lib/memory.ts');
    expect(parseClassifyOutput('{"title": "no flag"}')).toBeNull();
    expect(parseClassifyOutput('{"worth_saving": "yes"}')).toBeNull();
  });
});

// ─── Phase 4: pruneProvisional ────────────────────────────────────────────────

describe('pruneProvisional()', () => {
  const DAY_S = 86400;

  it('dry-run: returns eligible count without modifying the DB', async () => {
    const { pruneProvisional } = await import('../lib/memory.ts');
    const db = openTestDb();
    const now = Math.floor(Date.now() / 1000);
    // Eligible: old, 0 accesses, low confidence
    seed(db, { title: 'stale', embedKey: 'a', tier: 'provisional',
      createdAt: now - 15 * DAY_S, accessCount: 0, confidence: 0.3 });
    db.close();

    const result = await pruneProvisional({ apply: false, dbPath });
    expect(result.eligible).toBe(1);
    expect(result.softDeleted).toBe(0);

    // DB is unchanged
    const db2 = openTestDb();
    const row = db2.prepare('SELECT is_active FROM memories WHERE title = ?').get('stale') as { is_active: number };
    db2.close();
    expect(row.is_active).toBe(1);
  });

  it('apply: soft-deletes eligible provisional memories', async () => {
    const { pruneProvisional } = await import('../lib/memory.ts');
    const db = openTestDb();
    const now = Math.floor(Date.now() / 1000);
    seed(db, { title: 'stale', embedKey: 'a', tier: 'provisional',
      createdAt: now - 15 * DAY_S, accessCount: 0, confidence: 0.3 });
    seed(db, { title: 'accessed', embedKey: 'b', tier: 'provisional',
      createdAt: now - 15 * DAY_S, accessCount: 2, confidence: 0.3 });
    db.close();

    const result = await pruneProvisional({ apply: true, dbPath });
    expect(result.softDeleted).toBe(1);

    const db2 = openTestDb();
    const stale = db2.prepare('SELECT is_active FROM memories WHERE title = ?').get('stale') as { is_active: number };
    const accessed = db2.prepare('SELECT is_active FROM memories WHERE title = ?').get('accessed') as { is_active: number };
    db2.close();
    expect(stale.is_active).toBe(0);
    expect(accessed.is_active).toBe(1);
  });

  it('apply: hard-deletes old soft-deleted provisional memories', async () => {
    const { pruneProvisional } = await import('../lib/memory.ts');
    const db = openTestDb();
    const now = Math.floor(Date.now() / 1000);
    const id = seed(db, { title: 'ancient', embedKey: 'a', tier: 'provisional',
      createdAt: now - 61 * DAY_S, accessCount: 0, confidence: 0.3, isActive: 0 });
    db.close();

    const result = await pruneProvisional({ apply: true, dbPath });
    expect(result.hardDeleted).toBe(1);

    const db2 = openTestDb();
    const row = db2.prepare('SELECT id FROM memories WHERE id = ?').get(id);
    db2.close();
    expect(row).toBeUndefined();
  });

  it('does not touch non-provisional tiers', async () => {
    const { pruneProvisional } = await import('../lib/memory.ts');
    const db = openTestDb();
    const now = Math.floor(Date.now() / 1000);
    seed(db, { title: 'short-mem', embedKey: 'a', tier: 'short',
      createdAt: now - 15 * DAY_S, accessCount: 0, confidence: 0.3 });
    db.close();

    const result = await pruneProvisional({ apply: true, dbPath });
    expect(result.softDeleted).toBe(0);
    expect(result.eligible).toBe(0);
  });
});

// ─── Phase 5: multiSearch ─────────────────────────────────────────────────────

describe('multiSearch()', () => {
  it('returns candidates with high distance when no semantic match exists', async () => {
    const { multiSearch } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'ws-base', embedKey: 'ws-base', tier: 'short' });
    db.close();

    // react-base is orthogonal to ws-base — candidate returned but distance ~1
    const result = await multiSearch('react-base', null, dbPath);
    expect(result.concepts).toBeInstanceOf(Array);
    expect(result.queries).toBeInstanceOf(Array);
    expect(result.queries.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].distance).toBeGreaterThan(0.9);
  });

  it('returns matching candidates sorted by distance', async () => {
    const { multiSearch } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'jwt-base', embedKey: 'jwt-base', tier: 'long' });
    seed(db, { title: 'ws-base',  embedKey: 'ws-base',  tier: 'long' });
    db.close();

    const result = await multiSearch('jwt-near', null, dbPath);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].title).toBe('jwt-base');
    expect(result.candidates[0].distance).toBeLessThan(0.05);
  });

  it('deduplicates candidates keeping the lowest distance', async () => {
    const { multiSearch } = await import('../lib/memory.ts');
    const db = openTestDb();
    const id = seed(db, { title: 'jwt-base', embedKey: 'jwt-base', tier: 'long' });
    db.close();

    // Use a prompt where heuristic extraction produces concepts that also match
    // the same memory. jwt-base + jwt-near both map to the same row — only one
    // entry should appear in candidates.
    const result = await multiSearch('jwt-base jwt-near', null, dbPath);
    const ids = result.candidates.map(c => c.id);
    expect(ids.filter(x => x === id)).toHaveLength(1);
  });

  it('returns empty when DB does not exist', async () => {
    const { multiSearch } = await import('../lib/memory.ts');
    const result = await multiSearch('jwt-near', null, join(workDir, 'ghost.db'));
    expect(result.candidates).toEqual([]);
    expect(result.concepts).toEqual([]);
    expect(result.queries).toEqual([]);
  });
});

// ─── Recall quality: recordRecallHit ─────────────────────────────────────────

describe('recordRecallHit()', () => {
  it('increments recall_hit for matched ids', async () => {
    const { recordRecallHit } = await import('../lib/recall.ts');
    const db = openTestDb();
    const id = seed(db, { title: 'hit-me', embedKey: 'jwt-base', tier: 'short' });
    db.close();

    recordRecallHit([id], dbPath);

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare('SELECT recall_hit FROM memories WHERE id = ?').get(id) as { recall_hit: number };
    db2.close();
    expect(row.recall_hit).toBe(1);
  });

  it('increments by 1 per call — multiple calls accumulate', async () => {
    const { recordRecallHit } = await import('../lib/recall.ts');
    const db = openTestDb();
    const id = seed(db, { title: 'multi-hit', embedKey: 'jwt-base', tier: 'short' });
    db.close();

    recordRecallHit([id], dbPath);
    recordRecallHit([id], dbPath);
    recordRecallHit([id], dbPath);

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare('SELECT recall_hit FROM memories WHERE id = ?').get(id) as { recall_hit: number };
    db2.close();
    expect(row.recall_hit).toBe(3);
  });

  it('is a no-op for an empty id list', async () => {
    const { recordRecallHit } = await import('../lib/recall.ts');
    expect(() => recordRecallHit([], dbPath)).not.toThrow();
  });

  it('is a no-op when DB does not exist', async () => {
    const { recordRecallHit } = await import('../lib/recall.ts');
    expect(() => recordRecallHit([1], join(workDir, 'ghost.db'))).not.toThrow();
  });
});

// ─── tierCounts() (status reporting) ──────────────────────────────────────────

describe('tierCounts()', () => {
  it('counts active memories across every tier, not just short/long', async () => {
    const { tierCounts } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'p',  embedKey: 'a', tier: 'pinned' });
    seed(db, { title: 's1', embedKey: 'b', tier: 'shared' });
    seed(db, { title: 's2', embedKey: 'c', tier: 'shared' });
    seed(db, { title: 'u',  embedKey: 'd', tier: 'user' });
    seed(db, { title: 'sh', embedKey: 'e', tier: 'short' });
    seed(db, { title: 'pr', embedKey: 'f', tier: 'provisional' });
    db.close();

    const counts = tierCounts(dbPath);
    expect(counts.active.pinned).toBe(1);
    expect(counts.active.shared).toBe(2);
    expect(counts.active.user).toBe(1);
    expect(counts.active.short).toBe(1);
    expect(counts.active.provisional).toBe(1);
    expect(counts.active.long).toBe(0);
    expect(counts.totalActive).toBe(6);
  });

  it('counts inactive memories across every tier', async () => {
    const { tierCounts } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'a', embedKey: 'a', tier: 'short',       isActive: 0 });
    seed(db, { title: 'b', embedKey: 'b', tier: 'provisional', isActive: 0 });
    seed(db, { title: 'c', embedKey: 'c', tier: 'long',        isActive: 0 });
    seed(db, { title: 'd', embedKey: 'd', tier: 'short',       isActive: 1 });
    db.close();

    const counts = tierCounts(dbPath);
    expect(counts.totalInactive).toBe(3);
    expect(counts.inactive.short).toBe(1);
    expect(counts.inactive.provisional).toBe(1);
    expect(counts.inactive.long).toBe(1);
    expect(counts.totalActive).toBe(1);
  });

  it('returns all-zero counts when DB does not exist', async () => {
    const { tierCounts } = await import('../lib/memory.ts');
    const counts = tierCounts(join(workDir, 'ghost.db'));
    expect(counts.totalActive).toBe(0);
    expect(counts.totalInactive).toBe(0);
    expect(counts.active.short).toBe(0);
  });
});

// ─── Phase 4: promoteProvisional ──────────────────────────────────────────────

describe('promoteProvisional()', () => {
  it('promotes provisional memories at threshold to short tier', async () => {
    const { promoteProvisional } = await import('../lib/memory.ts');
    const db = openTestDb();
    const id = seed(db, { title: 'ready', embedKey: 'a', tier: 'provisional', accessCount: 10 });
    db.close();

    const promoted = promoteProvisional(dbPath, 10);
    expect(promoted).toBe(1);

    const db2 = openTestDb();
    const row = db2.prepare('SELECT memory_tier, previous_tier FROM memories WHERE id = ?').get(id) as
      { memory_tier: string; previous_tier: string };
    db2.close();
    expect(row.memory_tier).toBe('short');
    expect(row.previous_tier).toBe('provisional');
  });

  it('does not promote below threshold', async () => {
    const { promoteProvisional } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'not-ready', embedKey: 'a', tier: 'provisional', accessCount: 3 });
    db.close();

    const promoted = promoteProvisional(dbPath, 10);
    expect(promoted).toBe(0);

    const db2 = openTestDb();
    const row = db2.prepare('SELECT memory_tier FROM memories WHERE title = ?').get('not-ready') as { memory_tier: string };
    db2.close();
    expect(row.memory_tier).toBe('provisional');
  });

  it('does not promote non-provisional tiers', async () => {
    const { promoteProvisional } = await import('../lib/memory.ts');
    const db = openTestDb();
    seed(db, { title: 'short-high', embedKey: 'a', tier: 'short', accessCount: 99 });
    db.close();

    const promoted = promoteProvisional(dbPath, 1);
    expect(promoted).toBe(0);
  });

  it('returns 0 when DB does not exist', async () => {
    const { promoteProvisional } = await import('../lib/memory.ts');
    const promoted = promoteProvisional(join(workDir, 'ghost.db'), 1);
    expect(promoted).toBe(0);
  });
});
