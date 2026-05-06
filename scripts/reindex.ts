#!/usr/bin/env tsx
/**
 * Rebuild the semantic memory index from memory/raw/.
 * Run once on any new machine after cloning, or after schema changes.
 * Uses upsert logic — unchanged files are skipped, preserving access_count and confidence.
 *
 * Usage:
 *   npm run reindex
 *   npx tsx scripts/reindex.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'crypto';
import { pipeline } from '@huggingface/transformers';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chunkText, serialize } from '../lib/memory.ts';
import { ensureSchema } from '../lib/migrate.ts';
import type { MemoryTier } from '../lib/memory.ts';

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_DIR = join(ENGRAM_DIR, 'memory', 'raw');
const DB_PATH = join(ENGRAM_DIR, 'memory', 'memory.db');
const MODEL = 'Xenova/all-MiniLM-L6-v2';

// Task 11: include confidence and access_count in MemoryRow
interface MemoryRow {
  path: string;
  title: string;
  tags: string;
  topic: string;
  chunk: string;
  session_id: string | null;
  memory_tier: MemoryTier;
  project_scope: string | null;
  confidence: number;
  access_count: number;
  file_hash: string;
}

function extractFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  let body = content;

  if (content.startsWith('---')) {
    const end = content.indexOf('---', 3);
    if (end !== -1) {
      const fm = content.slice(3, end).trim();
      body = content.slice(end + 3).trim();
      for (const line of fm.split('\n')) {
        const colon = line.indexOf(':');
        if (colon !== -1) {
          meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        }
      }
    }
  }

  return { meta, body };
}

function walkMarkdown(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '_purged' || entry === '_rejected') continue;
        files.push(...walkMarkdown(full));
      } else if (entry.endsWith('.md')) {
        files.push(full);
      }
    }
  } catch { /* directory may not exist yet */ }
  return files;
}

async function main() {
  console.log('Loading model...');
  const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'fp32' });

  const db = new DatabaseSync(DB_PATH);

  // Task 13: run schema migrations before any table operations
  ensureSchema(db);

  // Task 11: INSERT includes confidence, access_count, and embedding
  const insertMemory = db.prepare(`
    INSERT INTO memories
      (path, title, tags, topic, chunk, session_id, is_active, memory_tier, project_scope,
       confidence, access_count, file_hash, embedding)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `);

  const files = walkMarkdown(MEMORY_DIR);
  console.log(`Indexing ${files.length} files...\n`);

  // Task 12: upsert — check file_hash before processing
  const insertBatch = (rows: MemoryRow[], embeddings: Buffer[]) => {
    db.exec('BEGIN');
    try {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        insertMemory.run(
          r.path, r.title, r.tags, r.topic, r.chunk, r.session_id,
          r.memory_tier, r.project_scope, r.confidence, r.access_count, r.file_hash,
          embeddings[i]
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const deleteMemoryByPath = db.prepare('DELETE FROM memories WHERE path = ?');
  const getExistingHash = db.prepare('SELECT file_hash FROM memories WHERE path = ? LIMIT 1');
  // Reactivate memories in OTHER files that were superseded by a row we're about to delete.
  // This prevents dangling superseded_by references after a file edit.
  const reactivateOrphans = db.prepare(`
    UPDATE memories
    SET is_active = 1, superseded_by = NULL
    WHERE superseded_by IN (SELECT id FROM memories WHERE path = ?)
      AND path != ?
  `);

  let skipped = 0;
  let updated = 0;
  let inserted = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const relPath = relative(MEMORY_DIR, file);

    // Task 12: compute SHA-256 hash of file content
    const fileHash = createHash('sha256').update(content).digest('hex');

    // Check if unchanged
    const existing = getExistingHash.get(relPath) as { file_hash: string | null } | undefined;
    if (existing) {
      if (existing.file_hash === fileHash) {
        console.log(`  ↩ ${relPath} (unchanged, skipped)`);
        skipped++;
        continue;
      }
      // File changed — reactivate any memories superseded by our old rows (prevent dangling refs),
      // then delete old rows and reinsert.
      reactivateOrphans.run(relPath, relPath);
      deleteMemoryByPath.run(relPath);
      updated++;
    } else {
      inserted++;
    }

    const { meta, body } = extractFrontmatter(content);
    const topic = meta['topic'] ?? file.split('/').at(-2) ?? 'general';
    const title = meta['title'] ?? file.split('/').at(-1)?.replace('.md', '') ?? '';
    const tags = meta['tags'] ?? '';
    const sessionId = meta['session_id'] ?? null;
    const tier = (meta['tier'] === 'long' ? 'long' : 'short') as MemoryTier;
    const projectScope = meta['project_scope'] ? meta['project_scope'] : null;
    // Task 11: read confidence and access_count from frontmatter with defaults
    const confidence = meta['confidence'] ? parseFloat(meta['confidence']) : 1.0;
    const accessCount = meta['access_count'] ? parseInt(meta['access_count'], 10) : 0;

    const chunks = chunkText(body).filter(c => c.trim());
    const rows: MemoryRow[] = [];
    const embeddings: Buffer[] = [];

    for (const c of chunks) {
      const output = await extractor(c, { pooling: 'mean', normalize: true });
      rows.push({
        path: relPath, title, tags, topic, chunk: c, session_id: sessionId,
        memory_tier: tier, project_scope: projectScope,
        confidence, access_count: accessCount, file_hash: fileHash,
      });
      embeddings.push(serialize(Array.from(output.data as Float32Array)));
    }

    insertBatch(rows, embeddings);
    const tierLabel = tier === 'long' ? '[long]' : '[short]';
    const action = existing ? '↻' : '✓';
    console.log(`  ${action} ${relPath} ${tierLabel} (${chunks.length} chunk${chunks.length !== 1 ? 's' : ''})`);
  }

  db.close();
  console.log(`\nDone. ${inserted} inserted, ${updated} updated, ${skipped} skipped → ${DB_PATH}`);
}

main().catch(console.error);
