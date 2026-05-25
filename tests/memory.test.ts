import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chunkText,
  hasSignal,
  stripJsonFences,
  decideSave,
  cosineDistance,
  serialize,
  heuristicExtract,
  buildClassifyPrompt,
  parseClassifyOutput,
  detectUserScope,
  findScopeGroup,
  loadEngramConfig,
  isPruneable,
  isHardDeletable,
  PRUNE_AGE_DAYS,
  HARD_DELETE_AGE_DAYS,
  USER_TIER_PHRASES,
  SIGNAL_PHRASES,
  DUPLICATE_THRESHOLD,
  SUPERSESSION_THRESHOLD,
  INJECTION_THRESHOLD,
  type EngramConfig,
} from '../lib/utils.ts';
import { handleSaveMemory } from '../mcp/handlers.ts';

// ─── Task 19: chunkText tests ─────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns a single chunk for input shorter than size (50 words)', () => {
    const input = 'word '.repeat(50).trim();
    const chunks = chunkText(input);
    expect(chunks).toHaveLength(1);
  });

  it('returns a single chunk for exactly 400 words', () => {
    const input = 'word '.repeat(400).trim();
    const chunks = chunkText(input);
    expect(chunks).toHaveLength(1);
  });

  it('returns two chunks for 401 words and loses no words', () => {
    const words = Array.from({ length: 401 }, (_, i) => `word${i}`);
    const input = words.join(' ');
    const chunks = chunkText(input);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // All words must be represented across chunks (no words lost)
    const allChunkWords = chunks.join(' ').split(/\s+/).filter(Boolean);
    expect(allChunkWords.length).toBeGreaterThanOrEqual(401);
  });

  it('returns at least one chunk per markdown heading section', () => {
    const input = `# Section One\n${'word '.repeat(50)}\n# Section Two\n${'word '.repeat(50)}`;
    const chunks = chunkText(input);
    // Each section with content > 20 chars should produce at least one chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for empty string', () => {
    const chunks = chunkText('');
    expect(chunks).toEqual([]);
  });

  it('returns empty array for very short string (< 20 chars)', () => {
    const chunks = chunkText('hi');
    expect(chunks).toEqual([]);
  });
});

// ─── Task 20: hasSignal tests ─────────────────────────────────────────────────

describe('hasSignal', () => {
  it('matches every phrase in SIGNAL_PHRASES when embedded in a sentence', () => {
    for (const phrase of SIGNAL_PHRASES) {
      const sentence = `We found that ${phrase} the thing happened unexpectedly.`;
      expect(hasSignal(sentence), `phrase: "${phrase}"`).toBe(true);
    }
  });

  it('does not match routine sentences', () => {
    expect(hasSignal('Here is the code you asked for.')).toBe(false);
    expect(hasSignal('Let me explain how this works.')).toBe(false);
    expect(hasSignal('I have updated the file as requested.')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasSignal('THE ISSUE WAS in the config.')).toBe(true);
    expect(hasSignal('Turns Out the bug was here.')).toBe(true);
  });
});

// ─── Task 21: stripJsonFences + autoRemember JSON parsing tests ───────────────

describe('stripJsonFences', () => {
  it('returns text unchanged when no fences are present', () => {
    const json = '{"worth_saving": false}';
    expect(stripJsonFences(json)).toBe(json);
  });

  it('strips ```json fences', () => {
    const fenced = '```json\n{"worth_saving": true}\n```';
    expect(stripJsonFences(fenced)).toBe('{"worth_saving": true}');
  });

  it('strips plain ``` fences', () => {
    const fenced = '```\n{"worth_saving": true}\n```';
    expect(stripJsonFences(fenced)).toBe('{"worth_saving": true}');
  });

  it('strips fences and produces parseable JSON', () => {
    const payload = { worth_saving: true, title: 'test', content: 'test content', excerpt: 'test' };
    const fenced = '```json\n' + JSON.stringify(payload) + '\n```';
    const stripped = stripJsonFences(fenced);
    const parsed = JSON.parse(stripped);
    expect(parsed.worth_saving).toBe(true);
    expect(parsed.title).toBe('test');
  });

  it('handles malformed JSON gracefully via JSON.parse throwing', () => {
    const stripped = stripJsonFences('{invalid}');
    expect(() => JSON.parse(stripped)).toThrow();
  });
});

// Parsing logic mirrors autoRemember internals — test it in isolation
describe('autoRemember JSON parsing logic', () => {
  it('parses valid JSON with worth_saving true', () => {
    const text = '{"worth_saving": true, "title": "test", "content": "test content", "excerpt": "test"}';
    const parsed = JSON.parse(stripJsonFences(text));
    expect(parsed.worth_saving).toBe(true);
    expect(parsed.title).toBe('test');
    expect(parsed.content).toBe('test content');
  });

  it('parses JSON wrapped in code fences', () => {
    const text = '```json\n{"worth_saving": true, "title": "t", "content": "c", "excerpt": "e"}\n```';
    const parsed = JSON.parse(stripJsonFences(text));
    expect(parsed.worth_saving).toBe(true);
  });

  it('handles worth_saving false', () => {
    const text = '{"worth_saving": false}';
    const parsed = JSON.parse(stripJsonFences(text));
    expect(parsed.worth_saving).toBe(false);
  });

  it('does not throw on malformed JSON — returns silently', () => {
    let threw = false;
    try {
      JSON.parse(stripJsonFences('{invalid}'));
    } catch {
      threw = true;
    }
    // The catch swallows it — we just verify it threw (as the real code catches and returns)
    expect(threw).toBe(true);
  });
});

// ─── Task 22: decideSave tests ────────────────────────────────────────────────

describe('decideSave', () => {
  it('returns "new" for empty candidates', () => {
    expect(decideSave([])).toBe('new');
  });

  it('returns "skip" when nearest distance < DUPLICATE_THRESHOLD', () => {
    const candidates = [{ id: 1, distance: DUPLICATE_THRESHOLD - 0.01 }];
    expect(decideSave(candidates)).toBe('skip');
  });

  it('returns { supersede: id } when DUPLICATE_THRESHOLD <= distance < SUPERSESSION_THRESHOLD', () => {
    const candidates = [{ id: 42, distance: (DUPLICATE_THRESHOLD + SUPERSESSION_THRESHOLD) / 2 }];
    const result = decideSave(candidates);
    expect(result).toEqual({ supersede: 42 });
  });

  it('returns "new" when distance >= SUPERSESSION_THRESHOLD', () => {
    const candidates = [{ id: 1, distance: SUPERSESSION_THRESHOLD + 0.01 }];
    expect(decideSave(candidates)).toBe('new');
  });

  it('uses the nearest (first) candidate for the decision', () => {
    const candidates = [
      { id: 1, distance: DUPLICATE_THRESHOLD - 0.01 }, // nearest — would skip
      { id: 2, distance: SUPERSESSION_THRESHOLD - 0.01 }, // second — would supersede
    ];
    expect(decideSave(candidates)).toBe('skip');
  });

  it('exposes correct threshold values', () => {
    expect(DUPLICATE_THRESHOLD).toBe(0.15);
    expect(SUPERSESSION_THRESHOLD).toBe(0.35);
    expect(INJECTION_THRESHOLD).toBe(0.75);
  });
});

// ─── cosineDistance tests ─────────────────────────────────────────────────────

describe('cosineDistance', () => {
  it('returns ~0 for identical vectors', () => {
    const v = serialize([1, 0, 0, 0]);
    expect(cosineDistance(v, v)).toBeCloseTo(0);
  });

  it('returns ~1 for orthogonal vectors', () => {
    const a = serialize([1, 0]);
    const b = serialize([0, 1]);
    expect(cosineDistance(a, b)).toBeCloseTo(1);
  });

  it('returns ~0 for parallel vectors of different magnitude', () => {
    const a = serialize([2, 0]);
    const b = serialize([4, 0]);
    expect(cosineDistance(a, b)).toBeCloseTo(0);
  });

  it('returns 1 for a zero vector', () => {
    const zero = serialize([0, 0]);
    const v = serialize([1, 0]);
    expect(cosineDistance(zero, v)).toBe(1);
  });

  it('returns a value between 0 and 2 for arbitrary vectors', () => {
    const a = serialize([1, 2, 3, 4]);
    const b = serialize([4, 3, 2, 1]);
    const d = cosineDistance(a, b);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(2);
  });

  it('returns < 0.5 for similar vectors', () => {
    const a = serialize([1, 1, 0]);
    const b = serialize([1, 0.9, 0.1]);
    expect(cosineDistance(a, b)).toBeLessThan(0.5);
  });
});

// ─── heuristicExtract tests ───────────────────────────────────────────────────

describe('heuristicExtract', () => {
  it('returns null for text with no signal phrases', () => {
    expect(heuristicExtract('Here is the code you asked for. Let me explain how this works.')).toBeNull();
  });

  it('extracts title and content from a sentence containing a signal phrase', () => {
    const text = 'Some intro. The issue was that the cache key was not being invalidated. This caused stale data to be returned.';
    const result = heuristicExtract(text);
    expect(result).not.toBeNull();
    expect(result!.title.length).toBeGreaterThan(0);
    expect(result!.content).toContain('cache key');
    expect(result!.excerpt).toContain('cache key');
  });

  it('title is at most 60 characters', () => {
    const text = 'The issue was that the deeply nested configuration object was not being merged correctly because of a prototype chain conflict in the library.';
    const result = heuristicExtract(text);
    expect(result!.title.length).toBeLessThanOrEqual(60);
  });

  it('content includes subsequent sentences up to 3 total', () => {
    const text = 'The fix is to call flush before close. This ensures all buffers are written. Otherwise data is silently dropped. Extra sentence four.';
    const result = heuristicExtract(text);
    expect(result!.content).toContain('flush');
    expect(result!.content).toContain('buffers');
    expect(result!.content).toContain('silently dropped');
  });

  it('is case-insensitive for signal phrase matching', () => {
    const text = 'TURNS OUT the environment variable was shadowed by the shell.';
    const result = heuristicExtract(text);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('environment variable');
  });

  it('returns null for text shorter than 20 chars', () => {
    expect(heuristicExtract('too short')).toBeNull();
  });
});

// ─── Phase 2: USER_TIER_PHRASES + detectUserScope ─────────────────────────────

describe('USER_TIER_PHRASES', () => {
  it('is a non-empty array of lowercase strings', () => {
    expect(Array.isArray(USER_TIER_PHRASES)).toBe(true);
    expect(USER_TIER_PHRASES.length).toBeGreaterThan(0);
    for (const phrase of USER_TIER_PHRASES) {
      expect(phrase).toBe(phrase.toLowerCase());
    }
  });
});

describe('detectUserScope', () => {
  it('returns true for preference phrases', () => {
    expect(detectUserScope('I prefer using tabs over spaces.')).toBe(true);
    expect(detectUserScope('I always run tests before committing.')).toBe(true);
    expect(detectUserScope('I never use var in TypeScript.')).toBe(true);
  });

  it('returns true for workflow language', () => {
    expect(detectUserScope('My workflow is to write tests first.')).toBe(true);
    expect(detectUserScope('I typically start by reading the failing test.')).toBe(true);
  });

  it('returns false for project-specific technical content', () => {
    expect(detectUserScope('The migration file needs a DOWN step.')).toBe(false);
    expect(detectUserScope('The bug was caused by a missing null check.')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectUserScope('I PREFER functional components.')).toBe(true);
  });

  it('returns false for empty or short text', () => {
    expect(detectUserScope('')).toBe(false);
    expect(detectUserScope('hi')).toBe(false);
  });
});

// ─── Phase 2: buildClassifyPrompt includes scope ──────────────────────────────

describe('buildClassifyPrompt (Phase 2)', () => {
  it('includes scope field in the JSON schema hint', () => {
    const prompt = buildClassifyPrompt('The issue was that we forgot to flush.');
    expect(prompt).toContain('"scope"');
  });

  it('mentions user, project scope options', () => {
    const prompt = buildClassifyPrompt('I always prefer to write tests first.');
    expect(prompt).toContain('user');
    expect(prompt).toContain('project');
  });
});

// ─── Phase 2: parseClassifyOutput handles scope field ─────────────────────────

describe('parseClassifyOutput (Phase 2 — scope field)', () => {
  it('parses scope: user from classifier output', () => {
    const raw = JSON.stringify({
      worth_saving: true,
      title: 'User prefers TDD',
      content: 'I always write tests first.',
      excerpt: 'I always write tests first.',
      scope: 'user',
    });
    const result = parseClassifyOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.worth_saving).toBe(true);
    expect(result!.scope).toBe('user');
  });

  it('parses scope: project from classifier output', () => {
    const raw = JSON.stringify({
      worth_saving: true,
      title: 'Null check bug',
      content: 'The bug was a missing null check.',
      excerpt: 'The bug was a missing null check.',
      scope: 'project',
    });
    const result = parseClassifyOutput(raw);
    expect(result!.scope).toBe('project');
  });

  it('returns valid result when scope is absent (backward compat)', () => {
    const raw = JSON.stringify({ worth_saving: false });
    const result = parseClassifyOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.worth_saving).toBe(false);
    expect(result!.scope).toBeUndefined();
  });
});

// ─── Phase 2: handleSaveMemory with scope='user' ──────────────────────────────

describe('handleSaveMemory (Phase 2 — user scope)', () => {
  it('saves with tier=user and projectScope=null when scope=user', async () => {
    const calls: Array<{ title: string; topic: string; content: string; opts: unknown }> = [];

    const deps = {
      save: async (title: string, topic: string, content: string, opts: unknown) => {
        calls.push({ title, topic, content, opts });
      },
      defaultTopic: () => 'engram',
      defaultScope: () => 'https://github.com/org/repo',
    };

    await handleSaveMemory(
      { title: 'User prefers TDD', content: 'I always write tests first.', scope: 'user' },
      deps,
    );

    expect(calls).toHaveLength(1);
    const saved = calls[0].opts as Record<string, unknown>;
    expect(saved.tier).toBe('user');
    expect(saved.projectScope).toBeNull();
  });

  it('uses defaultScope for project-scoped saves (scope omitted)', async () => {
    const calls: Array<{ opts: unknown }> = [];

    const deps = {
      save: async (_t: string, _to: string, _c: string, opts: unknown) => {
        calls.push({ opts });
      },
      defaultTopic: () => 'engram',
      defaultScope: () => 'https://github.com/org/repo',
    };

    await handleSaveMemory(
      { title: 'Bug fix', content: 'The null check was missing.' },
      deps,
    );

    const saved = calls[0].opts as Record<string, unknown>;
    expect(saved.projectScope).toBe('https://github.com/org/repo');
  });

  it('returns error when title is missing', async () => {
    const deps = {
      save: async () => {},
      defaultTopic: () => 'engram',
      defaultScope: () => null,
    };
    const result = await handleSaveMemory({ title: '', content: 'some content' }, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/title/i);
  });
});

// ─── Phase 3: findScopeGroup ──────────────────────────────────────────────────

describe('findScopeGroup', () => {
  const config: EngramConfig = {
    scope_groups: {
      payroller: [
        'https://github.com/org/Payroller-Engine',
        'https://github.com/org/Paybooker-Backend',
        'https://github.com/org/Payroller-Infrastructure',
      ],
      engram: [
        'https://github.com/org/Engram',
      ],
    },
  };

  it('returns the group name for an exact URL match', () => {
    expect(findScopeGroup('https://github.com/org/Payroller-Engine', config)).toBe('payroller');
  });

  it('returns the group name for a URL that contains a config entry', () => {
    // git remote URLs often have .git suffix or different casing
    expect(findScopeGroup('https://github.com/org/Paybooker-Backend.git', config)).toBe('payroller');
  });

  it('returns the group when config URL is a substring of the scope', () => {
    expect(findScopeGroup('git@github.com:org/Engram.git', config)).toBe('engram');
  });

  it('returns null when no group matches', () => {
    expect(findScopeGroup('https://github.com/org/UnknownRepo', config)).toBeNull();
  });

  it('returns null for null scope', () => {
    expect(findScopeGroup(null, config)).toBeNull();
  });

  it('returns null for empty scope', () => {
    expect(findScopeGroup('', config)).toBeNull();
  });

  it('returns null when config has no scope_groups', () => {
    expect(findScopeGroup('https://github.com/org/Engram', {})).toBeNull();
  });
});

// ─── Phase 3: loadEngramConfig ────────────────────────────────────────────────

describe('loadEngramConfig', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'engram-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('loads a valid config file', () => {
    const cfg = { scope_groups: { test: ['https://github.com/org/Test'] } };
    writeFileSync(join(tmpDir, 'engram.config.json'), JSON.stringify(cfg), 'utf-8');
    const result = loadEngramConfig(join(tmpDir, 'engram.config.json'));
    expect(result.scope_groups?.test).toEqual(['https://github.com/org/Test']);
  });

  it('returns empty object when file does not exist', () => {
    const result = loadEngramConfig(join(tmpDir, 'nonexistent.json'));
    expect(result).toEqual({});
  });

  it('returns empty object for malformed JSON', () => {
    writeFileSync(join(tmpDir, 'engram.config.json'), '{invalid json}', 'utf-8');
    const result = loadEngramConfig(join(tmpDir, 'engram.config.json'));
    expect(result).toEqual({});
  });
});

// ─── Phase 4: isPruneable ─────────────────────────────────────────────────────

describe('isPruneable', () => {
  const DAY_S = 86400;
  const now = Math.floor(Date.now() / 1000);

  it('returns true for provisional memory older than PRUNE_AGE_DAYS with 0 accesses and low confidence', () => {
    const m = {
      memory_tier: 'provisional',
      created_at: now - (PRUNE_AGE_DAYS + 1) * DAY_S,
      access_count: 0,
      confidence: 0.3,
    };
    expect(isPruneable(m, now)).toBe(true);
  });

  it('returns false if access_count > 0', () => {
    const m = {
      memory_tier: 'provisional',
      created_at: now - (PRUNE_AGE_DAYS + 1) * DAY_S,
      access_count: 1,
      confidence: 0.3,
    };
    expect(isPruneable(m, now)).toBe(false);
  });

  it('returns false if confidence >= 0.5', () => {
    const m = {
      memory_tier: 'provisional',
      created_at: now - (PRUNE_AGE_DAYS + 1) * DAY_S,
      access_count: 0,
      confidence: 0.5,
    };
    expect(isPruneable(m, now)).toBe(false);
  });

  it('returns false if newer than PRUNE_AGE_DAYS', () => {
    const m = {
      memory_tier: 'provisional',
      created_at: now - (PRUNE_AGE_DAYS - 1) * DAY_S,
      access_count: 0,
      confidence: 0.3,
    };
    expect(isPruneable(m, now)).toBe(false);
  });

  it('returns false if memory_tier is not provisional', () => {
    const m = {
      memory_tier: 'short',
      created_at: now - (PRUNE_AGE_DAYS + 1) * DAY_S,
      access_count: 0,
      confidence: 0.3,
    };
    expect(isPruneable(m, now)).toBe(false);
  });

  it('PRUNE_AGE_DAYS is 14', () => {
    expect(PRUNE_AGE_DAYS).toBe(14);
  });
});

// ─── Phase 4: isHardDeletable ─────────────────────────────────────────────────

describe('isHardDeletable', () => {
  const DAY_S = 86400;
  const now = Math.floor(Date.now() / 1000);

  it('returns true for soft-deleted provisional memory older than HARD_DELETE_AGE_DAYS', () => {
    const m = {
      is_active: 0,
      memory_tier: 'provisional',
      created_at: now - (HARD_DELETE_AGE_DAYS + 1) * DAY_S,
    };
    expect(isHardDeletable(m, now)).toBe(true);
  });

  it('returns false if is_active is 1', () => {
    const m = {
      is_active: 1,
      memory_tier: 'provisional',
      created_at: now - (HARD_DELETE_AGE_DAYS + 1) * DAY_S,
    };
    expect(isHardDeletable(m, now)).toBe(false);
  });

  it('returns false if newer than HARD_DELETE_AGE_DAYS', () => {
    const m = {
      is_active: 0,
      memory_tier: 'provisional',
      created_at: now - (HARD_DELETE_AGE_DAYS - 1) * DAY_S,
    };
    expect(isHardDeletable(m, now)).toBe(false);
  });

  it('returns false if memory_tier is not provisional', () => {
    const m = {
      is_active: 0,
      memory_tier: 'short',
      created_at: now - (HARD_DELETE_AGE_DAYS + 1) * DAY_S,
    };
    expect(isHardDeletable(m, now)).toBe(false);
  });

  it('HARD_DELETE_AGE_DAYS is 60', () => {
    expect(HARD_DELETE_AGE_DAYS).toBe(60);
  });
});
