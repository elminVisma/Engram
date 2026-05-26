/**
 * Recall quality signal — track whether injected memories were referenced in Claude's response.
 *
 * Flow:
 *   on-prompt.ts  → savePendingRecall(sessionId, injectedMemories)
 *   on-stop.ts    → getPendingRecall → detectRecallHits → recordRecallHit → clearPendingRecall
 *
 * detectRecallHits uses conservative substring matching (title or opening chunk snippet).
 * This is a lower-bound signal — paraphrased references won't be counted — but it's
 * noise-free and requires no extra LLM calls.
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureSchema } from './migrate.ts';

const ENGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ENGRAM_DIR, 'memory', 'memory.db');
export const RECALL_DIR = join(ENGRAM_DIR, 'memory', 'recall-pending');

export interface InjectedMemory {
  id: number;
  title: string;
  chunk: string;
}

export function savePendingRecall(sessionId: string, memories: InjectedMemory[], dir: string = RECALL_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(memories), 'utf-8');
}

export function getPendingRecall(sessionId: string, dir: string = RECALL_DIR): InjectedMemory[] {
  const file = join(dir, `${sessionId}.json`);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as InjectedMemory[];
  } catch {
    return [];
  }
}

export function clearPendingRecall(sessionId: string, dir: string = RECALL_DIR): void {
  const file = join(dir, `${sessionId}.json`);
  if (existsSync(file)) rmSync(file);
}

const MIN_TITLE_LENGTH = 4;
const CHUNK_SNIPPET_LENGTH = 50;
const MIN_SNIPPET_LENGTH = 20;

/**
 * Returns the IDs of memories that appear to have been referenced in the response.
 * Matches by title (case-insensitive substring) or by the opening 50 chars of the chunk.
 */
export function detectRecallHits(response: string, injected: InjectedMemory[]): number[] {
  if (!response || injected.length === 0) return [];
  const responseLower = response.toLowerCase();
  const hitIds: number[] = [];
  for (const m of injected) {
    const titleLower = m.title.toLowerCase().trim();
    if (titleLower.length >= MIN_TITLE_LENGTH && responseLower.includes(titleLower)) {
      hitIds.push(m.id);
      continue;
    }
    const snippet = m.chunk.slice(0, CHUNK_SNIPPET_LENGTH).toLowerCase().trim();
    if (snippet.length >= MIN_SNIPPET_LENGTH && responseLower.includes(snippet)) {
      hitIds.push(m.id);
    }
  }
  return hitIds;
}

export function recordRecallHit(hitIds: number[], dbPath: string = DB_PATH): void {
  if (hitIds.length === 0) return;
  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  try {
    const stmt = db.prepare('UPDATE memories SET recall_hit = recall_hit + 1 WHERE id = ?');
    for (const id of hitIds) stmt.run(id);
  } finally {
    db.close();
  }
}
