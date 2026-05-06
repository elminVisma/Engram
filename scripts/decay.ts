#!/usr/bin/env tsx
/**
 * Apply confidence decay to short-term memories.
 *
 * Each run multiplies confidence by (1 - decay_rate). Memories that fall below
 * the threshold (default: 0.10) are deactivated. Long-term memories are never
 * decayed. Run this on a schedule (e.g. daily cron or weekly manually).
 *
 * Usage:
 *   npm run decay               # dry-run — shows what would change
 *   npm run decay -- --apply    # write changes to the DB
 *   npm run decay -- --cutoff 0.05   # custom deactivation cutoff
 *   npm run decay -- --apply --rate 0.005  # override per-memory decay_rate globally
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DB_PATH, RAW_DIR } from '../lib/memory.ts';

const DEACTIVATE_CUTOFF = 0.10;

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';
const GREY   = '\x1b[90m';

interface MemoryRow {
  id: number;
  title: string;
  topic: string;
  path: string;
  project_scope: string | null;
  confidence: number;
  decay_rate: number;
  access_count: number;
  created_at: number;
}

// Task 4: update markdown frontmatter when applying decay
function _updateMarkdownConfidence(relPath: string, confidence: number, accessCount: number): void {
  try {
    const fullPath = join(RAW_DIR, relPath);
    let content = readFileSync(fullPath, 'utf-8');
    content = content.replace(/^confidence:.*$/m, `confidence: ${confidence.toFixed(4)}`);
    content = content.replace(/^access_count:.*$/m, `access_count: ${accessCount}`);
    writeFileSync(fullPath, content, 'utf-8');
  } catch { /* skip if file not found */ }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const cutoffIdx = args.indexOf('--cutoff');
  const cutoff = cutoffIdx !== -1 ? parseFloat(args[cutoffIdx + 1]) : DEACTIVATE_CUTOFF;
  // --rate flag or ENGRAM_DECAY_RATE env var overrides per-memory decay_rate globally
  const rateIdx = args.indexOf('--rate');
  const envRate = process.env.ENGRAM_DECAY_RATE ? parseFloat(process.env.ENGRAM_DECAY_RATE) : null;
  const globalRate = rateIdx !== -1 ? parseFloat(args[rateIdx + 1]) : envRate;

  if (!apply) {
    console.log(`\n${YELLOW}Dry-run mode — pass --apply to commit changes${RESET}\n`);
  }

  const db = new DatabaseSync(DB_PATH);

  const memories = db.prepare(`
    SELECT id, title, topic, path, project_scope, confidence, decay_rate, access_count, created_at
    FROM memories
    WHERE is_active = 1
      AND memory_tier = 'short'
    ORDER BY confidence ASC
  `).all() as unknown as MemoryRow[];

  if (memories.length === 0) {
    console.log(`${GREY}No active short-term memories to decay.${RESET}\n`);
    db.close();
    return;
  }

  let decayed = 0;
  let deactivated = 0;

  console.log(`\n${BOLD}Short-term memory decay report${RESET}\n`);
  console.log(`${DIM}Deactivation cutoff: ${cutoff} | Processing ${memories.length} memories${RESET}`);
  if (globalRate !== null) {
    console.log(`${DIM}Using global rate override: ${globalRate}${RESET}`);
  }
  console.log();

  for (const m of memories) {
    const effectiveRate = globalRate !== null ? globalRate : m.decay_rate;
    const newConfidence = m.confidence * (1 - effectiveRate);
    const willDeactivate = newConfidence < cutoff;

    if (willDeactivate) {
      console.log(`  ${RED}✕${RESET} ${BOLD}${m.title}${RESET} ${GREY}(${m.topic})${RESET}`);
      console.log(`  ${DIM}confidence: ${m.confidence.toFixed(3)} → ${newConfidence.toFixed(3)} [DEACTIVATE]${RESET}`);
      if (apply) {
        db.prepare('UPDATE memories SET confidence = ?, is_active = 0 WHERE id = ?').run(newConfidence, m.id);
        _updateMarkdownConfidence(m.path, newConfidence, m.access_count);
      }
      deactivated++;
    } else {
      const age = Math.round((Date.now() / 1000 - m.created_at) / 86400);
      const bar = _confidenceBar(newConfidence);
      console.log(`  ${bar}  ${m.confidence.toFixed(3)} → ${newConfidence.toFixed(3)}  ${DIM}${m.title} · ${age}d old${RESET}`);
      if (apply) {
        db.prepare('UPDATE memories SET confidence = ? WHERE id = ?').run(newConfidence, m.id);
        _updateMarkdownConfidence(m.path, newConfidence, m.access_count);
      }
      decayed++;
    }
  }

  db.close();

  console.log(`\n${CYAN}Summary: ${decayed} decayed, ${deactivated} deactivated out of ${memories.length} short-term memories${RESET}`);
  if (!apply) console.log(`${YELLOW}Run with --apply to commit these changes.${RESET}`);
  console.log();
}

function _confidenceBar(confidence: number, width = 20): string {
  const filled = Math.round(confidence * width);
  const color = confidence > 0.5 ? GREEN : confidence > 0.25 ? YELLOW : RED;
  return color + '█'.repeat(filled) + GREY + '░'.repeat(width - filled) + RESET;
}

main().catch(console.error);
