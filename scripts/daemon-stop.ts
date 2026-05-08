#!/usr/bin/env tsx
/**
 * Stop the running Engram daemon by querying /health for its pid.
 * Exits 0 if killed or already stopped; non-zero on unexpected failure.
 */

const PORT = parseInt(process.env.ENGRAM_PORT ?? '7700', 10);

async function main(): Promise<void> {
  let pid: number | undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      process.stderr.write(`[daemon:stop] /health returned ${res.status}\n`);
      process.exit(0);
    }
    const body = await res.json() as { pid?: number };
    pid = body.pid;
  } catch {
    process.stdout.write(`[daemon:stop] Daemon not running on port ${PORT}\n`);
    return;
  }

  if (!pid) {
    process.stderr.write('[daemon:stop] /health did not return a pid\n');
    process.exit(1);
  }

  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`[daemon:stop] Sent SIGTERM to pid ${pid}\n`);
  } catch (e) {
    process.stderr.write(`[daemon:stop] Failed to kill pid ${pid}: ${e}\n`);
    process.exit(1);
  }
}

main();
