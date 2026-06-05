#!/usr/bin/env tsx
/**
 * Engram daemon — loads the embedding model once and serves search/remember
 * over HTTP on localhost:7700. Exits after IDLE_TIMEOUT_MS of inactivity
 * (set ENGRAM_IDLE_MINUTES=0 to disable; default 120).
 *
 * Usage:
 *   npx tsx daemon/server.ts
 *   npm run daemon
 */

import http from 'node:http';
import { pipeline } from '@huggingface/transformers';
import {
  search, saveMemory, getProjectScope, pruneProvisional, promoteProvisional, PROMOTE_ACCESS_THRESHOLD,
  tierCounts, checkCapacity, resolveTierCaps, loadEngramConfig, getMeta, setMeta,
} from '../lib/memory.ts';
import type { SaveOptions } from '../lib/memory.ts';
import { runMaintenanceIfDue } from '../lib/maintenance.ts';
import { consolidateTier } from '../lib/consolidate.ts';

const LAST_MAINTENANCE_KEY = 'last_maintenance_at';
const MAINTENANCE_CHECK_MS =
  parseInt(process.env.ENGRAM_MAINTENANCE_CHECK_MINUTES ?? '30', 10) * 60 * 1000;

/**
 * Run the maintenance pass if due (promote → prune → consolidate flagged tiers).
 * The persisted timestamp gates it to at most once per ENGRAM_MAINTENANCE_HOURS,
 * so calling this often (startup + check timer) is cheap and safe.
 */
async function runMaintenance(): Promise<void> {
  const autoConsolidate = process.env.ENGRAM_AUTO_CONSOLIDATE !== '0';
  try {
    await runMaintenanceIfDue({
      getLastRun: () => { const v = getMeta(LAST_MAINTENANCE_KEY); return v ? Number(v) : null; },
      setLastRun: (ms) => setMeta(LAST_MAINTENANCE_KEY, String(ms)),
      promote: () => promoteProvisional(undefined, PROMOTE_ACCESS_THRESHOLD),
      prune: async () => {
        const r = await pruneProvisional({ apply: true });
        return { softDeleted: r.softDeleted, hardDeleted: r.hardDeleted };
      },
      capacityFlags: () =>
        checkCapacity(tierCounts().active, resolveTierCaps(loadEngramConfig())).filter(t => t.atThreshold),
      consolidate: autoConsolidate
        ? async (tier) => {
            const r = await consolidateTier({ tier, apply: true });
            return { merged: r.merged, archived: r.archived, snapshotId: r.snapshotId };
          }
        : undefined,
      log: (msg) => process.stderr.write(`[Engram daemon] ${msg}\n`),
    });
  } catch (e) {
    process.stderr.write(`[Engram daemon] Maintenance error: ${e}\n`);
  }
}

const PORT = parseInt(process.env.ENGRAM_PORT ?? '7700', 10);
const IDLE_MINUTES = parseInt(process.env.ENGRAM_IDLE_MINUTES ?? '120', 10);
const IDLE_TIMEOUT_MS = Number.isFinite(IDLE_MINUTES) && IDLE_MINUTES > 0
  ? IDLE_MINUTES * 60 * 1000
  : 0;

let idleTimer: NodeJS.Timeout | undefined;

function resetIdleTimer(server: http.Server): void {
  if (IDLE_TIMEOUT_MS === 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    process.stderr.write('[Engram daemon] Idle timeout — shutting down\n');
    server.close(() => process.exit(0));
  }, IDLE_TIMEOUT_MS);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: Record<string, unknown>;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
  catch { res.writeHead(400); res.end(); return; }

  try {
    if (url === '/search') {
      const query = body.query as string;
      const topK = (body.topK as number) ?? 5;
      const projectScope = (body.projectScope as string | null) ?? getProjectScope();
      if (!query) { res.writeHead(400); res.end(); return; }
      const results = await search(query, topK, projectScope);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } else if (url === '/remember') {
      const { title, topic, content, opts } = body as { title: string; topic: string; content: string; opts?: SaveOptions };
      await saveMemory(title, topic, content, opts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
}

async function main(): Promise<void> {
  process.stderr.write('[Engram daemon] Loading model...\n');
  // Warm up the embedding model
  await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
  const idleLabel = IDLE_TIMEOUT_MS === 0 ? 'disabled' : `${IDLE_MINUTES}m`;
  process.stderr.write(`[Engram daemon] Ready on port ${PORT} (idle timeout: ${idleLabel})\n`);

  const server = http.createServer(async (req, res) => {
    resetIdleTimer(server);
    await handleRequest(req, res);
  });

  server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`[Engram daemon] Listening on 127.0.0.1:${PORT}\n`);
  });

  resetIdleTimer(server);

  // Maintenance (promote → prune → consolidate) runs "if due" — gated by a
  // persisted timestamp (ENGRAM_MAINTENANCE_HOURS, default 8h). Run once at
  // startup to catch up after a restart, then re-check on a short timer that
  // fits inside the idle window. The timer is unref'd so it never keeps the
  // process alive on its own.
  void runMaintenance();
  setInterval(() => { void runMaintenance(); }, MAINTENANCE_CHECK_MS).unref();

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT',  () => server.close(() => process.exit(0)));
}

main().catch(e => { process.stderr.write(`[Engram daemon] Fatal: ${e}\n`); process.exit(1); });
