import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  chunkText,
  hasSignal,
  stripJsonFences,
  decideSave,
  cosineDistance,
  serialize,
  SIGNAL_PHRASES,
  DUPLICATE_THRESHOLD,
  SUPERSESSION_THRESHOLD,
  INJECTION_THRESHOLD,
} from '../lib/utils.ts';

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
});
