#!/usr/bin/env tsx
/**
 * Promote short-term memories to long-term.
 *
 * A short-term memory is promoted when it has been accessed enough times to
 * signal cross-project relevance (default threshold: 3 accesses).
 *
 * Usage:
 *   npm run promote               # dry-run — shows what would be promoted
 *   npm run promote -- --apply    # write changes to the DB
 *   npm run promote -- --min 5    # custom access threshold
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PROMOTE_ACCESS_THRESHOLD, DB_PATH, RAW_DIR } from '../lib/memory.ts';

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const GREY   = '\x1b[90m';
const DIM    = '\x1b[2m';

interface MemoryRow {
  id: number;
  path: string;
  title: string;
  topic: string;
  project_scope: string | null;
  access_count: number;
  confidence: number;
  created_at: number;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const minIdx = args.indexOf('--min');
  const threshold = minIdx !== -1 ? parseInt(args[minIdx + 1], 10) : PROMOTE_ACCESS_THRESHOLD;

  if (!apply) {
    console.log(`\n${YELLOW}Dry-run mode — pass --apply to commit changes${RESET}\n`);
  }

  const db = new DatabaseSync(DB_PATH);

  const candidates = db.prepare(`
    SELECT id, path, title, topic, project_scope, access_count, confidence, created_at
    FROM memories
    WHERE is_active = 1
      AND memory_tier = 'short'
      AND access_count >= ?
    ORDER BY access_count DESC
  `).all(threshold) as unknown as MemoryRow[];

  if (candidates.length === 0) {
    console.log(`${GREY}No short-term memories have reached the promotion threshold (${threshold} accesses).${RESET}\n`);
    db.close();
    return;
  }

  console.log(`\n${BOLD}${GREEN}Memories eligible for promotion (${candidates.length})${RESET}\n`);

  for (const m of candidates) {
    const age = Math.round((Date.now() / 1000 - m.created_at) / 86400);
    console.log(`  ${BOLD}${m.title}${RESET} ${GREY}(${m.topic})${RESET}`);
    console.log(`  ${DIM}scope: ${m.project_scope ?? 'unscoped'} · accesses: ${m.access_count} · age: ${age}d · confidence: ${m.confidence.toFixed(2)}${RESET}`);

    if (apply) {
      // Update DB: clear project_scope, set tier to long
      db.prepare(`
        UPDATE memories
        SET memory_tier = 'long', project_scope = NULL
        WHERE id = ?
      `).run(m.id);

      // Update the markdown frontmatter on disk
      _updateMarkdownTier(m.path);

      console.log(`  ${GREEN}✓ promoted to long-term${RESET}`);
    } else {
      console.log(`  ${YELLOW}→ would promote to long-term${RESET}`);
    }
    console.log();
  }

  db.close();

  const action = apply ? 'promoted' : 'would promote';
  console.log(`${CYAN}${candidates.length} ${action} to long-term memory${RESET}\n`);
}

function _updateMarkdownTier(relPath: string): void {
  try {
    const fullPath = join(RAW_DIR, relPath);
    let content = readFileSync(fullPath, 'utf-8');

    // Replace tier: short → tier: long in frontmatter
    content = content.replace(/^tier:\s*short\s*$/m, 'tier: long');
    // Clear project_scope in frontmatter
    content = content.replace(/^project_scope:.*$/m, 'project_scope: ');

    writeFileSync(fullPath, content, 'utf-8');
  } catch {
    // File may not exist on disk if it was only in the DB — skip silently
  }
}

main().catch(console.error);
