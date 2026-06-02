#!/usr/bin/env tsx
/**
 * Show Engram system status.
 *
 * Usage:
 *   npm run status
 */

import { DatabaseSync } from 'node:sqlite';
import { statSync, existsSync } from 'fs';
import http from 'node:http';
import { DB_PATH, tierCounts, ALL_TIERS } from '../lib/memory.ts';

const PORT = parseInt(process.env.ENGRAM_PORT ?? '7700', 10);

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const GREY   = '\x1b[90m';
const DIM    = '\x1b[2m';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatUnixTime(ts: number | null): string {
  if (!ts) return `${GREY}never${RESET}`;
  return new Date(ts * 1000).toLocaleString();
}

async function checkDaemon(): Promise<{ running: boolean; pid?: number }> {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/health',
      method: 'GET',
      timeout: 2000,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          resolve({ running: true, pid: body.pid });
        } catch {
          resolve({ running: false });
        }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => { req.destroy(); resolve({ running: false }); });
    req.end();
  });
}

async function main() {
  console.log(`\n${BOLD}${CYAN}Engram System Status${RESET}\n`);

  // ── Database ──────────────────────────────────────────
  if (!existsSync(DB_PATH)) {
    console.log(`${RED}No database found at ${DB_PATH}${RESET}`);
    console.log(`${DIM}Run npm run reindex to create one.${RESET}\n`);
  } else {
    const dbStat = statSync(DB_PATH);
    console.log(`${BOLD}Database${RESET}`);
    console.log(`  Path:        ${DB_PATH}`);
    console.log(`  Size:        ${formatBytes(dbStat.size)}`);

    try {
      const db = new DatabaseSync(DB_PATH, { readOnly: true });

      const counts     = tierCounts(DB_PATH);
      const lastSave   = (db.prepare(`SELECT MAX(created_at) as ts FROM memories`).get() as { ts: number | null }).ts;
      const lastSearch = (db.prepare(`SELECT MAX(last_accessed_at) as ts FROM memories`).get() as { ts: number | null }).ts;

      const breakdown = ALL_TIERS
        .filter(t => counts.active[t] > 0)
        .map(t => `${counts.active[t]} ${t}`)
        .join(', ');
      console.log(`  Active:      ${GREEN}${counts.totalActive}${RESET}${breakdown ? ` (${breakdown})` : ''}`);
      console.log(`  Inactive:    ${GREY}${counts.totalInactive}${RESET} (superseded + purged)`);
      console.log(`  Last save:   ${formatUnixTime(lastSave)}`);
      console.log(`  Last search: ${formatUnixTime(lastSearch)}`);

      db.close();
    } catch (e) {
      console.log(`  ${RED}Error reading DB: ${e}${RESET}`);
    }
  }

  // ── Daemon ────────────────────────────────────────────
  console.log(`\n${BOLD}Daemon${RESET}`);
  const daemon = await checkDaemon();
  if (daemon.running) {
    console.log(`  Status:  ${GREEN}running${RESET} (pid ${daemon.pid}, port ${PORT})`);
  } else {
    console.log(`  Status:  ${YELLOW}not running${RESET}`);
    console.log(`  ${DIM}Start with: npm run daemon${RESET}`);
  }

  // ── Environment ───────────────────────────────────────
  console.log(`\n${BOLD}Environment${RESET}`);
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  console.log(`  ANTHROPIC_API_KEY:    ${hasApiKey ? GREEN + 'set' : GREY + 'not set'}${RESET}${!hasApiKey ? ` ${DIM}(using CLI auth)${RESET}` : ''}`);
  const disableHaiku = process.env.ENGRAM_DISABLE_HAIKU === '1';
  console.log(`  ENGRAM_DISABLE_HAIKU: ${disableHaiku ? YELLOW + '1 (Haiku API calls disabled)' : GREY + 'not set'}${RESET}`);
  const engramModel = process.env.ENGRAM_MODEL;
  console.log(`  ENGRAM_MODEL:         ${engramModel ? CYAN + engramModel : GREY + 'not set (using default)'}${RESET}`);
  const engramPort = process.env.ENGRAM_PORT;
  console.log(`  ENGRAM_PORT:          ${engramPort ? CYAN + engramPort : GREY + `not set (using ${PORT})`}${RESET}`);

  console.log();
}

main().catch(console.error);
