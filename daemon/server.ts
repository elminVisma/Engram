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
import { search, saveMemory, getProjectScope } from '../lib/memory.ts';
import type { SaveOptions } from '../lib/memory.ts';

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

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT',  () => server.close(() => process.exit(0)));
}

main().catch(e => { process.stderr.write(`[Engram daemon] Fatal: ${e}\n`); process.exit(1); });
