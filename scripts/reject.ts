#!/usr/bin/env tsx
/**
 * Reject a memory that Claude got wrong.
 *
 * Deactivates the memory in the DB and moves the markdown file to
 * memory/raw/_rejected/ so it is excluded from future reindex runs.
 * Optionally records a reason in the file before moving it.
 *
 * Usage:
 *   npm run reject -- --id 42              # dry-run: show what would be rejected
 *   npm run reject -- --id 42 --apply      # reject
 *   npm run reject -- --id 42 --apply --reason "Wrong — JWT rotation is optional here"
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { DB_PATH, RAW_DIR } from '../lib/memory.ts';

const REJECTED_DIR = join(RAW_DIR, '_rejected');

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREY   = '\x1b[90m';
const DIM    = '\x1b[2m';

interface MemoryRow {
  id: number;
  path: string;
  title: string;
  topic: string;
  chunk: string;
  memory_tier: string;
  confidence: number;
  access_count: number;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const idIdx = args.indexOf('--id');
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;

  if (idIdx === -1) {
    console.log(`Usage:
  npm run reject -- --id <n>                                # dry-run
  npm run reject -- --id <n> --apply                       # reject
  npm run reject -- --id <n> --apply --reason "<why wrong>"  # reject with reason`);
    process.exit(1);
  }

  const id = parseInt(args[idIdx + 1], 10);
  if (isNaN(id)) {
    console.log(`${RED}Invalid id: ${args[idIdx + 1]}${RESET}`);
    process.exit(1);
  }

  if (!existsSync(DB_PATH)) {
    console.log(`${RED}No database found. Run npm run reindex first.${RESET}`);
    process.exit(1);
  }

  if (!apply) {
    console.log(`\n${YELLOW}Dry-run mode — pass --apply to commit changes${RESET}\n`);
  }

  const db = new DatabaseSync(DB_PATH);

  const row = db.prepare(`
    SELECT id, path, title, topic, chunk, memory_tier, confidence, access_count
    FROM memories WHERE id = ?
  `).get(id) as MemoryRow | undefined;

  if (!row) {
    console.log(`${RED}No memory found with id ${id}${RESET}`);
    db.close();
    process.exit(1);
  }

  console.log(`\n${BOLD}Memory #${row.id}${RESET}`);
  console.log(`  ${BOLD}Title:${RESET}  ${row.title}`);
  console.log(`  ${BOLD}Topic:${RESET}  ${row.topic}  ${GREY}[${row.memory_tier}]${RESET}`);
  console.log(`  ${BOLD}Path:${RESET}   ${row.path}`);
  console.log(`  ${DIM}confidence: ${row.confidence?.toFixed(2) ?? 'N/A'} | accesses: ${row.access_count ?? 0}${RESET}`);
  console.log(`\n  ${GREY}${row.chunk.slice(0, 300)}${row.chunk.length > 300 ? '...' : ''}${RESET}\n`);

  if (reason) {
    console.log(`  ${BOLD}Rejection reason:${RESET} ${reason}\n`);
  }

  if (!apply) {
    console.log(`${YELLOW}→ Would deactivate in DB and move to memory/raw/_rejected/${RESET}\n`);
    db.close();
    return;
  }

  // Deactivate in DB
  db.prepare('UPDATE memories SET is_active = 0 WHERE id = ?').run(row.id);

  // Move file to _rejected/, optionally appending the reason
  if (row.path) {
    const srcPath = join(RAW_DIR, row.path);
    if (existsSync(srcPath)) {
      mkdirSync(REJECTED_DIR, { recursive: true });
      if (reason) {
        const content = readFileSync(srcPath, 'utf-8');
        writeFileSync(srcPath, `${content.trimEnd()}\n\n## Rejection reason\n\n${reason}\n`, 'utf-8');
      }
      const destPath = join(REJECTED_DIR, basename(row.path));
      renameSync(srcPath, destPath);
    }
  }

  db.close();
  console.log(`${RED}✕ Rejected memory #${row.id}: ${row.title}${RESET}\n`);
}

main().catch(console.error);
