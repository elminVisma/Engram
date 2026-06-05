#!/usr/bin/env tsx
/**
 * Take a snapshot of the Engram DB, or list existing snapshots.
 *
 * Usage:
 *   npm run snapshot            # take a snapshot (retention applies)
 *   npm run snapshot -- --list  # list snapshots, newest first
 */

import { snapshot, listSnapshots } from '../lib/snapshot.ts';

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const GREY  = '\x1b[90m';
const DIM   = '\x1b[2m';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const list = listSnapshots();
    if (list.length === 0) { console.log(`${GREY}No snapshots.${RESET}`); return; }
    console.log(`\n${BOLD}${GREEN}Snapshots (${list.length}) — newest first${RESET}\n`);
    for (const s of list) {
      console.log(`  ${BOLD}${s.id}${RESET}  ${DIM}${new Date(s.createdAt).toISOString()} · ${fmtBytes(s.bytes)}${RESET}`);
    }
    console.log();
    return;
  }

  const s = snapshot();
  console.log(`${GREEN}Snapshot taken:${RESET} ${BOLD}${s.id}${RESET} ${DIM}(${fmtBytes(s.bytes)})${RESET}`);
}

main().catch(e => { console.error(e); process.exit(1); });
