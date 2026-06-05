/**
 * Consolidation — merge related high-value memories into one denser survivor.
 *
 * This is NOT pruning. Pruning removes low-value provisional memories; this
 * compresses related HIGH-value memories so a growing tier stays dense instead
 * of sprawling. Originals are archived (is_active=0, archived_at set,
 * consolidated_into → survivor id), never deleted. A snapshot is taken before
 * any write so the whole pass is reversible via lib/snapshot.ts.
 *
 * Protected from consolidation: pinned memories (different tier, never loaded
 * here) and manually-saved memories (tags='manual').
 */

import { DatabaseSync } from 'node:sqlite';
import { pipeline } from '@huggingface/transformers';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureSchema } from './migrate.ts';
import {
  cosineDistance, serialize, today, sanitizeTopic, extractLinks,
  buildConsolidatePrompt, parseConsolidateOutput, runClassifier,
  type MemoryTier, type ConsolidateMember, type ConsolidateMerge,
} from './utils.ts';

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ENGRAM_DIR, 'memory', 'memory.db');
export const RAW_DIR = join(ENGRAM_DIR, 'memory', 'raw');

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Distance below which two memories are considered related enough to merge. */
export const CONSOLIDATION_THRESHOLD = parseFloat(process.env.ENGRAM_CONSOLIDATION_THRESHOLD ?? '0.45');

// ─── Clustering (pure) ────────────────────────────────────────────────────────

export interface ClusterItem {
  id: number;
  embedding: Uint8Array;
  links: string[];
  titleSlug: string;
}

/**
 * Group items into clusters. Two items join the same cluster when their
 * embeddings are within `threshold` OR they share a [[link]] OR one references
 * the other's title slug as a link. Returns clusters of size >= 2 only, ids
 * ascending, clusters ordered by their smallest id.
 */
export function clusterMemories(
  items: ClusterItem[],
  threshold = CONSOLIDATION_THRESHOLD,
): number[][] {
  const n = items.length;
  const parent = items.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  const related = (a: ClusterItem, b: ClusterItem): boolean => {
    if (cosineDistance(a.embedding, b.embedding) < threshold) return true;
    if (a.links.some(l => b.links.includes(l))) return true;
    if (a.links.includes(b.titleSlug) || b.links.includes(a.titleSlug)) return true;
    return false;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (related(items[i], items[j])) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(items[i].id);
  }

  return [...groups.values()]
    .filter(g => g.length >= 2)
    .map(g => g.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

// ─── consolidateTier ──────────────────────────────────────────────────────────

export type MergeFn = (cluster: ConsolidateMember[]) => Promise<ConsolidateMerge | null>;
export type EmbedFn = (text: string) => Promise<Float32Array>;

export interface ConsolidateOptions {
  tier: MemoryTier;
  /** Limit to a single project scope. Default: all scopes within the tier. */
  projectScope?: string | null;
  apply?: boolean;
  dbPath?: string;
  rawDir?: string;
  snapshotDir?: string;
  threshold?: number;
  /** Merge fn — defaults to the Claude-CLI-backed merger. Injected in tests. */
  merge?: MergeFn;
  /** Embed fn for the survivor — defaults to the transformers pipeline. */
  embed?: EmbedFn;
}

export interface ConsolidateSurvivor { id: number; title: string; from: number[]; }

export interface ConsolidateResult {
  tier: MemoryTier;
  clustersFound: number;
  merged: number;
  archived: number;
  dryRun: boolean;
  snapshotId?: string;
  survivors: ConsolidateSurvivor[];
}

interface CandidateRow {
  id: number;
  title: string;
  chunk: string;
  embedding: Uint8Array;
  project_scope: string | null;
  scope_group: string | null;
}

/** Default merger — builds the prompt, shells to Claude, parses the result. */
const defaultMerge: MergeFn = async (cluster) => {
  try {
    return parseConsolidateOutput(runClassifier(buildConsolidatePrompt(cluster)));
  } catch {
    return null;
  }
};

const defaultEmbed: EmbedFn = async (text) => {
  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' });
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  return out.data as Float32Array;
};

/**
 * Consolidate one tier. Dry-run by default (reports clusters, writes nothing,
 * takes no snapshot). With apply=true: snapshots first, then for each cluster
 * writes a survivor and archives its members.
 */
export async function consolidateTier(opts: ConsolidateOptions): Promise<ConsolidateResult> {
  const dbPath = opts.dbPath ?? DB_PATH;
  const rawDir = opts.rawDir ?? RAW_DIR;
  const threshold = opts.threshold ?? CONSOLIDATION_THRESHOLD;
  const merge = opts.merge ?? defaultMerge;
  const embed = opts.embed ?? defaultEmbed;
  const apply = opts.apply ?? false;

  const empty: ConsolidateResult = {
    tier: opts.tier, clustersFound: 0, merged: 0, archived: 0, dryRun: !apply, survivors: [],
  };
  if (!existsSync(dbPath)) return empty;

  const db = openDb(dbPath);
  let candidates: CandidateRow[];
  try {
    // Never consolidate pinned (different tier) or manually-saved (tags='manual') memories.
    const scope = opts.projectScope ?? null;
    const sql = `
      SELECT id, title, chunk, embedding, project_scope, scope_group
      FROM memories
      WHERE is_active = 1 AND embedding IS NOT NULL
        AND memory_tier = ? AND tags != 'manual' ${scope !== null ? 'AND project_scope = ?' : ''}
      ORDER BY id ASC`;
    candidates = (scope !== null
      ? db.prepare(sql).all(opts.tier, scope)
      : db.prepare(sql).all(opts.tier)) as unknown as CandidateRow[];
  } finally {
    db.close();
  }

  const items: ClusterItem[] = candidates.map(c => ({
    id: c.id,
    embedding: c.embedding,
    links: extractLinks(c.chunk),
    titleSlug: sanitizeTopic(c.title),
  }));
  const clusters = clusterMemories(items, threshold);

  if (!apply || clusters.length === 0) {
    return { ...empty, clustersFound: clusters.length };
  }

  // Snapshot BEFORE any write so the whole pass is reversible.
  const { snapshot } = await import('./snapshot.ts');
  const snap = snapshot({ dbPath, snapshotDir: opts.snapshotDir });

  const byId = new Map(candidates.map(c => [c.id, c]));
  const survivors: ConsolidateSurvivor[] = [];
  let merged = 0;
  let archived = 0;

  for (const cluster of clusters) {
    const members = cluster.map(id => byId.get(id)!).filter(Boolean);
    if (members.length < 2) continue;

    const result = await merge(members.map(m => ({ title: m.title, chunk: m.chunk })));
    if (!result) continue;

    const embedding = serialize(Array.from(await embed(result.content)));
    const first = members[0];
    const survivorId = writeSurvivor(dbPath, rawDir, {
      title: result.title,
      content: result.content,
      projectScope: first.project_scope,
      scopeGroup: first.scope_group,
      tier: opts.tier,
      embedding,
      archiveIds: cluster,
    });

    survivors.push({ id: survivorId, title: result.title, from: cluster });
    merged += 1;
    archived += cluster.length;
  }

  return { tier: opts.tier, clustersFound: clusters.length, merged, archived, dryRun: false, snapshotId: snap.id, survivors };
}

/** Insert the survivor row + markdown, then archive its source members. Transactional. */
function writeSurvivor(
  dbPath: string,
  rawDir: string,
  args: {
    title: string; content: string; projectScope: string | null; scopeGroup: string | null;
    tier: MemoryTier; embedding: Buffer; archiveIds: number[];
  },
): number {
  const filepath = writeSurvivorMarkdown(rawDir, args.title, args.content, args.tier, args.projectScope);

  const db = openDb(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  try {
    db.exec('BEGIN');
    const res = db.prepare(`
      INSERT INTO memories
        (path, title, tags, topic, chunk, memory_tier, project_scope, scope_group,
         confidence, decay_rate, is_active, embedding)
      VALUES (?, ?, 'consolidated', 'consolidated', ?, ?, ?, ?, 1.0, 0.02, 1, ?)
    `).run(filepath, args.title, args.content, args.tier, args.projectScope, args.scopeGroup, args.embedding);
    const survivorId = Number(res.lastInsertRowid);

    const now = Math.floor(Date.now() / 1000);
    const archive = db.prepare(
      'UPDATE memories SET is_active = 0, archived_at = ?, consolidated_into = ? WHERE id = ?'
    );
    for (const id of args.archiveIds) archive.run(now, survivorId, id);

    db.exec('COMMIT');
    return survivorId;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
}

function writeSurvivorMarkdown(
  rawDir: string, title: string, content: string, tier: MemoryTier, projectScope: string | null,
): string {
  const topicDir = join(rawDir, 'consolidated');
  mkdirSync(topicDir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  const filename = `${today()}-${slug}-${Date.now().toString(36).slice(-6)}.md`;
  const filepath = join(topicDir, filename);
  writeFileSync(filepath, `---
title: ${title}
topic: consolidated
tier: ${tier}
project_scope: ${projectScope ?? ''}
tags: consolidated
date: ${today()}
source: consolidation
---

${content}
`, 'utf-8');
  return `consolidated/${filename}`;
}

// ─── archive recovery ─────────────────────────────────────────────────────────

export interface ArchivedMemory {
  id: number;
  title: string;
  archived_at: number;
  consolidated_into: number | null;
}

/** List memories that were archived by consolidation, newest first. */
export function listArchived(dbPath: string = DB_PATH): ArchivedMemory[] {
  if (!existsSync(dbPath)) return [];
  const db = openDb(dbPath);
  try {
    return db.prepare(
      `SELECT id, title, archived_at, consolidated_into
       FROM memories
       WHERE archived_at IS NOT NULL AND is_active = 0
       ORDER BY archived_at DESC, id DESC`
    ).all() as unknown as ArchivedMemory[];
  } finally {
    db.close();
  }
}

/**
 * Reactivate a single consolidated-away memory (undo for one original).
 * Clears archived_at + consolidated_into; leaves the survivor in place.
 * Throws if the id is not an archived memory.
 */
export function unarchive(id: number, dbPath: string = DB_PATH): void {
  const db = openDb(dbPath);
  try {
    const row = db.prepare('SELECT archived_at FROM memories WHERE id = ?')
      .get(id) as { archived_at: number | null } | undefined;
    if (!row || row.archived_at === null) throw new Error(`memory ${id} is not an archived memory`);
    db.prepare(
      'UPDATE memories SET is_active = 1, archived_at = NULL, consolidated_into = NULL WHERE id = ?'
    ).run(id);
  } finally {
    db.close();
  }
}

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  ensureSchema(db);
  return db;
}
