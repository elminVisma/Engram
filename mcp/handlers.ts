/**
 * Pure handler logic for the Engram MCP server.
 * Kept transport-free so it can be unit-tested without the MCP SDK.
 */

import type { SaveOptions, MemoryTier } from '../lib/memory.ts';
import type { PinnedMemory } from '../lib/pin.ts';

export interface SaveMemoryInput {
  title: string;
  content: string;
  topic?: string;
  excerpt?: string;
  tier?: MemoryTier;
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
  const tier: MemoryTier = input.tier ?? 'short';

  try {
    await deps.save(title, topic, content, {
      sourceExcerpt: input.excerpt,
      tier,
      projectScope: deps.defaultScope(),
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
