/**
 * Consolidation tests.
 *
 * Consolidation merges RELATED HIGH-VALUE memories into one denser survivor.
 * It is NOT pruning — nothing low-value is removed. Originals are archived
 * (is_active=0, archived_at set, consolidated_into = survivor id), never deleted,
 * and a snapshot is taken first so the whole pass is reversible.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema, MIGRATIONS } from '../lib/migrate.ts';
import { serialize } from '../lib/utils.ts';
import {
  extractLinks,
  buildConsolidatePrompt,
  parseConsolidateOutput,
} from '../lib/utils.ts';
import { clusterMemories, consolidateTier, listArchived, unarchive } from '../lib/consolidate.ts';
import { restore } from '../lib/snapshot.ts';
import { handleConsolidate, handleUnarchive, handleListArchived } from '../mcp/handlers.ts';
import type { ConsolidateResult } from '../lib/consolidate.ts';

// ─── Deterministic embedder: maps fact keys to fixed 4-dim unit vectors ───────
const REGISTRY: Record<string, number[]> = {
  'fact-a': [1, 0, 0, 0],
  'fact-b': [0.999, 0.045, 0, 0],   // ~0.001 from fact-a — same cluster
  'fact-c': [0.998, 0.063, 0, 0],   // close to a/b — same cluster
  'far':    [0, 1, 0, 0],           // orthogonal — its own cluster
  'survivor': [0.97, 0.24, 0, 0],
};

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map(x => x / n);
}
function embedFor(key: string): Float32Array {
  return new Float32Array(normalize(REGISTRY[key] ?? [0, 0, 0, 1]));
}
const testEmbed = async (text: string): Promise<Float32Array> => {
  // The survivor content embeds via the 'survivor' key; everything else by its own text.
  return embedFor(text in REGISTRY ? text : 'survivor');
};

let workDir: string;
let dbPath: string;
let rawDir: string;
let snapshotDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'engram-consol-'));
  dbPath = join(workDir, 'memory.db');
  rawDir = join(workDir, 'raw');
  snapshotDir = join(workDir, 'snapshots');
});
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  return db;
}

function seed(db: DatabaseSync, args: {
  title: string; chunk: string; embedKey: string;
  tier?: string; scope?: string | null; tags?: string;
}): number {
  const v = serialize(Array.from(embedFor(args.embedKey)));
  const r = db.prepare(`
    INSERT INTO memories (path, title, tags, topic, chunk, memory_tier, project_scope, is_active, embedding)
    VALUES (?, ?, ?, 'test', ?, ?, ?, 1, ?)
  `).run(
    `${args.title}.md`, args.title, args.tags ?? 'auto', args.chunk,
    args.tier ?? 'provisional', args.scope ?? null, v,
  );
  return Number(r.lastInsertRowid);
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('extractLinks', () => {
  it('extracts and slugifies [[wiki links]]', () => {
    expect(extractLinks('see [[Foo Bar]] and [[baz-qux]]')).toEqual(['foo-bar', 'baz-qux']);
  });
  it('returns empty for text with no links', () => {
    expect(extractLinks('no links here')).toEqual([]);
  });
});

describe('parseConsolidateOutput', () => {
  it('parses a {title, content} object', () => {
    expect(parseConsolidateOutput('{"title":"T","content":"C"}')).toEqual({ title: 'T', content: 'C' });
  });
  it('unwraps the CLI result wrapper and json fences', () => {
    const raw = JSON.stringify({ type: 'result', result: '```json\n{"title":"T","content":"C"}\n```' });
    expect(parseConsolidateOutput(raw)).toEqual({ title: 'T', content: 'C' });
  });
  it('returns null on garbage', () => {
    expect(parseConsolidateOutput('not json')).toBeNull();
  });
});

describe('buildConsolidatePrompt', () => {
  it('includes every member title and instructs preservation of facts', () => {
    const p = buildConsolidatePrompt([
      { title: 'A', chunk: 'fact one' },
      { title: 'B', chunk: 'fact two' },
    ]);
    expect(p).toContain('A');
    expect(p).toContain('B');
    expect(p.toLowerCase()).toContain('preserve');
  });
});

describe('clusterMemories', () => {
  it('groups near-duplicate embeddings and excludes singletons', () => {
    const items = [
      { id: 1, embedding: serialize(Array.from(embedFor('fact-a'))), links: [] as string[], titleSlug: 'a' },
      { id: 2, embedding: serialize(Array.from(embedFor('fact-b'))), links: [] as string[], titleSlug: 'b' },
      { id: 3, embedding: serialize(Array.from(embedFor('far'))),    links: [] as string[], titleSlug: 'c' },
    ];
    const clusters = clusterMemories(items, 0.45);
    expect(clusters).toEqual([[1, 2]]);
  });

  it('groups memories linked by a shared [[link]] even if distant', () => {
    const items = [
      { id: 1, embedding: serialize(Array.from(embedFor('fact-a'))), links: ['topic-x'], titleSlug: 'a' },
      { id: 2, embedding: serialize(Array.from(embedFor('far'))),    links: ['topic-x'], titleSlug: 'b' },
    ];
    const clusters = clusterMemories(items, 0.1);
    expect(clusters).toEqual([[1, 2]]);
  });
});

// ─── Migration ────────────────────────────────────────────────────────────────

describe('migration v6 → v7', () => {
  it('adds archived_at + consolidated_into without losing data', () => {
    // Build a DB stopped at v6, insert a row, then let ensureSchema migrate to 7.
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL DEFAULT 0)');
    db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    for (const [from, to, sql] of MIGRATIONS) {
      if (to > 6) break;
      db.exec(sql);
      db.prepare('UPDATE schema_version SET version = ?').run(to);
    }
    db.prepare("INSERT INTO memories (path, title, chunk) VALUES ('x.md','x','keep me')").run();
    db.close();

    const db2 = openTestDb(); // migrates 6 → 7
    const cols = (db2.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('archived_at');
    expect(cols).toContain('consolidated_into');
    const row = db2.prepare("SELECT chunk FROM memories WHERE title = 'x'").get() as { chunk: string };
    expect(row.chunk).toBe('keep me');
    db2.close();
  });
});

// ─── consolidateTier ────────────────────────────────────────────────────────

const concatMerge = async (cluster: { title: string; chunk: string }[]) => ({
  title: 'Merged survivor',
  content: cluster.map(c => c.chunk).join(' | '),
});

describe('consolidateTier', () => {
  it('dry-run writes nothing', async () => {
    const db = openTestDb();
    seed(db, { title: 'A', chunk: 'fact one', embedKey: 'fact-a' });
    seed(db, { title: 'B', chunk: 'fact two', embedKey: 'fact-b' });
    db.close();

    const res = await consolidateTier({
      tier: 'provisional', apply: false, dbPath, rawDir, snapshotDir,
      merge: concatMerge, embed: testEmbed, threshold: 0.45,
    });

    expect(res.dryRun).toBe(true);
    expect(res.clustersFound).toBe(1);
    expect(res.merged).toBe(0);

    const db2 = openTestDb();
    const active = db2.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_active = 1").get() as { n: number };
    expect(active.n).toBe(2);
    expect(existsSync(snapshotDir)).toBe(false);
    db2.close();
  });

  it('merges a cluster of 3 into 1 survivor and archives the originals', async () => {
    const db = openTestDb();
    const a = seed(db, { title: 'A', chunk: 'fact one', embedKey: 'fact-a' });
    const b = seed(db, { title: 'B', chunk: 'fact two', embedKey: 'fact-b' });
    const c = seed(db, { title: 'C', chunk: 'fact three', embedKey: 'fact-c' });
    db.close();

    const res = await consolidateTier({
      tier: 'provisional', apply: true, dbPath, rawDir, snapshotDir,
      merge: concatMerge, embed: testEmbed, threshold: 0.45,
    });

    expect(res.merged).toBe(1);
    expect(res.archived).toBe(3);
    expect(res.snapshotId).toBeTruthy();

    const db2 = openTestDb();
    const survivor = db2.prepare(
      "SELECT id, chunk, memory_tier FROM memories WHERE is_active = 1 AND title = 'Merged survivor'"
    ).get() as { id: number; chunk: string; memory_tier: string };
    expect(survivor).toBeTruthy();
    expect(survivor.memory_tier).toBe('provisional');
    // survivor preserves every distinct fact
    expect(survivor.chunk).toContain('fact one');
    expect(survivor.chunk).toContain('fact two');
    expect(survivor.chunk).toContain('fact three');

    for (const id of [a, b, c]) {
      const row = db2.prepare('SELECT is_active, archived_at, consolidated_into FROM memories WHERE id = ?')
        .get(id) as { is_active: number; archived_at: number | null; consolidated_into: number | null };
      expect(row.is_active).toBe(0);
      expect(row.archived_at).not.toBeNull();
      expect(row.consolidated_into).toBe(survivor.id);
    }
    db2.close();
  });

  it('never touches a pinned memory', async () => {
    const db = openTestDb();
    seed(db, { title: 'A', chunk: 'fact one', embedKey: 'fact-a' });
    seed(db, { title: 'B', chunk: 'fact two', embedKey: 'fact-b' });
    const pinnedId = seed(db, { title: 'P', chunk: 'pinned fact', embedKey: 'fact-c', tier: 'pinned' });
    db.close();

    await consolidateTier({
      tier: 'provisional', apply: true, dbPath, rawDir, snapshotDir,
      merge: concatMerge, embed: testEmbed, threshold: 0.45,
    });

    const db2 = openTestDb();
    const pinned = db2.prepare('SELECT is_active, memory_tier, archived_at FROM memories WHERE id = ?')
      .get(pinnedId) as { is_active: number; memory_tier: string; archived_at: number | null };
    expect(pinned.is_active).toBe(1);
    expect(pinned.memory_tier).toBe('pinned');
    expect(pinned.archived_at).toBeNull();
    db2.close();
  });

  it('listArchived + unarchive recover a single original', async () => {
    const db = openTestDb();
    const a = seed(db, { title: 'A', chunk: 'fact one', embedKey: 'fact-a' });
    seed(db, { title: 'B', chunk: 'fact two', embedKey: 'fact-b' });
    db.close();

    await consolidateTier({
      tier: 'provisional', apply: true, dbPath, rawDir, snapshotDir,
      merge: concatMerge, embed: testEmbed, threshold: 0.45,
    });

    const archived = listArchived(dbPath);
    expect(archived.map(m => m.id)).toContain(a);

    unarchive(a, dbPath);
    const db2 = openTestDb();
    const row = db2.prepare('SELECT is_active, archived_at, consolidated_into FROM memories WHERE id = ?')
      .get(a) as { is_active: number; archived_at: number | null; consolidated_into: number | null };
    expect(row.is_active).toBe(1);
    expect(row.archived_at).toBeNull();
    expect(row.consolidated_into).toBeNull();
    db2.close();

    expect(() => unarchive(999999, dbPath)).toThrow();
  });

  it('is reversible: restoring the pre-pass snapshot un-archives the originals', async () => {
    const db = openTestDb();
    seed(db, { title: 'A', chunk: 'fact one', embedKey: 'fact-a' });
    seed(db, { title: 'B', chunk: 'fact two', embedKey: 'fact-b' });
    db.close();

    const res = await consolidateTier({
      tier: 'provisional', apply: true, dbPath, rawDir, snapshotDir,
      merge: concatMerge, embed: testEmbed, threshold: 0.45,
    });
    expect(res.snapshotId).toBeTruthy();

    restore(res.snapshotId!, { dbPath, snapshotDir });

    const db2 = openTestDb();
    const active = db2.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_active = 1").get() as { n: number };
    const survivor = db2.prepare("SELECT id FROM memories WHERE title = 'Merged survivor'").get();
    expect(active.n).toBe(2);
    expect(survivor).toBeUndefined();
    db2.close();
  });
});

describe('consolidate MCP handlers', () => {
  it('handleConsolidate rejects an invalid tier without calling consolidate', async () => {
    let called = false;
    const res = await handleConsolidate(
      { tier: 'pinned' as never },
      { consolidate: async () => { called = true; return {} as ConsolidateResult; } },
    );
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('handleConsolidate forwards tier/scope/apply to its dep', async () => {
    const seen: unknown[] = [];
    const res = await handleConsolidate(
      { tier: 'provisional', scope: 'repo', apply: true },
      { consolidate: async (tier, scope, apply) => { seen.push([tier, scope, apply]); return { merged: 1 } as ConsolidateResult; } },
    );
    expect(res.ok).toBe(true);
    expect(seen[0]).toEqual(['provisional', 'repo', true]);
  });

  it('handleUnarchive rejects a non-positive id', async () => {
    let called = false;
    const res = await handleUnarchive({ id: 0 }, { unarchive: () => { called = true; } });
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('handleListArchived returns its deps output', async () => {
    const res = await handleListArchived({ listArchived: () => [{ id: 1, title: 't', archived_at: 9, consolidated_into: 2 }] });
    expect(res.ok).toBe(true);
    expect(res.archived?.[0].consolidated_into).toBe(2);
  });
});
