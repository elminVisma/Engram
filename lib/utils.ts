/**
 * Pure utility functions — no native Node deps.
 * Imported by lib/memory.ts, tests, and scripts.
 */

import { execSync } from 'child_process';
import { basename } from 'path';

export const DUPLICATE_THRESHOLD = 0.15;
export const SUPERSESSION_THRESHOLD = 0.35;
export const INJECTION_THRESHOLD = 0.75;

export const PROMOTE_ACCESS_THRESHOLD = parseInt(process.env.ENGRAM_PROMOTE_THRESHOLD ?? '10', 10);

export const SIGNAL_PHRASES = [
  // Discovery
  'turns out', 'it turns out', 'discovered that', 'found that', 'realized that',
  'interestingly', 'surprisingly', 'unexpectedly', 'what i found',
  // Problems & root causes
  'the issue was', 'the problem was', 'root cause', 'the bug was', 'the culprit',
  'what broke', 'why it failed', 'the reason it', 'the cause',
  // Solutions
  'fixed by', 'resolved by', 'solved by', 'the fix is', 'the solution is',
  'the workaround', 'what worked',
  // Patterns & insights
  'the trick is', 'the trick here', 'the key insight', 'important to note',
  'worth noting', 'the pattern here', 'the pattern is',
  // Constraints & warnings
  'always ensure', 'never do', 'avoid', 'make sure to', 'be careful',
  'watch out', 'non-obvious', 'counterintuitive', 'caveat', 'edge case',
  'the catch is', 'gotcha', 'pitfall',
  // Learnings
  'learned that', 'this means', 'the implication', 'takeaway', 'lesson',
  'what this means', 'worth remembering',
];

export type MemoryTier = 'short' | 'long';

export function serialize(vector: number[]): Buffer {
  // Float32Array owns its own ArrayBuffer (byteOffset=0), so Buffer.from produces
  // a Buffer where byteOffset is also 0 — safe for cosineDistance to read back.
  const arr = new Float32Array(vector);
  return Buffer.from(arr.buffer);
}

/** Cosine distance between two Float32 embedding buffers. Returns 0 (identical) to 2 (opposite). */
export function cosineDistance(a: Uint8Array, b: Uint8Array): number {
  const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < fa.length; i++) {
    dot += fa[i] * fb[i];
    na += fa[i] * fa[i];
    nb += fb[i] * fb[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}

export function today(): string {
  return new Date().toISOString().split('T')[0];
}

export function hasSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return SIGNAL_PHRASES.some(p => lower.includes(p));
}

// Task 6: sanitize topic to prevent path traversal
export function sanitizeTopic(topic: string): string {
  const sanitized = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized || sanitized.includes('..')) return 'general';
  return sanitized;
}

export function getTopicFromGit(cwd?: string): string {
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd,
    }).trim();

    if (!branch || branch === 'main' || branch === 'master') {
      const repoPath = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd,
      }).trim();
      return sanitizeTopic(basename(repoPath));
    }

    return sanitizeTopic(branch);
  } catch {
    return 'general';
  }
}

/** Returns the git remote origin URL for the given cwd (or current dir), or null. */
export function getProjectScope(cwd?: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd,
    }).trim();
    return remote || null;
  } catch {
    return null;
  }
}

/**
 * Sliding window chunker with heading-aware splitting.
 */
export function chunkText(text: string, size = 400, overlap = 80): string[] {
  const sections = text.split(/(?=^#{1,3}\s)/m).filter(s => s.trim().length > 20);
  const chunks: string[] = [];

  for (const section of sections) {
    const words = section.split(/\s+/).filter(Boolean);
    if (words.length <= size) {
      chunks.push(section.trim());
      continue;
    }
    let i = 0;
    while (i < words.length) {
      const chunk = words.slice(i, i + size).join(' ');
      if (chunk.trim()) chunks.push(chunk);
      i += size - overlap;
      if (i >= words.length) break;
    }
  }

  return chunks.filter(c => c.trim().length > 20);
}

// Task 3: helper to strip markdown code fences before JSON.parse
export function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

export interface HeuristicExtract {
  title: string;
  content: string;
  excerpt: string;
}

/**
 * Extracts a saveable memory from response text without an LLM call.
 * Finds the first sentence containing a signal phrase, uses it as the anchor.
 * Returns null if no signal phrase found or text is too short.
 */
export function heuristicExtract(text: string): HeuristicExtract | null {
  if (text.length < 20) return null;

  const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) ?? [];
  if (sentences.length === 0) return null;

  const lower = text.toLowerCase();
  let signalSentenceIdx = -1;

  outer:
  for (const phrase of SIGNAL_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx === -1) continue;
    let pos = 0;
    for (let i = 0; i < sentences.length; i++) {
      pos += sentences[i].length;
      if (pos > idx) {
        signalSentenceIdx = i;
        break outer;
      }
    }
  }

  if (signalSentenceIdx === -1) return null;

  const contentSentences = sentences.slice(signalSentenceIdx, signalSentenceIdx + 3);
  const content = contentSentences.join(' ').trim().slice(0, 500);
  const signalSentence = sentences[signalSentenceIdx].trim();
  const title = signalSentence.split(/\s+/).slice(0, 8).join(' ').replace(/[.!?,]+$/, '').slice(0, 60);

  return { title, content, excerpt: signalSentence.slice(0, 200) };
}

// Task 22: decision logic extracted for testability
export type SaveDecision = 'skip' | 'new' | { supersede: number };
export function decideSave(candidates: Array<{ id: number; distance: number }>): SaveDecision {
  if (candidates.length === 0) return 'new';
  const nearest = candidates[0];
  if (nearest.distance < DUPLICATE_THRESHOLD) return 'skip';
  if (nearest.distance < SUPERSESSION_THRESHOLD) return { supersede: nearest.id };
  return 'new';
}
