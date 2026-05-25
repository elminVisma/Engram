/**
 * Core Engram memory primitives.
 * Shared by scripts, hooks, and the client wrapper.
 */

import { DatabaseSync } from 'node:sqlite';
import { pipeline } from '@huggingface/transformers';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureSchema } from './migrate.ts';
import {
  DUPLICATE_THRESHOLD, SUPERSESSION_THRESHOLD, INJECTION_THRESHOLD,
  PROMOTE_ACCESS_THRESHOLD, SIGNAL_PHRASES,
  serialize, cosineDistance, today, hasSignal,
  sanitizeTopic, getTopicFromGit, getProjectScope,
  chunkText, stripJsonFences, decideSave, heuristicExtract, detectUserScope,
  findScopeGroup, loadEngramConfig, getScopeGroup,
  buildClassifyPrompt, parseClassifyOutput, runClassifier,
  isPruneable, isHardDeletable,
  type MemoryTier, type SaveDecision, type HeuristicExtract, type ClassifyDecision,
  type PrunableMemory, type HardDeletableMemory,
} from './utils.ts';

export {
  DUPLICATE_THRESHOLD, SUPERSESSION_THRESHOLD, INJECTION_THRESHOLD,
  PROMOTE_ACCESS_THRESHOLD, SIGNAL_PHRASES,
  serialize, cosineDistance, today, hasSignal,
  sanitizeTopic, getTopicFromGit, getProjectScope,
  chunkText, stripJsonFences, decideSave, heuristicExtract, detectUserScope,
  findScopeGroup, loadEngramConfig, getScopeGroup,
  buildClassifyPrompt, parseClassifyOutput, runClassifier,
  isPruneable, isHardDeletable, PRUNE_AGE_DAYS, HARD_DELETE_AGE_DAYS,
  type MemoryTier, type SaveDecision, type HeuristicExtract, type ClassifyDecision,
  type PrunableMemory, type HardDeletableMemory,
};

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_DIR = join(ENGRAM_DIR, 'memory', 'raw');
export const DB_PATH = join(ENGRAM_DIR, 'memory', 'memory.db');

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

const MIN_RESPONSE_LENGTH = 200;

export interface SearchResult {
  id: number;
  path: string;
  title: string;
  topic: string;
  chunk: string;
  distance: number;
  is_active: number;
  superseded_by: number | null;
  memory_tier: MemoryTier;
  project_scope: string | null;
  confidence: number;
  access_count: number;
}

export interface SaveOptions {
  sessionId?: string;
  sourceExcerpt?: string;
  tags?: string;
  tier?: MemoryTier;
  projectScope?: string | null;
  scopeGroup?: string | null;
  /** Override DB path (test isolation). Defaults to DB_PATH. */
  dbPath?: string;
  /** Override markdown root (test isolation). Defaults to RAW_DIR. */
  rawDir?: string;
}

/** Open the DB and run schema migrations. */
function openDb(path: string = DB_PATH): DatabaseSync {
  const db = new DatabaseSync(path);
  ensureSchema(db);
  return db;
}

type EmbeddingRow = Omit<SearchResult, 'distance'> & { embedding: Uint8Array };

/**
 * Tier-aware semantic search.
 *
 * Returns long-term memories (global) + short-term memories scoped to the
 * current project. Unscoped short-term memories (project_scope IS NULL) are
 * included regardless. Access count is incremented for every returned result.
 */
export async function search(
  query: string,
  topK = 5,
  projectScope?: string | null,
  dbPath: string = DB_PATH,
): Promise<SearchResult[]> {
  if (!existsSync(dbPath)) return [];

  const scope = projectScope !== undefined ? projectScope : getProjectScope();
  const scopeGroup = findScopeGroup(scope, loadEngramConfig());

  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' });
  const out = await extractor(query, { pooling: 'mean', normalize: true });
  const queryEmbedding = serialize(Array.from(out.data as Float32Array));

  const db = openDb(dbPath);

  const SELECT = `
    SELECT id, path, title, topic, chunk, is_active, superseded_by,
           memory_tier, project_scope, confidence, access_count, embedding
    FROM memories
    WHERE is_active = 1 AND embedding IS NOT NULL
  `;

  const longTerm = db.prepare(`${SELECT} AND memory_tier = 'long'`)
    .all() as EmbeddingRow[];

  const userTier = db.prepare(`${SELECT} AND memory_tier = 'user'`)
    .all() as EmbeddingRow[];

  const sharedTier = scopeGroup
    ? (db.prepare(`${SELECT} AND memory_tier = 'shared' AND scope_group = ?`)
        .all(scopeGroup) as EmbeddingRow[])
    : [];

  const shortTerm = scope !== null
    ? (db.prepare(`${SELECT} AND memory_tier = 'short' AND (project_scope = ? OR project_scope IS NULL)`)
        .all(scope) as EmbeddingRow[])
    : (db.prepare(`${SELECT} AND memory_tier = 'short'`)
        .all() as EmbeddingRow[]);

  // Deduplicate by id, compute distances, sort
  const seen = new Set<number>();
  const scored: Array<EmbeddingRow & { distance: number }> = [];
  for (const r of [...longTerm, ...userTier, ...sharedTier, ...shortTerm]) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      scored.push({ ...r, distance: cosineDistance(queryEmbedding, r.embedding) });
    }
  }
  scored.sort((a, b) => a.distance - b.distance);

  const results: SearchResult[] = scored.slice(0, topK).map(r => ({
    id: r.id, path: r.path, title: r.title, topic: r.topic, chunk: r.chunk,
    distance: r.distance, is_active: r.is_active, superseded_by: r.superseded_by,
    memory_tier: r.memory_tier, project_scope: r.project_scope,
    confidence: r.confidence, access_count: r.access_count,
  }));

  // Update access counts
  if (results.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    const update = db.prepare(
      'UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
    );
    db.exec('BEGIN');
    try {
      for (const r of results) update.run(now, r.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  db.close();
  return results;
}

/** Search including superseded memories — used by the why CLI. */
export async function searchAll(
  query: string,
  topK = 20,
  dbPath: string = DB_PATH,
): Promise<SearchResult[]> {
  if (!existsSync(dbPath)) return [];

  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' });
  const out = await extractor(query, { pooling: 'mean', normalize: true });
  const queryEmbedding = serialize(Array.from(out.data as Float32Array));

  const db = openDb(dbPath);

  const rows = db.prepare(`
    SELECT id, path, title, topic, chunk, is_active, superseded_by,
           memory_tier, project_scope, confidence, access_count, embedding
    FROM memories
    WHERE embedding IS NOT NULL
  `).all() as EmbeddingRow[];

  db.close();

  return rows
    .map(r => ({
      id: r.id, path: r.path, title: r.title, topic: r.topic, chunk: r.chunk,
      distance: cosineDistance(queryEmbedding, r.embedding),
      is_active: r.is_active, superseded_by: r.superseded_by,
      memory_tier: r.memory_tier, project_scope: r.project_scope,
      confidence: r.confidence, access_count: r.access_count,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topK);
}

/** Write a memory to disk, handle supersession, and index. */
export async function saveMemory(
  title: string,
  topic: string,
  content: string,
  opts: SaveOptions = {}
): Promise<void> {
  const tier: MemoryTier = opts.tier ?? 'short';
  const projectScope = opts.projectScope !== undefined
    ? opts.projectScope
    : (tier === 'short' ? getProjectScope() : null);
  const dbPath = opts.dbPath ?? DB_PATH;
  const rawDir = opts.rawDir ?? RAW_DIR;

  const mergedOpts: SaveOptions & { tier: MemoryTier; projectScope: string | null } = {
    ...opts,
    tier,
    projectScope,
  };

  if (!existsSync(dbPath)) {
    _writeMarkdown(title, topic, content, mergedOpts, rawDir);
    return;
  }

  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' });
  const out = await extractor(content, { pooling: 'mean', normalize: true });
  const embedding = serialize(Array.from(out.data as Float32Array));

  // Task 14: single DB connection with WAL mode
  const db = openDb(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  try {
    // Load all active embeddings and find nearest neighbours
    const candidates = db.prepare(
      'SELECT id, embedding FROM memories WHERE is_active = 1 AND embedding IS NOT NULL'
    ).all() as Array<{ id: number; embedding: Uint8Array }>;

    const scored = candidates
      .map(c => ({ id: c.id, distance: cosineDistance(embedding, c.embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);

    const decision = decideSave(scored);
    if (decision === 'skip') return;
    const supersededId = decision === 'new' ? null : (decision as { supersede: number }).supersede;

    // File I/O outside transaction (unavoidable)
    const filepath = _writeMarkdown(title, topic, content, mergedOpts, rawDir);

    // Write + supersede inside a transaction
    db.exec('BEGIN');
    try {
      const result = db.prepare(`
        INSERT INTO memories
          (path, title, tags, topic, chunk, session_id, source_excerpt,
           memory_tier, project_scope, scope_group, confidence, decay_rate, supersedes, is_active, file_hash, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 0.02, ?, 1, NULL, ?)
      `).run(
        filepath, title, mergedOpts.tags ?? 'auto', topic, content,
        mergedOpts.sessionId ?? null, mergedOpts.sourceExcerpt ?? null,
        mergedOpts.tier, mergedOpts.projectScope, mergedOpts.scopeGroup ?? null,
        supersededId, embedding
      );

      const newId = Number(result.lastInsertRowid);

      if (supersededId !== null) {
        db.prepare('UPDATE memories SET is_active = 0, superseded_by = ? WHERE id = ?').run(newId, supersededId);
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

function _writeMarkdown(
  title: string,
  topic: string,
  content: string,
  opts: SaveOptions & { tier: MemoryTier; projectScope: string | null },
  rawDir: string = RAW_DIR,
): string {
  // Task 6: sanitize topic for directory/path construction
  const safeTopic = sanitizeTopic(topic);
  const topicDir = join(rawDir, safeTopic);
  mkdirSync(topicDir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  // Task 2: add timestamp suffix to prevent filename collisions
  const filename = `${today()}-${slug}-${Date.now().toString(36).slice(-6)}.md`;
  const filepath = join(topicDir, filename);

  writeFileSync(filepath, `---
title: ${title}
topic: ${topic}
tier: ${opts.tier}
project_scope: ${opts.projectScope ?? ''}
tags: ${opts.tags ?? 'auto'}
date: ${today()}
source: auto
session_id: ${opts.sessionId ?? ''}
confidence: 1.0
access_count: 0
---

${content}
`, 'utf-8');

  return `${safeTopic}/${filename}`;
}

// ─── Phase 4: prune + promote provisional ────────────────────────────────────

export interface PruneResult {
  eligible: number;
  softDeleted: number;
  hardDeleted: number;
}

/**
 * Soft-delete provisional memories that are stale (>14d, 0 accesses, confidence<0.5).
 * Hard-delete provisional memories that were soft-deleted and are >60d old.
 * Pass apply=true to commit; dry-run by default.
 */
export async function pruneProvisional(
  opts: { apply?: boolean; dbPath?: string } = {},
): Promise<PruneResult> {
  const dbPath = opts.dbPath ?? DB_PATH;
  if (!existsSync(dbPath)) return { eligible: 0, softDeleted: 0, hardDeleted: 0 };

  const db = openDb(dbPath);
  const now = Math.floor(Date.now() / 1000);

  const softCandidates = db.prepare(
    `SELECT id, memory_tier, created_at, access_count, confidence
     FROM memories WHERE is_active = 1 AND memory_tier = 'provisional'`
  ).all() as Array<PrunableMemory & { id: number }>;

  const hardCandidates = db.prepare(
    `SELECT id, is_active, memory_tier, created_at
     FROM memories WHERE is_active = 0 AND memory_tier = 'provisional'`
  ).all() as Array<HardDeletableMemory & { id: number }>;

  const toSoft = softCandidates.filter(m => isPruneable(m, now));
  const toHard = hardCandidates.filter(m => isHardDeletable(m, now));

  if (opts.apply && (toSoft.length > 0 || toHard.length > 0)) {
    db.exec('BEGIN');
    try {
      for (const m of toSoft) db.prepare('UPDATE memories SET is_active = 0 WHERE id = ?').run(m.id);
      for (const m of toHard) db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }

  db.close();
  return {
    eligible: toSoft.length,
    softDeleted: opts.apply ? toSoft.length : 0,
    hardDeleted: opts.apply ? toHard.length : 0,
  };
}

/**
 * Promote provisional memories that have reached the access threshold to short tier.
 * Returns the count of memories promoted.
 */
export function promoteProvisional(
  dbPath: string = DB_PATH,
  threshold: number = PROMOTE_ACCESS_THRESHOLD,
): number {
  if (!existsSync(dbPath)) return 0;
  const db = openDb(dbPath);
  try {
    const candidates = db.prepare(
      `SELECT id FROM memories
       WHERE is_active = 1 AND memory_tier = 'provisional' AND access_count >= ?`
    ).all(threshold) as Array<{ id: number }>;

    if (candidates.length === 0) return 0;

    db.exec('BEGIN');
    try {
      for (const m of candidates) {
        db.prepare(
          `UPDATE memories SET memory_tier = 'short', previous_tier = 'provisional' WHERE id = ?`
        ).run(m.id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return candidates.length;
  } finally {
    db.close();
  }
}

// ─── autoRemember pipeline ───────────────────────────────────────────────────
// The pure pieces — buildClassifyPrompt / parseClassifyOutput / runClassifier
// — live in lib/utils.ts so they can be tested without loading transformers.

/** Save via heuristicExtract — used when the classifier is disabled or fails. */
async function fallbackHeuristic(
  responseText: string,
  topic: string | undefined,
  sessionId: string | undefined,
  scope: string | null,
): Promise<void> {
  const extracted = heuristicExtract(responseText);
  if (!extracted) return;
  const isUser = detectUserScope(responseText);
  await saveMemory(extracted.title, topic ?? getTopicFromGit(), extracted.content, {
    sessionId,
    sourceExcerpt: extracted.excerpt,
    tier: isUser ? 'user' : 'provisional',
    projectScope: isUser ? null : scope,
  });
}

/**
 * Use Haiku (or the heuristic fallback) to decide if a response contains a
 * learning worth saving. Saves as short-term memory scoped to the current project.
 */
export async function autoRemember(
  responseText: string,
  topic?: string,
  sessionId?: string,
  projectScope?: string | null
): Promise<void> {
  if (!responseText || responseText.length < MIN_RESPONSE_LENGTH) return;
  if (!hasSignal(responseText)) return;

  const scope = projectScope !== undefined ? projectScope : getProjectScope();

  if (process.env.ENGRAM_DISABLE_HAIKU === '1') {
    return fallbackHeuristic(responseText, topic, sessionId, scope);
  }

  let raw: string;
  try { raw = runClassifier(buildClassifyPrompt(responseText)); }
  catch { return fallbackHeuristic(responseText, topic, sessionId, scope); }

  const decision = parseClassifyOutput(raw);
  if (!decision || !decision.worth_saving || !decision.title || !decision.content) return;

  const isUser = decision.scope === 'user' || detectUserScope(decision.content);
  const isShared = !isUser && decision.scope === 'shared';
  const scopeGroup = isShared ? getScopeGroup() : null;
  await saveMemory(decision.title, topic ?? getTopicFromGit(), decision.content, {
    sessionId,
    sourceExcerpt: decision.excerpt,
    tier: isUser ? 'user' : (isShared ? 'shared' : 'provisional'),
    projectScope: isUser ? null : scope,
    scopeGroup: isShared ? scopeGroup : null,
  });
}
