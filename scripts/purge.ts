#!/usr/bin/env tsx
/**
 * Purge memories by ID or semantic query.
 *
 * Usage:
 *   npm run purge -- --id 42              # dry-run: show what would be purged
 *   npm run purge -- --id 42 --apply      # deactivate and move file to _purged/
 *   npm run purge -- --query "JWT auth"   # show top 5 matches
 *   npm run purge -- --query "JWT auth" --apply        # purge top match
 *   npm run purge -- --query "JWT auth" --apply --top 3  # purge top 3 matches
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { search, DB_PATH, RAW_DIR } from '../lib/memory.ts';

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PURGED_DIR = join(RAW_DIR, '_purged');

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const GREY   = '\x1b[90m';
const DIM    = '\x1b[2m';

interface MemoryRow {
  id: number;
  path: string;
  title: string;
  topic: string;
  chunk: string;
  confidence: number;
  access_count: number;
  memory_tier: string;
}

function purgeById(db: DatabaseSync, id: number, apply: boolean): void {
  const row = db.prepare(`
    SELECT id, path, title, topic, chunk, confidence, access_count, memory_tier
    FROM memories WHERE id = ?
  `).get(id) as MemoryRow | undefined;

  if (!row) {
    console.log(`${RED}No memory found with id ${id}${RESET}`);
    return;
  }

  console.log(`\n${BOLD}Memory #${row.id}${RESET}`);
  console.log(`  ${BOLD}Title:${RESET}  ${row.title}`);
  console.log(`  ${BOLD}Topic:${RESET}  ${row.topic}`);
  console.log(`  ${BOLD}Tier:${RESET}   ${row.memory_tier}`);
  console.log(`  ${BOLD}Path:${RESET}   ${row.path}`);
  console.log(`  ${DIM}confidence: ${row.confidence?.toFixed(2) ?? 'N/A'} | accesses: ${row.access_count ?? 0}${RESET}`);
  console.log(`  ${GREY}${row.chunk.slice(0, 200)}${row.chunk.length > 200 ? '...' : ''}${RESET}`);

  if (!apply) {
    console.log(`\n${YELLOW}Dry-run — pass --apply to purge this memory.${RESET}\n`);
    return;
  }

  _applyPurge(db, row);
  console.log(`\n${RED}✕ Purged memory #${row.id}${RESET}\n`);
}

function _applyPurge(db: DatabaseSync, row: MemoryRow): void {
  db.prepare('UPDATE memories SET is_active = 0 WHERE id = ?').run(row.id);

  // Move markdown file to _purged/
  if (row.path) {
    const srcPath = join(RAW_DIR, row.path);
    if (existsSync(srcPath)) {
      mkdirSync(PURGED_DIR, { recursive: true });
      const destPath = join(PURGED_DIR, basename(row.path));
      renameSync(srcPath, destPath);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const idIdx = args.indexOf('--id');
  const queryIdx = args.indexOf('--query');
  const topIdx = args.indexOf('--top');
  const topN = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : 1;

  if (idIdx === -1 && queryIdx === -1) {
    console.log(`Usage:
  npm run purge -- --id <n>                      # purge by ID
  npm run purge -- --query "<text>"              # purge by semantic search
  npm run purge -- --query "<text>" --top <n>    # purge top N results
  Add --apply to commit changes (default is dry-run)`);
    process.exit(1);
  }

  if (!apply) {
    console.log(`\n${YELLOW}Dry-run mode — pass --apply to commit changes${RESET}`);
  }

  if (!existsSync(DB_PATH)) {
    console.log(`${RED}No database found at ${DB_PATH}${RESET}`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);

  if (idIdx !== -1) {
    const id = parseInt(args[idIdx + 1], 10);
    if (isNaN(id)) { console.log(`${RED}Invalid id: ${args[idIdx + 1]}${RESET}`); process.exit(1); }
    purgeById(db, id, apply);
  } else {
    const query = args[queryIdx + 1];
    if (!query) { console.log(`${RED}--query requires a search string${RESET}`); process.exit(1); }

    console.log(`\nSearching for: "${query}"\n`);
    const results = await search(query, 5);

    if (results.length === 0) {
      console.log(`${GREY}No memories found matching that query.${RESET}\n`);
      db.close();
      return;
    }

    console.log(`${BOLD}Top ${results.length} results:${RESET}\n`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const marker = apply && i < topN ? `${RED}[WILL PURGE]${RESET} ` : '';
      console.log(`  ${marker}${CYAN}#${i + 1}${RESET} id:${r.id}  dist:${r.distance.toFixed(4)}  ${BOLD}${r.title}${RESET} ${GREY}(${r.topic})${RESET}`);
      console.log(`    ${DIM}${r.chunk.slice(0, 150)}${r.chunk.length > 150 ? '...' : ''}${RESET}`);
      console.log();
    }

    if (!apply) {
      console.log(`${YELLOW}Dry-run — pass --apply to purge the top result (or --top N for top N).${RESET}\n`);
    } else {
      const toPurge = results.slice(0, topN);
      for (const r of toPurge) {
        const row = db.prepare(`
          SELECT id, path, title, topic, chunk, confidence, access_count, memory_tier
          FROM memories WHERE id = ?
        `).get(r.id) as MemoryRow | undefined;
        if (row) {
          _applyPurge(db, row);
          console.log(`${RED}✕ Purged memory #${row.id}: ${row.title}${RESET}`);
        }
      }
      console.log();
    }
  }

  db.close();
}

main().catch(console.error);
