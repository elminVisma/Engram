/**
 * Unit tests for the MCP save_memory handler.
 * Pure handler logic; transport/SDK code is not exercised here.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleSaveMemory, handlePinMemory, handleUnpinMemory, handleListPinned } from '../mcp/handlers.ts';

function makeDeps(overrides: Partial<{
  save: ReturnType<typeof vi.fn>;
  defaultTopic: () => string;
  defaultScope: () => string | null;
}> = {}) {
  return {
    save: overrides.save ?? vi.fn().mockResolvedValue(undefined),
    defaultTopic: overrides.defaultTopic ?? (() => 'derived-topic'),
    defaultScope: overrides.defaultScope ?? (() => 'https://example.com/repo.git'),
  };
}

describe('handleSaveMemory', () => {
  it('rejects when title is missing or blank', async () => {
    const deps = makeDeps();
    expect(await handleSaveMemory({ title: '', content: 'body' }, deps))
      .toEqual({ ok: false, error: expect.stringMatching(/title/i) });
    expect(await handleSaveMemory({ title: '   ', content: 'body' }, deps))
      .toEqual({ ok: false, error: expect.stringMatching(/title/i) });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it('rejects when content is missing or blank', async () => {
    const deps = makeDeps();
    expect(await handleSaveMemory({ title: 't', content: '' }, deps))
      .toEqual({ ok: false, error: expect.stringMatching(/content/i) });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it('saves with derived topic and scope when not provided', async () => {
    const deps = makeDeps();
    const res = await handleSaveMemory(
      { title: 'My memory', content: 'Long body' },
      deps,
    );
    expect(res).toEqual({ ok: true });
    expect(deps.save).toHaveBeenCalledWith(
      'My memory',
      'derived-topic',
      'Long body',
      expect.objectContaining({
        tier: 'short',
        projectScope: 'https://example.com/repo.git',
        tags: 'manual',
      }),
    );
  });

  it('uses explicit topic over derived', async () => {
    const deps = makeDeps();
    await handleSaveMemory(
      { title: 't', content: 'c', topic: 'override-topic' },
      deps,
    );
    expect(deps.save).toHaveBeenCalledWith('t', 'override-topic', 'c', expect.anything());
  });

  it('passes excerpt and tier through', async () => {
    const deps = makeDeps();
    await handleSaveMemory(
      { title: 't', content: 'c', excerpt: 'the trigger sentence', tier: 'long' },
      deps,
    );
    expect(deps.save).toHaveBeenCalledWith('t', 'derived-topic', 'c',
      expect.objectContaining({ sourceExcerpt: 'the trigger sentence', tier: 'long' }),
    );
  });

  it('falls back to "general" topic if both explicit and derived are empty', async () => {
    const deps = makeDeps({ defaultTopic: () => '' });
    await handleSaveMemory({ title: 't', content: 'c' }, deps);
    expect(deps.save).toHaveBeenCalledWith('t', 'general', 'c', expect.anything());
  });

  it('returns ok:false with error message when save throws', async () => {
    const deps = makeDeps({ save: vi.fn().mockRejectedValue(new Error('db locked')) });
    const res = await handleSaveMemory({ title: 't', content: 'c' }, deps);
    expect(res).toEqual({ ok: false, error: 'db locked' });
  });

  it('trims title and content before saving', async () => {
    const deps = makeDeps();
    await handleSaveMemory({ title: '  hello  ', content: '\n\ntext\n' }, deps);
    expect(deps.save).toHaveBeenCalledWith('hello', 'derived-topic', 'text', expect.anything());
  });
});

// ─── pin/unpin/list_pinned handlers ────────────────────────────────────────────

describe('handlePinMemory', () => {
  function makePinDeps(overrides: Partial<{
    pin: ReturnType<typeof vi.fn>;
    nextOrder: () => number;
  }> = {}) {
    return {
      pin: overrides.pin ?? vi.fn(),
      nextOrder: overrides.nextOrder ?? (() => 7),
    };
  }

  it('rejects when id is missing or not a positive integer', async () => {
    const deps = makePinDeps();
    expect(await handlePinMemory({ id: 0 }, deps))
      .toEqual({ ok: false, error: expect.stringMatching(/id/i) });
    expect(await handlePinMemory({ id: -1 }, deps))
      .toEqual({ ok: false, error: expect.stringMatching(/id/i) });
    expect(deps.pin).not.toHaveBeenCalled();
  });

  it('pins with the provided order', async () => {
    const deps = makePinDeps();
    const res = await handlePinMemory({ id: 42, order: 3 }, deps);
    expect(res).toEqual({ ok: true, order: 3 });
    expect(deps.pin).toHaveBeenCalledWith(42, 3);
  });

  it('uses nextOrder when order is not provided', async () => {
    const deps = makePinDeps();
    const res = await handlePinMemory({ id: 42 }, deps);
    expect(res).toEqual({ ok: true, order: 7 });
    expect(deps.pin).toHaveBeenCalledWith(42, 7);
  });

  it('returns ok:false when pin throws', async () => {
    const deps = makePinDeps({ pin: vi.fn().mockImplementation(() => { throw new Error('not found'); }) });
    const res = await handlePinMemory({ id: 99 }, deps);
    expect(res).toEqual({ ok: false, error: 'not found' });
  });
});

describe('handleUnpinMemory', () => {
  it('rejects when id is missing or invalid', async () => {
    const deps = { unpin: vi.fn() };
    expect(await handleUnpinMemory({ id: 0 }, deps))
      .toEqual({ ok: false, error: expect.stringMatching(/id/i) });
    expect(deps.unpin).not.toHaveBeenCalled();
  });

  it('unpins by id', async () => {
    const deps = { unpin: vi.fn() };
    const res = await handleUnpinMemory({ id: 42 }, deps);
    expect(res).toEqual({ ok: true });
    expect(deps.unpin).toHaveBeenCalledWith(42);
  });

  it('returns ok:false when unpin throws', async () => {
    const deps = { unpin: vi.fn().mockImplementation(() => { throw new Error('nope'); }) };
    const res = await handleUnpinMemory({ id: 1 }, deps);
    expect(res).toEqual({ ok: false, error: 'nope' });
  });
});

describe('handleListPinned', () => {
  const samplePins = [
    { id: 1, title: 'a', topic: 't', chunk: 'c', pin_order: 1, project_scope: null, previous_tier: 'long' as const },
    { id: 2, title: 'b', topic: 't', chunk: 'c', pin_order: 2, project_scope: 'p', previous_tier: 'short' as const },
  ];

  it('lists pinned for derived scope when scope arg omitted', async () => {
    const deps = {
      listPinned: vi.fn().mockReturnValue(samplePins),
      defaultScope: () => 'https://example.com/repo.git',
    };
    const res = await handleListPinned({}, deps);
    expect(res.ok).toBe(true);
    expect(res.pins).toEqual(samplePins);
    expect(deps.listPinned).toHaveBeenCalledWith('https://example.com/repo.git');
  });

  it('lists all when scope=null requested via all flag', async () => {
    const deps = {
      listPinned: vi.fn().mockReturnValue(samplePins),
      defaultScope: () => 'ignored',
    };
    await handleListPinned({ all: true }, deps);
    expect(deps.listPinned).toHaveBeenCalledWith(null);
  });

  it('uses explicit scope when provided', async () => {
    const deps = {
      listPinned: vi.fn().mockReturnValue([]),
      defaultScope: () => 'ignored',
    };
    await handleListPinned({ scope: 'https://foo/bar.git' }, deps);
    expect(deps.listPinned).toHaveBeenCalledWith('https://foo/bar.git');
  });
});
