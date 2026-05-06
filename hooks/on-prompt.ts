#!/usr/bin/env tsx
/**
 * Claude Code UserPromptSubmit hook — auto-search.
 * Searches Engram memory on every prompt and injects relevant context.
 * Threshold raised to 0.75 — only inject high-confidence matches.
 * Logs injected count to stderr for visibility. Never blocks Claude.
 *
 * Uses the daemon client for search — if the daemon is running the model
 * stays warm (fast); if not, falls back to direct execution.
 */

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24) process.exit(0);

import { INJECTION_THRESHOLD } from '../lib/memory.ts';
import { daemonSearch } from '../daemon/client.ts';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return;

  let prompt = '';
  try { prompt = JSON.parse(raw).prompt ?? ''; } catch { return; }
  if (prompt.length < 20) return;

  try {
    const results = await daemonSearch(prompt, 5);
    const relevant = results.filter(r => r.distance < INJECTION_THRESHOLD);
    if (relevant.length === 0) return;

    // Visibility — user sees this in Claude Code's hook output
    process.stderr.write(`[Engram] Injecting ${relevant.length} relevant memory${relevant.length > 1 ? 'ies' : 'y'}\n`);

    const lines = [
      '---',
      '## Relevant context from Engram memory',
      '',
      ...relevant.map(r =>
        `**${r.title}** *(${r.topic})*\n${r.chunk.slice(0, 400)}${r.chunk.length > 400 ? '...' : ''}`
      ),
      '---',
      '',
    ];

    process.stdout.write(lines.join('\n'));
  } catch { /* never block Claude */ }
}

main();
