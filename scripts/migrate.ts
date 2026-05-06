#!/usr/bin/env tsx
/**
 * Apply incremental schema migrations to the Engram DB.
 * Run automatically by reindex.ts and on-prompt/on-stop hooks via lib/migrate.ts.
 *
 * Usage:
 *   npm run migrate
 */

import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { ensureSchema, CURRENT_VERSION } from '../lib/migrate.ts';

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ENGRAM_DIR, 'memory', 'memory.db');

async function main() {
  if (!existsSync(DB_PATH)) {
    console.log('No DB found — run npm run reindex to create one.');
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  ensureSchema(db);
  db.close();
  console.log(`Schema is up to date (v${CURRENT_VERSION}).`);
}

main().catch(console.error);
