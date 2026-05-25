#!/usr/bin/env tsx
/**
 * Show Engram memory statistics: counts by tier, top accessed memories,
 * and prune candidates.
 *
 * Usage:
 *   npm run stats
 *   npm run stats -- --top 10
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'fs';
import { DB_PATH, PRUNE_AGE_DAYS, PROMOTE_ACCESS_THRESHOLD } from '../lib/memory.ts';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const GREY   = '\x1b[90m';
const DIM    = '\x1b[2m';

const TIERS = ['pinned', 'user', 'shared', 'long', 'short', 'provisional'] as const;

async function main() {
  const args = process.argv.slice(2);
  const topIdx = args.indexOf('--top');
  const TOP_N = topIdx !== -1 ? parseInt(args[topIdx + 1] ?? '5', 10) : 5;

  if (!existsSync(DB_PATH)) {
    process.stderr.write(`No database found at ${DB_PATH}\nRun npm run reindex first.\n`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  console.log(`\n${BOLD}${CYAN}Engram Memory Statistics${RESET}\n`);

  // ── Counts by tier ────────────────────────────────────────────────────────
  console.log(`${BOLD}Active memories by tier${RESET}`);
  let total = 0;
  for (const tier of TIERS) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE is_active = 1 AND memory_tier = ?`
    ).get(tier) as { n: number };
    total += row.n;
    if (row.n > 0) {
      const color = tier === 'pinned' ? CYAN : tier === 'provisional' ? YELLOW : GREEN;
      console.log(`  ${color}${tier.padEnd(12)}${RESET}  ${row.n}`);
    }
  }
  const inactive = (db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE is_active = 0`).get() as { n: number }).n;
  console.log(`  ${'inactive'.padEnd(12)}  ${GREY}${inactive}${RESET}`);
  console.log(`  ${'total (active)'.padEnd(12)}  ${BOLD}${total}${RESET}`);

  // ── Top accessed ──────────────────────────────────────────────────────────
  console.log(`\n${BOLD}Top ${TOP_N} most accessed${RESET}`);
  const topRows = db.prepare(`
    SELECT title, topic, memory_tier, access_count
    FROM memories
    WHERE is_active = 1
    ORDER BY access_count DESC
    LIMIT ?
  `).all(TOP_N) as Array<{ title: string; topic: string; memory_tier: string; access_count: number }>;

  if (topRows.length === 0) {
    console.log(`  ${GREY}none yet${RESET}`);
  } else {
    for (const r of topRows) {
      console.log(`  ${BOLD}${r.title}${RESET} ${DIM}(${r.topic} / ${r.memory_tier})${RESET}  ×${r.access_count}`);
    }
  }

  // ── Prune candidates ──────────────────────────────────────────────────────
  const nowUnix = Math.floor(Date.now() / 1000);
  const cutoff = nowUnix - PRUNE_AGE_DAYS * 86400;

  const pruneCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM memories
    WHERE is_active = 1
      AND memory_tier = 'provisional'
      AND created_at < ?
      AND access_count = 0
      AND confidence < 0.5
  `).get(cutoff) as { n: number }).n;

  console.log(`\n${BOLD}Prune candidates${RESET} (provisional, >${PRUNE_AGE_DAYS}d, 0 accesses, conf<0.5)`);
  if (pruneCount === 0) {
    console.log(`  ${GREEN}none — nothing to prune${RESET}`);
  } else {
    console.log(`  ${RED}${pruneCount}${RESET} ${DIM}— run: npm run prune -- --apply${RESET}`);
  }

  // ── Promote candidates ────────────────────────────────────────────────────
  const promoteCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM memories
    WHERE is_active = 1
      AND memory_tier = 'provisional'
      AND access_count >= ?
  `).get(PROMOTE_ACCESS_THRESHOLD) as { n: number }).n;

  console.log(`\n${BOLD}Promote candidates${RESET} (provisional, ≥${PROMOTE_ACCESS_THRESHOLD} accesses)`);
  if (promoteCount === 0) {
    console.log(`  ${GREY}none${RESET}`);
  } else {
    console.log(`  ${YELLOW}${promoteCount}${RESET} ${DIM}— run: npm run prune -- --apply (promotes first)${RESET}`);
  }

  db.close();
  console.log();
}

main().catch(e => {
  process.stderr.write(`Error: ${e}\n`);
  process.exit(1);
});
