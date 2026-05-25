/**
 * Pure handler logic for the Engram MCP server.
 * Kept transport-free so it can be unit-tested without the MCP SDK.
 */

import type { SaveOptions, MemoryTier, SearchResult, MultiSearchResult } from '../lib/memory.ts';
import type { PinnedMemory } from '../lib/pin.ts';

export interface SaveMemoryInput {
  title: string;
  content: string;
  topic?: string;
  excerpt?: string;
  tier?: MemoryTier;
  scope?: 'user' | 'project';
}

export interface SaveMemoryResult {
  ok: boolean;
  error?: string;
}

export interface SaveMemoryDeps {
  save: (title: string, topic: string, content: string, opts?: SaveOptions) => Promise<void>;
  defaultTopic: () => string;
  defaultScope: () => string | null;
}

export async function handleSaveMemory(
  input: SaveMemoryInput,
  deps: SaveMemoryDeps,
): Promise<SaveMemoryResult> {
  const title = (input.title ?? '').trim();
  if (!title) return { ok: false, error: 'title is required' };

  const content = (input.content ?? '').trim();
  if (!content) return { ok: false, error: 'content is required' };

  const topic = ((input.topic ?? deps.defaultTopic()) || '').trim() || 'general';
  const isUserScope = input.scope === 'user';
  const tier: MemoryTier = isUserScope ? 'user' : (input.tier ?? 'short');
  const projectScope = isUserScope ? null : deps.defaultScope();

  try {
    await deps.save(title, topic, content, {
      sourceExcerpt: input.excerpt,
      tier,
      projectScope,
      tags: 'manual',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── pin / unpin / list_pinned ────────────────────────────────────────────────

export interface PinMemoryInput { id: number; order?: number; }
export interface PinMemoryResult { ok: boolean; order?: number; error?: string; }
export interface PinMemoryDeps {
  pin: (id: number, order: number) => void;
  nextOrder: () => number;
}

export async function handlePinMemory(
  input: PinMemoryInput,
  deps: PinMemoryDeps,
): Promise<PinMemoryResult> {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id must be a positive integer' };

  const order = Number.isInteger(input.order) && (input.order as number) > 0
    ? (input.order as number)
    : deps.nextOrder();

  try {
    deps.pin(id, order);
    return { ok: true, order };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface UnpinMemoryInput { id: number; }
export interface UnpinMemoryResult { ok: boolean; error?: string; }
export interface UnpinMemoryDeps { unpin: (id: number) => void; }

export async function handleUnpinMemory(
  input: UnpinMemoryInput,
  deps: UnpinMemoryDeps,
): Promise<UnpinMemoryResult> {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id must be a positive integer' };

  try {
    deps.unpin(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── explain_recall ───────────────────────────────────────────────────────────

export interface ExplainRecallInput { prompt: string; scope?: string; }

export interface ExplainRecallCandidate {
  id: number;
  title: string;
  topic: string;
  memory_tier: string;
  distance: number;
  would_inject: boolean;
}

export interface ExplainRecallResult {
  ok: boolean;
  concepts?: string[];
  queries?: number;
  candidates?: ExplainRecallCandidate[];
  error?: string;
}

export interface ExplainRecallDeps {
  multiSearch: (prompt: string, scope: string | null) => Promise<MultiSearchResult>;
  defaultScope: () => string | null;
  injectionThreshold: number;
}

export async function handleExplainRecall(
  input: ExplainRecallInput,
  deps: ExplainRecallDeps,
): Promise<ExplainRecallResult> {
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) return { ok: false, error: 'prompt is required' };

  const scope = input.scope ?? deps.defaultScope();

  try {
    const { concepts, queries, candidates } = await deps.multiSearch(prompt, scope);
    return {
      ok: true,
      concepts,
      queries: queries.length,
      candidates: candidates.map(r => ({
        id: r.id,
        title: r.title,
        topic: r.topic,
        memory_tier: r.memory_tier,
        distance: r.distance,
        would_inject: r.distance < deps.injectionThreshold,
      })),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface ListPinnedInput { scope?: string; all?: boolean; }
export interface ListPinnedResult { ok: boolean; pins?: PinnedMemory[]; error?: string; }
export interface ListPinnedDeps {
  listPinned: (scope: string | null) => PinnedMemory[];
  defaultScope: () => string | null;
}

export async function handleListPinned(
  input: ListPinnedInput,
  deps: ListPinnedDeps,
): Promise<ListPinnedResult> {
  const scope: string | null = input.all
    ? null
    : (input.scope ?? deps.defaultScope());

  try {
    const pins = deps.listPinned(scope);
    return { ok: true, pins };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
