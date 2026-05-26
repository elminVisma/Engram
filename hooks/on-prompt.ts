#!/usr/bin/env tsx
/**
 * Claude Code UserPromptSubmit hook — auto-search with associative recall.
 *
 * Phase 5: Multi-query mode. Extracts technical concepts from the prompt and
 * searches for each one separately, then unions and deduplicates the results.
 * This catches memories that are associatively related but not directly matched
 * by the raw prompt embedding.
 *
 * Environment controls:
 *   ENGRAM_DISABLE_CONCEPTS=1   — single-query mode (skip concept extraction)
 *   ENGRAM_USE_HAIKU_CONCEPTS=1 — use Haiku for concept extraction (adds ~1s)
 *   ENGRAM_ENABLE_RERANK=1      — re-rank top candidates via Haiku (adds ~1-2s)
 */

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24) process.exit(0);

import { existsSync } from 'fs';
import {
  INJECTION_THRESHOLD, getProjectScope,
  extractConceptsHeuristic, buildConceptsPrompt, parseConceptsOutput,
  buildRerankPrompt, parseRerankOutput, runClassifier,
} from '../lib/memory.ts';
import type { SearchResult } from '../lib/memory.ts';
import { daemonSearch } from '../daemon/client.ts';
import { savePendingRecall } from '../lib/recall.ts';

const CANDIDATE_LIMIT = 20;
const TOP_K = 5;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return;

  let prompt = '';
  let sessionCwd = '';
  let sessionId = '';
  try {
    const input = JSON.parse(raw);
    prompt = input.prompt ?? '';
    sessionCwd = input.cwd ?? '';
    sessionId = input.session_id ?? '';
  } catch { return; }
  if (prompt.length < 20) return;

  const gitCwd = sessionCwd && existsSync(sessionCwd) ? sessionCwd : undefined;
  const scope = getProjectScope(gitCwd);

  try {
    // ── Concept extraction ───────────────────────────────────────────────────
    let concepts: string[] = [];
    if (process.env.ENGRAM_DISABLE_CONCEPTS !== '1') {
      if (process.env.ENGRAM_USE_HAIKU_CONCEPTS === '1') {
        try {
          const conceptRaw = runClassifier(buildConceptsPrompt(prompt));
          concepts = parseConceptsOutput(conceptRaw);
        } catch { /* fall through to heuristic */ }
      }
      if (concepts.length === 0) {
        concepts = extractConceptsHeuristic(prompt);
      }
    }

    // ── Multi-query search (parallel) ────────────────────────────────────────
    const queries = [prompt, ...concepts];
    const allResults = await Promise.all(
      queries.map(q => daemonSearch(q, CANDIDATE_LIMIT, scope)),
    );
    const byId = new Map<number, SearchResult>();
    for (const results of allResults) {
      for (const r of results) {
        const existing = byId.get(r.id);
        if (!existing || existing.distance > r.distance) byId.set(r.id, r);
      }
    }
    const candidates = [...byId.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, CANDIDATE_LIMIT);

    if (candidates.length === 0) return;

    // ── Optional re-ranking ──────────────────────────────────────────────────
    let ranked = candidates;
    if (process.env.ENGRAM_ENABLE_RERANK === '1' && candidates.length > TOP_K) {
      try {
        const rerankRaw = runClassifier(buildRerankPrompt(prompt, candidates));
        const orderedIds = parseRerankOutput(rerankRaw, candidates.map(r => r.id));
        ranked = orderedIds
          .map(id => candidates.find(r => r.id === id))
          .filter((r): r is SearchResult => r !== undefined);
      } catch { /* fall through with cosine-distance order */ }
    }

    // ── Filter by threshold and inject ───────────────────────────────────────
    const relevant = ranked.filter(r => r.distance < INJECTION_THRESHOLD).slice(0, TOP_K);
    if (relevant.length === 0) return;

    const queryNote = concepts.length > 0 ? ` (${queries.length} queries)` : '';
    process.stderr.write(`[Engram] Injecting ${relevant.length} relevant memor${relevant.length > 1 ? 'ies' : 'y'}${queryNote}\n`);

    // Track which memories were injected so on-stop.ts can measure recall quality
    if (sessionId) {
      try {
        savePendingRecall(sessionId, relevant.map(r => ({ id: r.id, title: r.title, chunk: r.chunk })));
      } catch { /* never block Claude */ }
    }

    const lines = [
      '---',
      '## Relevant context from Engram memory',
      '',
      ...relevant.map(r => {
        const provisional = r.memory_tier === 'provisional' ? ' *(provisional)*' : '';
        return `**${r.title}** *(${r.topic})*${provisional}\n${r.chunk.slice(0, 400)}${r.chunk.length > 400 ? '...' : ''}`;
      }),
      '---',
      '',
    ];

    process.stdout.write(lines.join('\n'));
  } catch { /* never block Claude */ }
}

main();
