#!/usr/bin/env tsx
/**
 * Prune provisional memories.
 *
 * Soft-deletes provisional memories that are >14d old with 0 accesses
 * and confidence < 0.5. Hard-deletes provisional memories that were
 * soft-deleted and are >60d old.
 *
 * Usage:
 *   npm run prune               # dry-run — shows what would be pruned
 *   npm run prune -- --apply    # write changes to the DB
 */

import { pruneProvisional, promoteProvisional, PROMOTE_ACCESS_THRESHOLD } from '../lib/memory.ts';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RED    = '\x1b[31m';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  if (!apply) {
    console.log(`\n${YELLOW}Dry-run mode — pass --apply to commit changes${RESET}\n`);
  }

  // Promote eligible provisional memories first
  const promoted = promoteProvisional(undefined, PROMOTE_ACCESS_THRESHOLD);
  if (promoted > 0) {
    console.log(`${GREEN}${BOLD}Promoted ${promoted} provisional memor${promoted > 1 ? 'ies' : 'y'} to short-term.${RESET}`);
  }

  const result = await pruneProvisional({ apply });

  if (apply) {
    if (result.softDeleted > 0) {
      console.log(`${RED}Soft-deleted ${result.softDeleted} stale provisional memor${result.softDeleted > 1 ? 'ies' : 'y'}.${RESET}`);
    }
    if (result.hardDeleted > 0) {
      console.log(`${RED}Hard-deleted ${result.hardDeleted} expired provisional memor${result.hardDeleted > 1 ? 'ies' : 'y'}.${RESET}`);
    }
    if (result.softDeleted === 0 && result.hardDeleted === 0) {
      console.log(`${CYAN}Nothing to prune.${RESET}`);
    }
  } else {
    if (result.eligible > 0) {
      console.log(`${YELLOW}${result.eligible} provisional memor${result.eligible > 1 ? 'ies' : 'y'} would be soft-deleted.${RESET}`);
    } else {
      console.log(`${CYAN}No stale provisional memories found.${RESET}`);
    }
  }

  console.log();
}

main().catch(console.error);
