#!/usr/bin/env tsx
/**
 * Claude Code Stop hook — auto-remember.
 * Reads Claude's last response, runs signal-phrase filter,
 * asks Haiku if it's worth saving, saves with provenance if yes.
 * Never outputs to stdout. Never blocks Claude. Fails silently.
 */

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24) process.exit(0);

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { autoRemember, getTopicFromGit, getProjectScope } from '../lib/memory.ts';

function getLastAssistantMessage(transcriptPath: string): string {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.role !== 'assistant') continue;
      if (typeof entry.content === 'string') return entry.content;
      if (Array.isArray(entry.content)) {
        return entry.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text?: string }) => b.text ?? '')
          .join('\n')
          .trim();
      }
    }
  } catch { /* silent */ }
  return '';
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return;

  let transcriptPath = '';
  let sessionId = '';
  try {
    const input = JSON.parse(raw);
    transcriptPath = input.transcript_path ?? '';
    sessionId = input.session_id ?? '';
  } catch { return; }

  if (!transcriptPath) return;

  // Task 7: validate transcript path to prevent path traversal
  const resolvedPath = resolve(transcriptPath);
  if (!resolvedPath.startsWith(homedir())) return;
  transcriptPath = resolvedPath;

  if (!existsSync(transcriptPath)) return;

  const lastResponse = getLastAssistantMessage(transcriptPath);
  const topic = getTopicFromGit();
  const projectScope = getProjectScope();

  await autoRemember(lastResponse, topic, sessionId, projectScope);
}

main().catch(() => {});
