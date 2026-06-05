/**
 * Maintenance orchestration — promote, prune, and capacity-triggered
 * consolidation, run "if due" based on a persisted last-run timestamp.
 *
 * Why not a plain setInterval: the daemon's idle timeout (default 120m) is
 * shorter than the maintenance interval (default 8h), so a long timer rarely
 * fires. Instead the daemon calls runMaintenanceIfDue() at startup and on a
 * short check timer; the persisted timestamp ensures the heavy pass runs at
 * most once per interval regardless of how often the daemon restarts.
 */

import { isMaintenanceDue, type TierCapacity, type MemoryTier } from './utils.ts';

export const MAINTENANCE_INTERVAL_HOURS = parseFloat(process.env.ENGRAM_MAINTENANCE_HOURS ?? '8');
export const MAINTENANCE_INTERVAL_MS = MAINTENANCE_INTERVAL_HOURS * 3600_000;

export interface ConsolidateSummary { merged: number; archived: number; snapshotId?: string; }

export interface MaintenanceDeps {
  /** Last-run timestamp in epoch ms, or null if never run. */
  getLastRun: () => number | null;
  /** Persist the run timestamp (epoch ms). */
  setLastRun: (ms: number) => void;
  /** Promote eligible provisional memories; returns count promoted. */
  promote: () => number;
  /** Prune stale provisional memories. */
  prune: () => Promise<{ softDeleted: number; hardDeleted: number }>;
  /** Tiers currently at/over their capacity threshold. */
  capacityFlags: () => TierCapacity[];
  /** Consolidate a flagged tier. Omit to disable consolidation (prune/promote still run). */
  consolidate?: (tier: MemoryTier) => Promise<ConsolidateSummary>;
  now?: () => number;
  intervalMs?: number;
  log?: (msg: string) => void;
}

export interface MaintenanceResult {
  ran: boolean;
  promoted: number;
  softDeleted: number;
  hardDeleted: number;
  consolidated: { tier: MemoryTier; merged: number; archived: number }[];
}

const NOT_RUN: MaintenanceResult = { ran: false, promoted: 0, softDeleted: 0, hardDeleted: 0, consolidated: [] };

/**
 * Run the maintenance pass only if the interval has elapsed since the last run.
 * Records the run timestamp on success. Steps: promote → prune → (per flagged
 * tier) consolidate.
 */
export async function runMaintenanceIfDue(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  const now = deps.now ? deps.now() : Date.now();
  const intervalMs = deps.intervalMs ?? MAINTENANCE_INTERVAL_MS;

  if (!isMaintenanceDue(deps.getLastRun(), now, intervalMs)) return { ...NOT_RUN };

  const promoted = deps.promote();
  const { softDeleted, hardDeleted } = await deps.prune();

  const consolidated: MaintenanceResult['consolidated'] = [];
  if (deps.consolidate) {
    for (const t of deps.capacityFlags()) {
      const r = await deps.consolidate(t.tier);
      if (r.merged > 0) consolidated.push({ tier: t.tier, merged: r.merged, archived: r.archived });
    }
  }

  deps.setLastRun(now);

  if (deps.log && (promoted > 0 || softDeleted > 0 || hardDeleted > 0 || consolidated.length > 0)) {
    const cons = consolidated.map(c => `${c.tier}(+${c.merged}/-${c.archived})`).join(' ');
    deps.log(`maintenance: promoted=${promoted} soft=${softDeleted} hard=${hardDeleted}${cons ? ` consolidated=${cons}` : ''}`);
  }

  return { ran: true, promoted, softDeleted, hardDeleted, consolidated };
}
