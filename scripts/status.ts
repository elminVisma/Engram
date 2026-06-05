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
import {
  DB_PATH, tierCounts, ALL_TIERS,
  checkCapacity, resolveTierCaps, loadEngramConfig, getMeta,
} from '../lib/memory.ts';
import { MAINTENANCE_INTERVAL_HOURS } from '../lib/maintenance.ts';
import { listSnapshots } from '../lib/snapshot.ts';
import { listArchived } from '../lib/consolidate.ts';

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
      const archivedCount = (db.prepare(
        `SELECT COUNT(*) AS n FROM memories WHERE archived_at IS NOT NULL`
      ).get() as { n: number }).n;

      console.log(`  Active:      ${GREEN}${counts.totalActive}${RESET}${breakdown ? ` (${breakdown})` : ''}`);
      console.log(`  Inactive:    ${GREY}${counts.totalInactive}${RESET} (superseded, purged, consolidated)`);
      console.log(`  Last save:   ${formatUnixTime(lastSave)}`);
      console.log(`  Last search: ${formatUnixTime(lastSearch)}`);

      db.close();

      // ── Maintenance ─────────────────────────────────────
      console.log(`\n${BOLD}Maintenance${RESET}`);

      const caps = resolveTierCaps(loadEngramConfig());
      const flagged = checkCapacity(counts.active, caps).filter(t => t.atThreshold);
      if (flagged.length > 0) {
        console.log(`  Capacity:    ${YELLOW}${flagged.map(t => `${t.tier} ${t.count}/${t.cap}`).join(', ')}${RESET} ${DIM}(will consolidate at idle)${RESET}`);
      } else {
        console.log(`  Capacity:    ${GREEN}all tiers under threshold${RESET}`);
      }

      console.log(`  Archived:    ${archivedCount > 0 ? CYAN + archivedCount + RESET : GREY + '0' + RESET}${archivedCount > 0 ? ` ${DIM}(consolidated away — npm run consolidate -- --list-archived)${RESET}` : ''}`);

      const snaps = listSnapshots();
      if (snaps.length > 0) {
        console.log(`  Snapshots:   ${GREEN}${snaps.length}${RESET} ${DIM}(latest ${snaps[0].id} · ${new Date(snaps[0].createdAt).toLocaleString()})${RESET}`);
      } else {
        console.log(`  Snapshots:   ${GREY}none${RESET}`);
      }

      const lastMaint = getMeta('last_maintenance_at', DB_PATH);
      const lastMaintStr = lastMaint
        ? new Date(Number(lastMaint)).toLocaleString()
        : `${GREY}never${RESET}`;
      console.log(`  Maintenance: ${DIM}every ${MAINTENANCE_INTERVAL_HOURS}h · last run ${lastMaintStr}${RESET}`);
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
  const autoConsolidate = process.env.ENGRAM_AUTO_CONSOLIDATE === '0';
  console.log(`  ENGRAM_AUTO_CONSOLIDATE: ${autoConsolidate ? YELLOW + '0 (auto-consolidation disabled)' : GREY + 'not set (enabled at idle)'}${RESET}`);
  const maintHours = process.env.ENGRAM_MAINTENANCE_HOURS;
  console.log(`  ENGRAM_MAINTENANCE_HOURS: ${maintHours ? CYAN + maintHours : GREY + 'not set (using 8)'}${RESET}`);

  console.log();
}

main().catch(console.error);
