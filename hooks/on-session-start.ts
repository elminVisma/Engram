#!/usr/bin/env tsx
/**
 * Claude Code SessionStart hook — pinned-memory injection.
 *
 * Reads SessionStart hook input from stdin, resolves the project scope from
 * the session's cwd, loads pinned memories for that scope (plus global pins),
 * caps total output at ~5k tokens (≈20k chars), and writes a context block
 * to stdout that Claude Code will splice into the session's system prompt.
 *
 * Never blocks Claude — fails silently on every error path.
 */

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24) process.exit(0);

import { existsSync } from 'fs';
import { getProjectScope } from '../lib/memory.ts';
import { listPinned } from '../lib/pin.ts';

const MAX_PINS = parseInt(process.env.ENGRAM_PIN_LIMIT ?? '10', 10);
const MAX_CHARS = parseInt(process.env.ENGRAM_PIN_CHAR_BUDGET ?? '20000', 10);

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  let sessionCwd = '';
  try {
    if (raw) {
      const input = JSON.parse(raw);
      sessionCwd = input.cwd ?? '';
    }
  } catch { /* fall through with empty cwd */ }

  const gitCwd = sessionCwd && existsSync(sessionCwd) ? sessionCwd : undefined;
  const scope = getProjectScope(gitCwd);

  try {
    const pins = listPinned(scope);
    if (pins.length === 0) return;

    // Cap to MAX_PINS by pin_order
    const capped = pins.slice(0, MAX_PINS);

    // Build output, enforcing char budget
    const header = [
      '---',
      '## Pinned memories (Engram)',
      '',
    ];
    const footer = ['---', ''];

    let totalChars = header.join('\n').length + footer.join('\n').length;
    const blocks: string[] = [];

    for (const p of capped) {
      const block = `**${p.title}** *(${p.topic})*\n${p.chunk.trim()}\n`;
      if (totalChars + block.length > MAX_CHARS) break;
      blocks.push(block);
      totalChars += block.length;
    }

    if (blocks.length === 0) return;

    process.stderr.write(`[Engram] Injecting ${blocks.length} pinned memor${blocks.length > 1 ? 'ies' : 'y'} at session start\n`);

    process.stdout.write([...header, ...blocks, ...footer].join('\n'));
  } catch { /* never block Claude */ }
}

main();
