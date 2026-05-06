#!/usr/bin/env tsx
/**
 * Semantic search over memory/raw/.
 *
 * Usage:
 *   npm run search -- "how do we handle auth"
 *   npx tsx scripts/search.ts "JWT refresh flow" --top 3
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { search } from '../lib/memory.ts';

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'memory', 'memory.db');

function parseArgs(): { query: string; top: number } {
  const args = process.argv.slice(2);
  const topIndex = args.indexOf('--top');
  const top = topIndex !== -1 ? parseInt(args[topIndex + 1], 10) : 5;
  const query = args.filter((_, i) => i !== topIndex && i !== topIndex + 1).join(' ');
  return { query, top };
}

async function main() {
  const { query, top } = parseArgs();

  if (!query) {
    console.error('Usage: tsx search.ts "<query>" [--top N]');
    process.exit(1);
  }

  if (!existsSync(DB_PATH)) {
    console.error('No index found. Run: npm run reindex');
    process.exit(1);
  }

  const results = await search(query, top);

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const [i, r] of results.entries()) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${i + 1}] ${r.title}  (topic: ${r.topic})  score: ${r.distance.toFixed(4)}`);
    console.log(`    ${r.path}`);
    console.log(`\n${r.chunk.slice(0, 400)}${r.chunk.length > 400 ? '...' : ''}`);
  }
}

main().catch(console.error);
