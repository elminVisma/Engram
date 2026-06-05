/**
 * Capacity-cap tests.
 *
 * Always-loaded / growing tiers must not grow unbounded. checkCapacity() is a
 * pure function: given per-tier counts and caps, it flags any tier at or over
 * the consolidation threshold (default 80% of its cap).
 */

import { describe, it, expect } from 'vitest';
import {
  checkCapacity,
  resolveTierCaps,
  CAPACITY_THRESHOLD,
  DEFAULT_TIER_CAPS,
  type MemoryTier,
} from '../lib/utils.ts';

function counts(partial: Partial<Record<MemoryTier, number>>): Record<MemoryTier, number> {
  return {
    pinned: 0, user: 0, shared: 0, long: 0, short: 0, provisional: 0,
    ...partial,
  };
}

describe('checkCapacity', () => {
  it('does not flag a tier under the threshold', () => {
    const result = checkCapacity(counts({ provisional: 79 }), { provisional: 100 });
    const prov = result.find(r => r.tier === 'provisional')!;
    expect(prov.atThreshold).toBe(false);
    expect(prov.over).toBe(false);
  });

  it('flags a tier exactly at the threshold', () => {
    const result = checkCapacity(counts({ provisional: 80 }), { provisional: 100 });
    const prov = result.find(r => r.tier === 'provisional')!;
    expect(prov.atThreshold).toBe(true);
    expect(prov.over).toBe(false);
  });

  it('flags a tier over its cap', () => {
    const result = checkCapacity(counts({ short: 150 }), { short: 100 });
    const short = result.find(r => r.tier === 'short')!;
    expect(short.atThreshold).toBe(true);
    expect(short.over).toBe(true);
  });

  it('skips a tier whose cap is 0 (disabled)', () => {
    const result = checkCapacity(counts({ long: 9999 }), { long: 0 });
    expect(result.find(r => r.tier === 'long')).toBeUndefined();
  });

  it('uses CAPACITY_THRESHOLD for the at-threshold boundary', () => {
    const cap = 10;
    const atCount = Math.ceil(cap * CAPACITY_THRESHOLD);
    const result = checkCapacity(counts({ short: atCount }), { short: cap });
    expect(result.find(r => r.tier === 'short')!.atThreshold).toBe(true);
    const below = checkCapacity(counts({ short: atCount - 1 }), { short: cap });
    expect(below.find(r => r.tier === 'short')!.atThreshold).toBe(false);
  });
});

describe('resolveTierCaps', () => {
  it('returns the defaults when config has no caps', () => {
    expect(resolveTierCaps({})).toEqual(DEFAULT_TIER_CAPS);
  });

  it('config caps override the defaults per tier', () => {
    const resolved = resolveTierCaps({ caps: { provisional: 42 } });
    expect(resolved.provisional).toBe(42);
    expect(resolved.short).toBe(DEFAULT_TIER_CAPS.short);
  });

  it('a config override flips the at-threshold flag', () => {
    const c = counts({ provisional: 42 });
    const loose = checkCapacity(c, resolveTierCaps({ caps: { provisional: 1000 } }));
    const tight = checkCapacity(c, resolveTierCaps({ caps: { provisional: 50 } }));
    expect(loose.find(r => r.tier === 'provisional')!.atThreshold).toBe(false);
    expect(tight.find(r => r.tier === 'provisional')!.atThreshold).toBe(true);
  });
});
