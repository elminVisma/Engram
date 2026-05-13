#!/usr/bin/env tsx
/**
 * Pin / unpin / list Engram memories.
 *
 * Usage:
 *   npm run pin -- --id 42                    # pin id 42 with auto-assigned order
 *   npm run pin -- --id 42 --order 1          # pin with explicit order
 *   npm run pin -- --unpin --id 42            # unpin
 *   npm run pin -- --list                     # list pinned for current project scope
 *   npm run pin -- --list --all               # list pinned across all scopes
 */

import { DatabaseSync } from 'node:sqlite';
import { pin, unpin, listPinned, DB_PATH } from '../lib/pin.ts';
import { getProjectScope } from '../lib/memory.ts';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GREY   = '\x1b[90m';
const DIM    = '\x1b[2m';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    id: get('--id') ? parseInt(get('--id')!, 10) : undefined,
    order: get('--order') ? parseInt(get('--order')!, 10) : undefined,
    list: args.includes('--list'),
    unpinFlag: args.includes('--unpin'),
    all: args.includes('--all'),
  };
}

function nextPinOrder(db: DatabaseSync): number {
  const row = db.prepare(
    `SELECT COALESCE(MAX(pin_order), 0) AS max FROM memories WHERE memory_tier = 'pinned'`
  ).get() as { max: number };
  return row.max + 1;
}

function listAndPrint(scope: string | null): void {
  const pins = listPinned(scope);
  if (pins.length === 0) {
    console.log(`${GREY}No pinned memories${scope ? ` for scope ${scope}` : ''}.${RESET}`);
    return;
  }
  const heading = scope === null ? 'All pinned memories' : `Pinned for ${scope}`;
  console.log(`\n${BOLD}${GREEN}${heading} (${pins.length})${RESET}\n`);
  for (const p of pins) {
    console.log(`  ${BOLD}#${p.id}${RESET} ${BOLD}${p.title}${RESET} ${GREY}(${p.topic})${RESET}`);
    console.log(`  ${DIM}order: ${p.pin_order} · scope: ${p.project_scope ?? 'global'} · previous: ${p.previous_tier ?? '—'}${RESET}`);
    console.log(`  ${DIM}${p.chunk.slice(0, 200).replace(/\n+/g, ' ')}${p.chunk.length > 200 ? '...' : ''}${RESET}\n`);
  }
}

async function main(): Promise<void> {
  const { id, order, list, unpinFlag, all } = parseArgs();

  if (list) {
    const scope = all ? null : getProjectScope();
    listAndPrint(scope);
    return;
  }

  if (!id || Number.isNaN(id)) {
    console.error('Usage: pin --id <n> [--order <n>] | --unpin --id <n> | --list [--all]');
    process.exit(1);
  }

  if (unpinFlag) {
    unpin(id);
    console.log(`${GREEN}Unpinned${RESET} memory #${id}`);
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  const finalOrder = order ?? nextPinOrder(db);
  db.close();

  pin(id, finalOrder);
  console.log(`${GREEN}Pinned${RESET} memory #${id} ${YELLOW}(order ${finalOrder})${RESET}`);
}

main().catch(e => { console.error(e); process.exit(1); });
