/**
 * Standalone smoke test — runs the SQL/transaction logic exercised by
 * tests/integration.test.ts without needing vitest. Validates:
 *   - migrations apply cleanly to a fresh DB
 *   - the supersession transaction (the one in saveMemory)
 *   - the promote SQL (replicated from scripts/promote.ts)
 *   - the decay math + cutoff (replicated from scripts/decay.ts)
 *   - the reindex orphan reactivation SQL
 *   - parseClassifyOutput unwrapping
 *
 * Run with: npx tsx tests/smoke.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema } from '../lib/migrate.ts';
import {
  serialize, cosineDistance, decideSave, parseClassifyOutput,
} from '../lib/utils.ts';
import { pin, unpin, listPinned } from '../lib/pin.ts';

let pass = 0;
let fail = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else      { fail++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
}

function eq<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else    { fail++; console.log(`  \x1b[31m✗\x1b[0m ${msg}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

function withTmpDb<T>(fn: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'engram-smoke-'));
  const dbPath = join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  try {
    ensureSchema(db);
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function emb(v: number[]): Buffer {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return serialize(v.map(x => x / norm));
}

function seed(db: DatabaseSync, args: {
  title: string;
  embedding: Buffer;
  tier?: 'short' | 'long';
  projectScope?: string | null;
  confidence?: number;
  decayRate?: number;
  accessCount?: number;
  isActive?: number;
  path?: string;
}): number {
  const r = db.prepare(`
    INSERT INTO memories
      (path, title, tags, topic, chunk, memory_tier, project_scope,
       confidence, decay_rate, access_count, is_active, embedding)
    VALUES (?, ?, 'smoke', 'smoke', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.path ?? `${args.title}.md`,
    args.title, args.title,
    args.tier ?? 'short',
    args.projectScope ?? null,
    args.confidence ?? 1.0,
    args.decayRate ?? 0.02,
    args.accessCount ?? 0,
    args.isActive ?? 1,
    args.embedding,
  );
  return Number(r.lastInsertRowid);
}

// ─── Migrations ───────────────────────────────────────────────────────────────
console.log('\n— Migrations —');
withTmpDb(db => {
  const v = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  eq(v, 5, 'schema migrates to v5');
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const names = cols.map(c => c.name);
  for (const expected of ['embedding', 'memory_tier', 'project_scope', 'confidence', 'decay_rate', 'access_count', 'file_hash', 'supersedes', 'superseded_by', 'pin_order', 'scope_group', 'previous_tier']) {
    assert(names.includes(expected), `column ${expected} exists`);
  }
});

// ─── Phase 0: extended tiers + pin_order + scope_group ────────────────────────
console.log('\n— Phase 0: extended tiers —');
withTmpDb(db => {
  // New tier values persist
  for (const tier of ['pinned', 'user', 'shared', 'provisional']) {
    db.prepare(
      `INSERT INTO memories (path, chunk, memory_tier) VALUES (?, ?, ?)`
    ).run(`p/${tier}.md`, `chunk ${tier}`, tier);
  }
  const rows = db.prepare(
    `SELECT memory_tier FROM memories
     WHERE memory_tier IN ('pinned','user','shared','provisional')
     ORDER BY memory_tier`
  ).all() as Array<{ memory_tier: string }>;
  eq(rows.map(r => r.memory_tier), ['pinned', 'provisional', 'shared', 'user'],
     'new tier values persist (pinned/user/shared/provisional)');

  // pin_order persists and orders correctly
  const ins = db.prepare(
    `INSERT INTO memories (path, chunk, memory_tier, pin_order) VALUES (?, ?, 'pinned', ?)`
  );
  ins.run('pin-a.md', 'a', 2);
  ins.run('pin-b.md', 'b', 1);
  const pinRows = db.prepare(
    `SELECT path FROM memories WHERE path LIKE 'pin-%' ORDER BY pin_order`
  ).all() as Array<{ path: string }>;
  eq(pinRows.map(r => r.path), ['pin-b.md', 'pin-a.md'], 'pin_order orders rows correctly');

  // scope_group persists for shared tier
  db.prepare(
    `INSERT INTO memories (path, chunk, memory_tier, scope_group) VALUES (?, ?, 'shared', ?)`
  ).run('grp.md', 'g', 'payroller');
  const grpRow = db.prepare(
    `SELECT scope_group FROM memories WHERE path = 'grp.md'`
  ).get() as { scope_group: string };
  eq(grpRow.scope_group, 'payroller', 'scope_group persists');

  // Index on (memory_tier, project_scope) exists
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'"
  ).all() as Array<{ name: string }>;
  const hasTierScopeIdx = indexes.some(i => i.name.includes('tier') && i.name.includes('scope'));
  assert(hasTierScopeIdx, 'index on (memory_tier, project_scope) exists');
});

// ─── Phase 0: legacy v4 DB upgrades cleanly ───────────────────────────────────
console.log('\n— Phase 0: v4 → v5 upgrade —');
{
  const dir = mkdtempSync(join(tmpdir(), 'engram-smoke-v4-'));
  const dbPath = join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  try {
    // Simulate a v4 DB
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`INSERT INTO schema_version (version) VALUES (4)`);
    db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT,
        tags TEXT,
        topic TEXT,
        chunk TEXT NOT NULL,
        session_id TEXT,
        source_excerpt TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        supersedes INTEGER,
        superseded_by INTEGER,
        is_active INTEGER DEFAULT 1,
        memory_tier TEXT DEFAULT 'short',
        project_scope TEXT,
        confidence REAL DEFAULT 1.0,
        decay_rate REAL DEFAULT 0.02,
        access_count INTEGER DEFAULT 0,
        last_accessed_at INTEGER,
        file_hash TEXT,
        embedding BLOB
      )
    `);
    db.prepare(
      `INSERT INTO memories (path, chunk, memory_tier, project_scope) VALUES (?, ?, ?, ?)`
    ).run('legacy.md', 'legacy chunk', 'short', 'https://example.com/legacy.git');

    ensureSchema(db);

    const v = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    eq(v, 5, 'v4 DB upgrades to v5');

    const legacy = db.prepare(
      `SELECT chunk, memory_tier, project_scope FROM memories WHERE path = 'legacy.md'`
    ).get() as { chunk: string; memory_tier: string; project_scope: string };
    eq(legacy, {
      chunk: 'legacy chunk',
      memory_tier: 'short',
      project_scope: 'https://example.com/legacy.git',
    }, 'legacy row data preserved through v4 → v5');

    // pin_order column exists after upgrade
    const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    assert(names.includes('pin_order'), 'pin_order column added during upgrade');
    assert(names.includes('scope_group'), 'scope_group column added during upgrade');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Phase 0: ensureSchema is idempotent ──────────────────────────────────────
console.log('\n— Phase 0: idempotence —');
withTmpDb(db => {
  let threw = false;
  try { ensureSchema(db); ensureSchema(db); } catch { threw = true; }
  assert(!threw, 'ensureSchema can be called twice on same DB without error');
  const v = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  eq(v, 5, 'version still v5 after double call');
});

// ─── Supersession transaction (replicating saveMemory's body) ─────────────────
console.log('\n— Supersession —');
withTmpDb(db => {
  const oldId = seed(db, { title: 'old', embedding: emb([1, 0, 0, 0]) });

  // New row at distance ~0.25 from old — between 0.15 (dup) and 0.35 (supersede)
  // For unit [1,0,0,0] and unit [0.75, 0.6614, 0, 0]: dot=0.75, distance=0.25
  const newEmb = emb([0.75, 0.6614, 0, 0]);
  const candidates = db.prepare(
    'SELECT id, embedding FROM memories WHERE is_active = 1 AND embedding IS NOT NULL'
  ).all() as Array<{ id: number; embedding: Uint8Array }>;
  const scored = candidates.map(c => ({ id: c.id, distance: cosineDistance(newEmb, c.embedding) }))
    .sort((a, b) => a.distance - b.distance).slice(0, 5);
  const decision = decideSave(scored);
  assert(typeof decision === 'object' && decision !== null && 'supersede' in decision,
         'decideSave returns supersede for distance ~0.05');

  // Run the transaction (mirrors lib/memory.ts:241-264)
  db.exec('BEGIN');
  const result = db.prepare(`
    INSERT INTO memories
      (path, title, tags, topic, chunk, memory_tier, confidence, decay_rate,
       supersedes, is_active, embedding)
    VALUES ('new.md', 'new', 'smoke', 'smoke', 'new', 'short', 1.0, 0.02, ?, 1, ?)
  `).run((decision as { supersede: number }).supersede, newEmb);
  const newId = Number(result.lastInsertRowid);
  db.prepare('UPDATE memories SET is_active = 0, superseded_by = ? WHERE id = ?')
    .run(newId, (decision as { supersede: number }).supersede);
  db.exec('COMMIT');

  const oldRow = db.prepare('SELECT is_active, superseded_by FROM memories WHERE id = ?').get(oldId) as
    { is_active: number; superseded_by: number };
  const newRow = db.prepare('SELECT supersedes, is_active FROM memories WHERE id = ?').get(newId) as
    { supersedes: number; is_active: number };
  eq(oldRow.is_active, 0, 'old memory marked inactive');
  eq(oldRow.superseded_by, newId, 'old.superseded_by points to new');
  eq(newRow.supersedes, oldId, 'new.supersedes points to old');
  eq(newRow.is_active, 1, 'new memory remains active');
});

// ─── Duplicate skip ───────────────────────────────────────────────────────────
console.log('\n— Duplicate skip —');
withTmpDb(db => {
  seed(db, { title: 'orig', embedding: emb([1, 0, 0, 0]) });
  // Near-identical embedding → distance < 0.15 → skip
  const newEmb = emb([0.999, 0.045, 0, 0]);
  const candidates = db.prepare(
    'SELECT id, embedding FROM memories WHERE is_active = 1 AND embedding IS NOT NULL'
  ).all() as Array<{ id: number; embedding: Uint8Array }>;
  const scored = candidates.map(c => ({ id: c.id, distance: cosineDistance(newEmb, c.embedding) }))
    .sort((a, b) => a.distance - b.distance).slice(0, 5);
  eq(decideSave(scored), 'skip', 'decideSave returns skip for near-duplicate');
});

// ─── Promote SQL ──────────────────────────────────────────────────────────────
console.log('\n— Promote SQL —');
withTmpDb(db => {
  const e = emb([1, 0, 0, 0]);
  seed(db, { title: 'low',          embedding: e, tier: 'short', accessCount: 1 });
  seed(db, { title: 'at-threshold', embedding: e, tier: 'short', accessCount: 3 });
  seed(db, { title: 'above',        embedding: e, tier: 'short', accessCount: 10 });
  seed(db, { title: 'long',         embedding: e, tier: 'long',  accessCount: 99 });
  seed(db, { title: 'inactive',     embedding: e, tier: 'short', accessCount: 99, isActive: 0 });

  const eligible = db.prepare(`
    SELECT title FROM memories
    WHERE is_active = 1 AND memory_tier = 'short' AND access_count >= ?
    ORDER BY title
  `).all(3) as Array<{ title: string }>;
  eq(eligible.map(r => r.title), ['above', 'at-threshold'], 'only short-term ≥ threshold are eligible');

  // Promote: scope cleared, tier=long
  const id = seed(db, { title: 'promote-me', embedding: e, tier: 'short',
                        projectScope: 'https://github.com/foo/bar', accessCount: 5 });
  db.prepare(`UPDATE memories SET memory_tier = 'long', project_scope = NULL WHERE id = ?`).run(id);
  const row = db.prepare('SELECT memory_tier, project_scope FROM memories WHERE id = ?').get(id) as
    { memory_tier: string; project_scope: string | null };
  eq(row.memory_tier, 'long', 'promoted memory tier=long');
  eq(row.project_scope, null, 'promoted memory project_scope=NULL');
});

// ─── Decay math + cutoff ──────────────────────────────────────────────────────
console.log('\n— Decay —');
withTmpDb(db => {
  const e = emb([1, 0, 0, 0]);
  const longId = seed(db, { title: 'long',     embedding: e, tier: 'long',  confidence: 1.0, decayRate: 0.02 });
  const decayId = seed(db, { title: 'short',   embedding: e, tier: 'short', confidence: 1.0, decayRate: 0.02 });
  const dyingId = seed(db, { title: 'dying',   embedding: e, tier: 'short', confidence: 0.10, decayRate: 0.02 });

  const cutoff = 0.10;
  const rows = db.prepare(`SELECT id, confidence, decay_rate FROM memories
                           WHERE is_active = 1 AND memory_tier = 'short'`).all() as
    Array<{ id: number; confidence: number; decay_rate: number }>;
  for (const r of rows) {
    const newConf = r.confidence * (1 - r.decay_rate);
    if (newConf < cutoff) {
      db.prepare('UPDATE memories SET confidence = ?, is_active = 0 WHERE id = ?').run(newConf, r.id);
    } else {
      db.prepare('UPDATE memories SET confidence = ? WHERE id = ?').run(newConf, r.id);
    }
  }

  const longRow = db.prepare('SELECT confidence, is_active FROM memories WHERE id = ?').get(longId) as
    { confidence: number; is_active: number };
  const decayRow = db.prepare('SELECT confidence, is_active FROM memories WHERE id = ?').get(decayId) as
    { confidence: number; is_active: number };
  const dyingRow = db.prepare('SELECT confidence, is_active FROM memories WHERE id = ?').get(dyingId) as
    { confidence: number; is_active: number };

  eq(longRow.confidence, 1.0, 'long-term confidence unchanged');
  eq(longRow.is_active, 1, 'long-term still active');
  assert(Math.abs(decayRow.confidence - 0.98) < 1e-6, `short confidence: 1.0 → ${decayRow.confidence.toFixed(4)} (expected 0.98)`);
  eq(decayRow.is_active, 1, 'short still active above cutoff');
  eq(dyingRow.is_active, 0, 'short below cutoff deactivated');
});

// ─── Orphan reactivation ──────────────────────────────────────────────────────
console.log('\n— Orphan reactivation —');
withTmpDb(db => {
  const e = emb([1, 0, 0, 0]);
  const oldId = seed(db, { title: 'old-in-B', embedding: e, path: 'file-B.md', isActive: 0 });
  const newId = seed(db, { title: 'new-in-A', embedding: e, path: 'file-A.md' });
  db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(newId, oldId);

  // Re-indexing file-A: reactivate orphans pointing at file-A's rows, then delete
  db.prepare(`
    UPDATE memories
    SET is_active = 1, superseded_by = NULL
    WHERE superseded_by IN (SELECT id FROM memories WHERE path = ?)
      AND path != ?
  `).run('file-A.md', 'file-A.md');
  db.prepare('DELETE FROM memories WHERE path = ?').run('file-A.md');

  const oldRow = db.prepare('SELECT is_active, superseded_by FROM memories WHERE id = ?').get(oldId) as
    { is_active: number; superseded_by: number | null };
  const aCount = (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE path = ?').get('file-A.md') as { c: number }).c;
  eq(oldRow.is_active, 1, 'orphaned memory reactivated');
  eq(oldRow.superseded_by, null, 'superseded_by cleared');
  eq(aCount, 0, 'file-A rows deleted');
});

// ─── Phase 1a: pin / unpin / listPinned ───────────────────────────────────────
console.log('\n— Phase 1a: pin / unpin / listPinned —');
withTmpDb(db => {
  const e = emb([1, 0, 0, 0]);
  const idShort = seed(db, { title: 'short-mem',   embedding: e, tier: 'short', projectScope: 'https://example.com/a.git' });
  const idLong  = seed(db, { title: 'long-mem',    embedding: e, tier: 'long' });
  const idOther = seed(db, { title: 'other-mem',   embedding: e, tier: 'short', projectScope: 'https://example.com/b.git' });

  // pin: short memory becomes pinned with given order
  pin(idShort, 1, db);
  const pinned = db.prepare('SELECT memory_tier, pin_order FROM memories WHERE id = ?').get(idShort) as
    { memory_tier: string; pin_order: number };
  eq(pinned.memory_tier, 'pinned', 'pin() sets memory_tier=pinned');
  eq(pinned.pin_order, 1, 'pin() sets pin_order');

  // pin: long memory — preserves global scope (project_scope NULL)
  pin(idLong, 2, db);
  const pinnedLong = db.prepare('SELECT memory_tier, pin_order, project_scope FROM memories WHERE id = ?').get(idLong) as
    { memory_tier: string; pin_order: number; project_scope: string | null };
  eq(pinnedLong.memory_tier, 'pinned', 'long memory pinned');
  eq(pinnedLong.project_scope, null, 'pinned long-tier keeps NULL scope');

  // listPinned by scope: returns pinned in that scope + globally-pinned (NULL scope), ordered
  const pinsForA = listPinned('https://example.com/a.git', db);
  eq(pinsForA.map(p => p.id), [idShort, idLong], 'listPinned returns scope-matching + global pins, ordered by pin_order');

  // listPinned for unrelated scope returns only global pins
  const pinsForB = listPinned('https://example.com/b.git', db);
  eq(pinsForB.map(p => p.id), [idLong], 'listPinned excludes pins from other project scopes');

  // unpin: restores to 'short' tier and clears pin_order
  unpin(idShort, db);
  const unpinned = db.prepare('SELECT memory_tier, pin_order FROM memories WHERE id = ?').get(idShort) as
    { memory_tier: string; pin_order: number | null };
  eq(unpinned.memory_tier, 'short', 'unpin() restores tier (short for scoped memory)');
  eq(unpinned.pin_order, null, 'unpin() clears pin_order');

  // unpin a long-tier-originally pin: restores to 'long'
  unpin(idLong, db);
  const unpinnedLong = db.prepare('SELECT memory_tier FROM memories WHERE id = ?').get(idLong) as
    { memory_tier: string };
  eq(unpinnedLong.memory_tier, 'long', 'unpin() restores tier (long for globally-scoped memory)');

  // pinning a non-existent id throws
  let threw = false;
  try { pin(999999, 1, db); } catch { threw = true; }
  assert(threw, 'pin() on unknown id throws');

  // unrelated memory untouched
  const other = db.prepare('SELECT memory_tier FROM memories WHERE id = ?').get(idOther) as { memory_tier: string };
  eq(other.memory_tier, 'short', 'unrelated memory unaffected');
});

// ─── parseClassifyOutput ──────────────────────────────────────────────────────
console.log('\n— parseClassifyOutput —');
{
  const wrapped = JSON.stringify({ type: 'result',
    result: '{"worth_saving": true, "title": "x", "content": "y", "excerpt": "z"}' });
  const d1 = parseClassifyOutput(wrapped);
  assert(d1?.worth_saving === true && d1.title === 'x', 'unwraps CLI {result: ...} envelope');

  const fenced = JSON.stringify({ result: '```json\n{"worth_saving": false}\n```' });
  const d2 = parseClassifyOutput(fenced);
  eq(d2, { worth_saving: false }, 'handles fenced JSON inside wrapper');

  const bare = parseClassifyOutput('{"worth_saving": false}');
  eq(bare, { worth_saving: false }, 'parses bare JSON');

  eq(parseClassifyOutput(''), null, 'empty string → null');
  eq(parseClassifyOutput('   '), null, 'whitespace → null');
  eq(parseClassifyOutput('{invalid'), null, 'malformed JSON → null');
  eq(parseClassifyOutput('{"title": "no flag"}'), null, 'missing worth_saving → null');
  eq(parseClassifyOutput('{"worth_saving": "yes"}'), null, 'non-boolean worth_saving → null');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass + fail} assertions: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
