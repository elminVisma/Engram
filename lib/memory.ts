/**
 * Core Engram memory primitives.
 * Shared by scripts, hooks, and the client wrapper.
 */

import { DatabaseSync } from 'node:sqlite';
import { pipeline } from '@huggingface/transformers';
import { spawnSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureSchema } from './migrate.ts';
import {
  DUPLICATE_THRESHOLD, SUPERSESSION_THRESHOLD, INJECTION_THRESHOLD,
  PROMOTE_ACCESS_THRESHOLD, SIGNAL_PHRASES,
  serialize, cosineDistance, today, hasSignal,
  sanitizeTopic, getTopicFromGit, getProjectScope,
  chunkText, stripJsonFences, decideSave, heuristicExtract,
  type MemoryTier, type SaveDecision, type HeuristicExtract,
} from './utils.ts';

export {
  DUPLICATE_THRESHOLD, SUPERSESSION_THRESHOLD, INJECTION_THRESHOLD,
  PROMOTE_ACCESS_THRESHOLD, SIGNAL_PHRASES,
  serialize, cosineDistance, today, hasSignal,
  sanitizeTopic, getTopicFromGit, getProjectScope,
  chunkText, stripJsonFences, decideSave, heuristicExtract,
  type MemoryTier, type SaveDecision, type HeuristicExtract,
};

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_DIR = join(ENGRAM_DIR, 'memory', 'raw');
export const DB_PATH = join(ENGRAM_DIR, 'memory', 'memory.db');

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
// Task 10: allow override via env var
const CLASSIFY_MODEL = process.env.ENGRAM_MODEL ?? 'claude-haiku-4-5-20251001';

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
  projectScope?: string | null
): Promise<SearchResult[]> {
  if (!existsSync(DB_PATH)) return [];

  const scope = projectScope !== undefined ? projectScope : getProjectScope();

  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' });
  const out = await extractor(query, { pooling: 'mean', normalize: true });
  const queryEmbedding = serialize(Array.from(out.data as Float32Array));

  const db = openDb(DB_PATH);

  const SELECT = `
    SELECT id, path, title, topic, chunk, is_active, superseded_by,
           memory_tier, project_scope, confidence, access_count, embedding
    FROM memories
    WHERE is_active = 1 AND embedding IS NOT NULL
  `;

  const longTerm = db.prepare(`${SELECT} AND memory_tier = 'long'`)
    .all() as EmbeddingRow[];

  const shortTerm = scope !== null
    ? (db.prepare(`${SELECT} AND memory_tier = 'short' AND (project_scope = ? OR project_scope IS NULL)`)
        .all(scope) as EmbeddingRow[])
    : (db.prepare(`${SELECT} AND memory_tier = 'short'`)
        .all() as EmbeddingRow[]);

  // Deduplicate by id, compute distances, sort
  const seen = new Set<number>();
  const scored: Array<EmbeddingRow & { distance: number }> = [];
  for (const r of [...longTerm, ...shortTerm]) {
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
export async function searchAll(query: string, topK = 20): Promise<SearchResult[]> {
  if (!existsSync(DB_PATH)) return [];

  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' });
  const out = await extractor(query, { pooling: 'mean', normalize: true });
  const queryEmbedding = serialize(Array.from(out.data as Float32Array));

  const db = openDb(DB_PATH);

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

  const mergedOpts: SaveOptions & { tier: MemoryTier; projectScope: string | null } = {
    ...opts,
    tier,
    projectScope,
  };

  if (!existsSync(DB_PATH)) {
    _writeMarkdown(title, topic, content, mergedOpts);
    return;
  }

  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' });
  const out = await extractor(content, { pooling: 'mean', normalize: true });
  const embedding = serialize(Array.from(out.data as Float32Array));

  // Task 14: single DB connection with WAL mode
  const db = openDb(DB_PATH);
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
    const filepath = _writeMarkdown(title, topic, content, mergedOpts);

    // Write + supersede inside a transaction
    db.exec('BEGIN');
    try {
      const result = db.prepare(`
        INSERT INTO memories
          (path, title, tags, topic, chunk, session_id, source_excerpt,
           memory_tier, project_scope, confidence, decay_rate, supersedes, is_active, file_hash, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 0.02, ?, 1, NULL, ?)
      `).run(
        filepath, title, mergedOpts.tags ?? 'auto', topic, content,
        mergedOpts.sessionId ?? null, mergedOpts.sourceExcerpt ?? null,
        mergedOpts.tier, mergedOpts.projectScope, supersededId, embedding
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
  opts: SaveOptions & { tier: MemoryTier; projectScope: string | null }
): string {
  // Task 6: sanitize topic for directory/path construction
  const safeTopic = sanitizeTopic(topic);
  const topicDir = join(RAW_DIR, safeTopic);
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

/**
 * Use Haiku to decide if a response contains a learning worth saving.
 * Saves as short-term memory scoped to the current project.
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
  const haikuDisabled = process.env.ENGRAM_DISABLE_HAIKU === '1';

  if (haikuDisabled) {
    const extracted = heuristicExtract(responseText);
    if (!extracted) return;
    await saveMemory(extracted.title, topic ?? getTopicFromGit(), extracted.content, {
      sessionId, sourceExcerpt: extracted.excerpt, tier: 'short', projectScope: scope,
    });
    return;
  }

  const prompt = `Does this response contain a non-obvious technical learning worth saving to long-term memory?

SAVE: non-obvious discoveries, bug root causes, patterns, constraints, gotchas, non-obvious decisions.
SKIP: routine code generation, obvious explanations, status updates, conversational filler.

Response:
${responseText.slice(0, 2000)}

JSON only — no other text:
{"worth_saving": true, "title": "under 8 words", "content": "1-3 sentences", "excerpt": "verbatim sentence that triggered this"}
or
{"worth_saving": false}`;

  let text = '';
  try {
    // --setting-sources "" prevents loading ~/.claude/settings.json (avoids hook recursion)
    // spawnSync instead of execSync so exit code 1 ("Reached max turns") doesn't throw
    const result = spawnSync(
      'claude',
      ['-p', '-', '--model', CLASSIFY_MODEL, '--no-session-persistence',
       '--max-turns', '1', '--output-format', 'json', '--setting-sources', ''],
      { input: prompt, encoding: 'utf-8', timeout: 30_000 }
    );
    const raw = (result.stdout ?? '').trim();
    if (!raw) throw new Error(result.stderr ?? 'no output');
    // CLI wraps output in {"type":"result","result":"..."}
    if (raw.startsWith('{')) {
      try {
        const wrapper = JSON.parse(raw);
        text = (wrapper.result ?? wrapper.text ?? raw).trim();
      } catch { text = raw; }
    } else {
      text = raw;
    }
  } catch {
    // CLI unavailable or timed out — fall back to heuristic
    const extracted = heuristicExtract(responseText);
    if (!extracted) return;
    await saveMemory(extracted.title, topic ?? getTopicFromGit(), extracted.content, {
      sessionId, sourceExcerpt: extracted.excerpt, tier: 'short', projectScope: scope,
    });
    return;
  }

  if (!text) return;

  let parsed: { worth_saving: boolean; title?: string; content?: string; excerpt?: string };
  try { parsed = JSON.parse(stripJsonFences(text)); } catch { return; }
  if (!parsed.worth_saving || !parsed.title || !parsed.content) return;

  await saveMemory(parsed.title, topic ?? getTopicFromGit(), parsed.content, {
    sessionId,
    sourceExcerpt: parsed.excerpt,
    tier: 'short',
    projectScope: scope,
  });
}
