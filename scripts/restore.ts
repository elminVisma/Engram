#!/usr/bin/env tsx
/**
 * Restore the Engram DB from a snapshot.
 *
 * Usage:
 *   npm run restore -- --id <snapshotId>
 *   npm run restore -- --latest
 *   npm run restore -- --list           # alias for `snapshot --list`
 */

import { restore, listSnapshots } from '../lib/snapshot.ts';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const GREY  = '\x1b[90m';

function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    for (const s of listSnapshots()) console.log(`${s.id}  ${GREY}${new Date(s.createdAt).toISOString()}${RESET}`);
    return;
  }

  let id = getFlag(args, '--id');
  if (!id && args.includes('--latest')) id = listSnapshots()[0]?.id;

  if (!id) {
    console.error('Usage: restore --id <snapshotId> | --latest | --list');
    process.exit(1);
  }

  try {
    restore(id);
    console.log(`${GREEN}Restored DB from snapshot${RESET} ${id}`);
  } catch (e) {
    console.error(`${RED}${(e as Error).message}${RESET}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
