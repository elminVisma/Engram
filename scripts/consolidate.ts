#!/usr/bin/env tsx
/**
 * Consolidate a tier — merge related high-value memories into denser survivors.
 *
 * Dry-run by default (prints proposed clusters, writes nothing, no snapshot).
 * Pass --apply to take a snapshot and write survivors + archive the originals.
 *
 * Usage:
 *   npm run consolidate -- --tier provisional            # dry-run
 *   npm run consolidate -- --tier short --apply          # commit
 *   npm run consolidate -- --tier provisional --scope <gitRemoteUrl>
 *   npm run consolidate -- --list-archived
 */

import { consolidateTier, listArchived } from '../lib/consolidate.ts';
import type { MemoryTier } from '../lib/utils.ts';

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN  = '\x1b[36m';
const GREY  = '\x1b[90m';

const TIERS: MemoryTier[] = ['short', 'long', 'user', 'shared', 'provisional'];

function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--list-archived')) {
    const archived = listArchived();
    if (archived.length === 0) { console.log(`${GREY}No archived (consolidated) memories.${RESET}`); return; }
    console.log(`\n${BOLD}${GREEN}Archived by consolidation (${archived.length})${RESET}\n`);
    for (const m of archived) {
      console.log(`  ${BOLD}#${m.id}${RESET} ${m.title} ${GREY}→ survivor #${m.consolidated_into ?? '?'}${RESET}`);
    }
    console.log();
    return;
  }

  const tier = getFlag(args, '--tier') as MemoryTier | undefined;
  if (!tier || !TIERS.includes(tier)) {
    console.error(`Usage: consolidate --tier <${TIERS.join('|')}> [--apply] [--scope <url>] | --list-archived`);
    process.exit(1);
  }

  const apply = args.includes('--apply');
  const scope = getFlag(args, '--scope');

  if (!apply) console.log(`\n${YELLOW}Dry-run — pass --apply to commit (a snapshot is taken first).${RESET}`);

  const res = await consolidateTier({ tier, apply, projectScope: scope ?? undefined });

  console.log(`\n${BOLD}Tier ${tier}${RESET}: ${res.clustersFound} cluster(s) found.`);
  if (apply) {
    console.log(`${GREEN}Merged ${res.merged} cluster(s), archived ${res.archived} memor${res.archived === 1 ? 'y' : 'ies'}.${RESET}`);
    if (res.snapshotId) console.log(`${CYAN}Snapshot: ${res.snapshotId} (run \`npm run restore -- --id ${res.snapshotId}\` to undo).${RESET}`);
    for (const s of res.survivors) console.log(`  ${GREY}survivor #${s.id} "${s.title}" ← ${s.from.map(i => `#${i}`).join(', ')}${RESET}`);
  } else if (res.clustersFound === 0) {
    console.log(`${CYAN}Nothing to consolidate.${RESET}`);
  }
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
