/**
 * Pure utility functions — no native Node deps.
 * Imported by lib/memory.ts, tests, and scripts.
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { basename, join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const DUPLICATE_THRESHOLD = 0.15;
export const SUPERSESSION_THRESHOLD = 0.35;
export const INJECTION_THRESHOLD = 0.75;

export const PROMOTE_ACCESS_THRESHOLD = parseInt(process.env.ENGRAM_PROMOTE_THRESHOLD ?? '10', 10);

export const USER_TIER_PHRASES = [
  'i prefer', 'i always', 'i never', 'i typically', 'i usually', 'i tend to',
  'my preference', 'my workflow', 'my approach', 'i like to', 'i dislike',
  'i find that', 'for me ', 'personally i', 'i generally',
];

export function detectUserScope(text: string): boolean {
  if (!text || text.length < 5) return false;
  const lower = text.toLowerCase();
  return USER_TIER_PHRASES.some(p => lower.includes(p));
}

// ─── Phase 3: scope groups + config ──────────────────────────────────────────

export interface EngramConfig {
  scope_groups?: Record<string, string[]>;
  /** Per-tier item caps. A cap of 0 disables capacity checking for that tier. */
  caps?: Partial<Record<MemoryTier, number>>;
}

const DEFAULT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'engram.config.json');

export function loadEngramConfig(configPath: string = DEFAULT_CONFIG_PATH): EngramConfig {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as EngramConfig;
  } catch {
    return {};
  }
}

/** Strip protocol/host/suffix noise so https:// and git@ URLs compare equal. */
function normalizeRepoPath(url: string): string {
  return url
    .replace(/\.git$/, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .toLowerCase();
}

/**
 * Pure lookup: given a git remote URL and a parsed config, return the group
 * name whose URL list contains (or is contained in) the scope string.
 * Normalises both sides so https:// and git@ variants match.
 */
export function findScopeGroup(scope: string | null, config: EngramConfig): string | null {
  if (!scope || !config.scope_groups) return null;
  const ns = normalizeRepoPath(scope);
  for (const [group, urls] of Object.entries(config.scope_groups)) {
    if (urls.some(u => {
      const nu = normalizeRepoPath(u);
      return ns === nu || ns.includes(nu) || nu.includes(ns);
    })) return group;
  }
  return null;
}

/**
 * Impure: reads the config file and resolves the scope group for the current
 * working directory's git remote.
 */
export function getScopeGroup(cwd?: string, configPath?: string): string | null {
  const scope = getProjectScope(cwd);
  if (!scope) return null;
  return findScopeGroup(scope, loadEngramConfig(configPath));
}

// ─── Capacity caps (flag growing tiers for consolidation) ────────────────────

/** Fraction of a tier's cap at which it is flagged for consolidation. */
export const CAPACITY_THRESHOLD = parseFloat(process.env.ENGRAM_CAPACITY_THRESHOLD ?? '0.8');

/**
 * Default per-tier item caps. `pinned` mirrors the SessionStart injection limit
 * (ENGRAM_PIN_LIMIT, ~10). The growing tiers (short/provisional) get the largest
 * caps because they accrete the fastest. A cap of 0 disables the check.
 */
export const DEFAULT_TIER_CAPS: Record<MemoryTier, number> = {
  pinned: 10,
  user: 60,
  shared: 80,
  long: 200,
  short: 400,
  provisional: 200,
};

const ALL_TIER_NAMES: MemoryTier[] = ['pinned', 'user', 'shared', 'long', 'short', 'provisional'];

/**
 * Merge default caps with config overrides and per-tier env overrides
 * (`ENGRAM_CAP_<TIER>`, e.g. ENGRAM_CAP_PROVISIONAL=50). Pure given its inputs.
 */
export function resolveTierCaps(
  config: EngramConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<MemoryTier, number> {
  const resolved = { ...DEFAULT_TIER_CAPS };
  for (const tier of ALL_TIER_NAMES) {
    const fromConfig = config.caps?.[tier];
    if (typeof fromConfig === 'number' && Number.isFinite(fromConfig)) resolved[tier] = fromConfig;
    const fromEnv = env[`ENGRAM_CAP_${tier.toUpperCase()}`];
    if (fromEnv !== undefined && fromEnv !== '' && Number.isFinite(Number(fromEnv))) {
      resolved[tier] = Number(fromEnv);
    }
  }
  return resolved;
}

export interface TierCapacity {
  tier: MemoryTier;
  count: number;
  cap: number;
  ratio: number;
  atThreshold: boolean;
  over: boolean;
}

/**
 * Pure capacity check. Given active counts per tier and resolved caps, returns
 * one entry per tier with a positive cap, flagging those at/over the threshold.
 * Tiers with cap <= 0 are omitted (disabled).
 */
export function checkCapacity(
  counts: Record<MemoryTier, number>,
  caps: Partial<Record<MemoryTier, number>>,
  threshold: number = CAPACITY_THRESHOLD,
): TierCapacity[] {
  const out: TierCapacity[] = [];
  for (const tier of ALL_TIER_NAMES) {
    const cap = caps[tier] ?? 0;
    if (cap <= 0) continue;
    const count = counts[tier] ?? 0;
    const ratio = count / cap;
    out.push({
      tier,
      count,
      cap,
      ratio,
      atThreshold: count >= cap * threshold,
      over: count > cap,
    });
  }
  return out;
}

export const SIGNAL_PHRASES = [
  // Discovery
  'turns out', 'it turns out', 'discovered that', 'found that', 'realized that',
  'interestingly', 'surprisingly', 'unexpectedly', 'what i found',
  // Problems & root causes
  'the issue was', 'the problem was', 'root cause', 'the bug was', 'the culprit',
  'what broke', 'why it failed', 'the reason it', 'the cause',
  // Solutions
  'fixed by', 'resolved by', 'solved by', 'the fix is', 'the solution is',
  'the workaround', 'what worked',
  // Patterns & insights
  'the trick is', 'the trick here', 'the key insight', 'important to note',
  'worth noting', 'the pattern here', 'the pattern is',
  // Constraints & warnings
  'always ensure', 'never do', 'avoid', 'make sure to', 'be careful',
  'watch out', 'non-obvious', 'counterintuitive', 'caveat', 'edge case',
  'the catch is', 'gotcha', 'pitfall',
  // Learnings
  'learned that', 'this means', 'the implication', 'takeaway', 'lesson',
  'what this means', 'worth remembering',
];

export type MemoryTier =
  | 'short'        // default — project-scoped, lifetime managed by access/decay
  | 'long'         // global, durable
  | 'pinned'       // injected at SessionStart for matching scope
  | 'user'         // user-level facts; surface in every project
  | 'shared'       // cross-project within a scope_group
  | 'provisional'; // newly saved, promoted/demoted by access

export function serialize(vector: number[]): Buffer {
  // Float32Array owns its own ArrayBuffer (byteOffset=0), so Buffer.from produces
  // a Buffer where byteOffset is also 0 — safe for cosineDistance to read back.
  const arr = new Float32Array(vector);
  return Buffer.from(arr.buffer);
}

/** Cosine distance between two Float32 embedding buffers. Returns 0 (identical) to 2 (opposite). */
export function cosineDistance(a: Uint8Array, b: Uint8Array): number {
  const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < fa.length; i++) {
    dot += fa[i] * fb[i];
    na += fa[i] * fa[i];
    nb += fb[i] * fb[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}

export function today(): string {
  return new Date().toISOString().split('T')[0];
}

export function hasSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return SIGNAL_PHRASES.some(p => lower.includes(p));
}

// Task 6: sanitize topic to prevent path traversal
export function sanitizeTopic(topic: string): string {
  const sanitized = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized || sanitized.includes('..')) return 'general';
  return sanitized;
}

export function getTopicFromGit(cwd?: string): string {
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd,
    }).trim();

    if (!branch || branch === 'main' || branch === 'master') {
      const repoPath = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd,
      }).trim();
      return sanitizeTopic(basename(repoPath));
    }

    return sanitizeTopic(branch);
  } catch {
    return 'general';
  }
}

/** Returns the git remote origin URL for the given cwd (or current dir), or null. */
export function getProjectScope(cwd?: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd,
    }).trim();
    return remote || null;
  } catch {
    return null;
  }
}

/**
 * Sliding window chunker with heading-aware splitting.
 */
export function chunkText(text: string, size = 400, overlap = 80): string[] {
  const sections = text.split(/(?=^#{1,3}\s)/m).filter(s => s.trim().length > 20);
  const chunks: string[] = [];

  for (const section of sections) {
    const words = section.split(/\s+/).filter(Boolean);
    if (words.length <= size) {
      chunks.push(section.trim());
      continue;
    }
    let i = 0;
    while (i < words.length) {
      const chunk = words.slice(i, i + size).join(' ');
      if (chunk.trim()) chunks.push(chunk);
      i += size - overlap;
      if (i >= words.length) break;
    }
  }

  return chunks.filter(c => c.trim().length > 20);
}

// Task 3: helper to strip markdown code fences before JSON.parse
export function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

export interface HeuristicExtract {
  title: string;
  content: string;
  excerpt: string;
}

/**
 * Extracts a saveable memory from response text without an LLM call.
 * Finds the first sentence containing a signal phrase, uses it as the anchor.
 * Returns null if no signal phrase found or text is too short.
 */
export function heuristicExtract(text: string): HeuristicExtract | null {
  if (text.length < 20) return null;

  const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) ?? [];
  if (sentences.length === 0) return null;

  const lower = text.toLowerCase();
  let signalSentenceIdx = -1;

  outer:
  for (const phrase of SIGNAL_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx === -1) continue;
    let pos = 0;
    for (let i = 0; i < sentences.length; i++) {
      pos += sentences[i].length;
      if (pos > idx) {
        signalSentenceIdx = i;
        break outer;
      }
    }
  }

  if (signalSentenceIdx === -1) return null;

  const contentSentences = sentences.slice(signalSentenceIdx, signalSentenceIdx + 3);
  const content = contentSentences.join(' ').trim().slice(0, 500);
  const signalSentence = sentences[signalSentenceIdx].trim();
  const title = signalSentence.split(/\s+/).slice(0, 8).join(' ').replace(/[.!?,]+$/, '').slice(0, 60);

  return { title, content, excerpt: signalSentence.slice(0, 200) };
}

// ─── Phase 5: associative recall ─────────────────────────────────────────────

export const MAX_CONCEPTS = parseInt(process.env.ENGRAM_MAX_CONCEPTS ?? '5', 10);

// Common sentence-starting or structural words to exclude from concept extraction
const HEURISTIC_STOP_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'With', 'From', 'What', 'When',
  'Where', 'How', 'Why', 'Which', 'For', 'But', 'And', 'Not', 'Have', 'Has',
  'Can', 'Will', 'Would', 'Should', 'Could', 'May', 'Make', 'Also', 'Just',
  'More', 'Some', 'Your', 'Their', 'Then', 'Than', 'Very', 'Each', 'Even',
  'Well', 'Only', 'Both', 'Into', 'Over', 'After', 'Before', 'Through',
  'Still', 'While', 'Since', 'Again', 'Here', 'There', 'Were', 'Been',
  'Being', 'Does', 'Dont', 'Must', 'Such', 'Same', 'Like', 'Let', 'Get',
]);

/**
 * Heuristic concept extractor — no API call, extracts technical terms from text.
 * Captures: backtick spans, PascalCase/camelCase identifiers, ALL_CAPS abbreviations.
 */
export function extractConceptsHeuristic(text: string, max = MAX_CONCEPTS): string[] {
  const concepts = new Set<string>();

  // Backtick code spans (highest priority — explicitly quoted technical terms)
  for (const m of text.matchAll(/`([^`\n]{2,40})`/g)) {
    const t = m[1].trim();
    if (t.length >= 2) concepts.add(t);
  }

  // PascalCase (e.g., PostgreSQL, WebSocket) and camelCase (e.g., useState, getTopicFromGit)
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9]{2,}|[a-z]{2,}[A-Z][a-zA-Z0-9]*)\b/g)) {
    if (!HEURISTIC_STOP_WORDS.has(m[1])) concepts.add(m[1]);
  }

  // ALL_CAPS abbreviations 3+ chars (e.g., JWT, SQL, API, HTTP)
  for (const m of text.matchAll(/\b([A-Z]{3,})\b/g)) {
    concepts.add(m[1]);
  }

  return [...concepts].slice(0, max);
}

/** Build the prompt to send to Haiku for concept extraction. */
export function buildConceptsPrompt(promptText: string): string {
  return `List 3-5 key technical concepts, technologies, or topics from this message. Return only a JSON array of short strings (1-3 words each). No explanation.

Message: ${promptText.slice(0, 500)}

JSON array only:`;
}

/** Parse Haiku concept-extraction output into a string array. */
export function parseConceptsOutput(raw: string): string[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];

  let inner = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      const wrapper = JSON.parse(trimmed);
      if (typeof wrapper === 'object' && wrapper !== null && ('result' in wrapper || 'text' in wrapper)) {
        inner = String(wrapper.result ?? wrapper.text ?? trimmed).trim();
      }
    } catch { /* not a wrapper */ }
  }
  if (!inner) return [];

  try {
    const parsed = JSON.parse(stripJsonFences(inner));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .slice(0, MAX_CONCEPTS);
  } catch {
    return [];
  }
}

/** Build the re-ranking prompt sent to Haiku. */
export function buildRerankPrompt(
  query: string,
  candidates: Array<{ id: number; title: string; chunk: string }>,
): string {
  const list = candidates
    .map(c => `[id:${c.id}] ${c.title}: ${c.chunk.slice(0, 120).replace(/\n/g, ' ')}`)
    .join('\n');
  return `Rank these memory excerpts by relevance to the query. Return a JSON array of IDs in descending relevance order. Omit IDs that are not relevant.

Query: ${query.slice(0, 200)}

Candidates:
${list}

JSON array of IDs only (e.g. [3, 1, 5]):`;
}

/**
 * Parse Haiku re-rank output into an ordered list of candidate IDs.
 * Appends any unmentioned IDs at the end (preserves cosine-distance order for remainder).
 * Falls back to original order on any parse error.
 */
export function parseRerankOutput(raw: string, candidateIds: number[]): number[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return candidateIds;

  let inner = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      const wrapper = JSON.parse(trimmed);
      if (typeof wrapper === 'object' && wrapper !== null && ('result' in wrapper || 'text' in wrapper)) {
        inner = String(wrapper.result ?? wrapper.text ?? trimmed).trim();
      }
    } catch { /* not a wrapper */ }
  }

  try {
    const parsed = JSON.parse(stripJsonFences(inner));
    if (!Array.isArray(parsed)) return candidateIds;
    const valid = parsed.filter((x): x is number => typeof x === 'number' && candidateIds.includes(x));
    const seen = new Set(valid);
    return [...valid, ...candidateIds.filter(id => !seen.has(id))];
  } catch {
    return candidateIds;
  }
}

// ─── Phase 4: provisional pruning ────────────────────────────────────────────

export const PRUNE_AGE_DAYS = 14;
export const HARD_DELETE_AGE_DAYS = 60;

export interface PrunableMemory {
  memory_tier: string;
  created_at: number;
  access_count: number;
  confidence: number;
}

/** True if a provisional memory is old enough, unaccessed, and low-confidence to soft-delete. */
export function isPruneable(memory: PrunableMemory, nowUnix: number): boolean {
  if (memory.memory_tier !== 'provisional') return false;
  if (nowUnix - memory.created_at < PRUNE_AGE_DAYS * 86400) return false;
  if (memory.access_count > 0) return false;
  if (memory.confidence >= 0.5) return false;
  return true;
}

export interface HardDeletableMemory {
  is_active: number;
  memory_tier: string;
  created_at: number;
}

/** True if a soft-deleted provisional memory is old enough to hard-delete. */
export function isHardDeletable(memory: HardDeletableMemory, nowUnix: number): boolean {
  if (memory.is_active !== 0) return false;
  if (memory.memory_tier !== 'provisional') return false;
  return nowUnix - memory.created_at >= HARD_DELETE_AGE_DAYS * 86400;
}

// Task 22: decision logic extracted for testability
export type SaveDecision = 'skip' | 'new' | { supersede: number };
export function decideSave(candidates: Array<{ id: number; distance: number }>): SaveDecision {
  if (candidates.length === 0) return 'new';
  const nearest = candidates[0];
  if (nearest.distance < DUPLICATE_THRESHOLD) return 'skip';
  if (nearest.distance < SUPERSESSION_THRESHOLD) return { supersede: nearest.id };
  return 'new';
}

// ─── autoRemember pipeline (pure / shell-only — no transformer deps) ─────────

const CLASSIFY_MODEL = process.env.ENGRAM_MODEL ?? 'claude-haiku-4-5-20251001';

export type ClassifyScope = 'user' | 'project' | 'shared' | 'none';

export interface ClassifyDecision {
  worth_saving: boolean;
  title?: string;
  content?: string;
  excerpt?: string;
  scope?: ClassifyScope;
}

/** Build the prompt sent to the classifier. Pure. */
export function buildClassifyPrompt(responseText: string): string {
  return `Does this response contain a non-obvious technical learning worth saving to long-term memory?

SAVE: non-obvious discoveries, bug root causes, patterns, constraints, gotchas, non-obvious decisions.
SKIP: routine code generation, obvious explanations, status updates, conversational filler.

Also classify scope:
- "user": user preference/habit/workflow ("I prefer X", "I always Y", "my approach is Z")
- "project": fact specific to this codebase or task
- "shared": applies across related projects (cross-project pattern)
- "none": not worth saving

Response:
${responseText.slice(0, 2000)}

JSON only — no other text:
{"worth_saving": true, "title": "under 8 words", "content": "1-3 sentences", "excerpt": "verbatim sentence that triggered this", "scope": "user|project|shared|none"}
or
{"worth_saving": false}`;
}

/**
 * Parse the classifier's stdout into a ClassifyDecision.
 * Handles the CLI's `{type:"result",result:"..."}` wrapper and ```json fences.
 * Returns null if the output is missing, unparseable, or shape-invalid.
 */
export function parseClassifyOutput(raw: string): ClassifyDecision | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  // Unwrap the CLI's JSON wrapper if present
  let inner = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      const wrapper = JSON.parse(trimmed);
      if (typeof wrapper === 'object' && wrapper !== null && ('result' in wrapper || 'text' in wrapper)) {
        inner = String(wrapper.result ?? wrapper.text ?? trimmed).trim();
      }
    } catch { /* not the wrapper — treat raw text as the model's reply */ }
  }
  if (!inner) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonFences(inner)); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as ClassifyDecision;
  if (typeof p.worth_saving !== 'boolean') return null;
  return p;
}

// ─── Consolidation helpers (merge related memories into a denser survivor) ────

/** Extract and slugify `[[wiki links]]` from text. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(/\[\[([^\]]+)\]\]/g)) {
    const slug = m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

export interface ConsolidateMember { title: string; chunk: string; }
export interface ConsolidateMerge { title: string; content: string; }

/** Build the prompt that asks the model to merge a cluster into one dense memory. */
export function buildConsolidatePrompt(members: ConsolidateMember[]): string {
  const list = members
    .map((m, i) => `[${i + 1}] ${m.title}\n${m.chunk.trim()}`)
    .join('\n\n');
  return `Merge these related memories into ONE denser memory. Preserve EVERY actionable fact, decision, gotcha, and [[link]] from all of them — drop only redundancy and filler. Do not invent anything not present in the inputs.

Memories:
${list}

JSON only — no other text:
{"title": "under 8 words", "content": "the merged memory, every distinct fact kept"}`;
}

/** Parse the consolidation model output into {title, content}, or null. */
export function parseConsolidateOutput(raw: string): ConsolidateMerge | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  let inner = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      const wrapper = JSON.parse(trimmed);
      if (typeof wrapper === 'object' && wrapper !== null && ('result' in wrapper || 'text' in wrapper)) {
        inner = String(wrapper.result ?? wrapper.text ?? trimmed).trim();
      }
    } catch { /* not a wrapper */ }
  }

  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonFences(inner)); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Partial<ConsolidateMerge>;
  if (typeof p.title !== 'string' || typeof p.content !== 'string') return null;
  if (!p.title.trim() || !p.content.trim()) return null;
  return { title: p.title.trim(), content: p.content.trim() };
}

/**
 * Shell out to the Claude CLI to classify the response.
 * Returns raw stdout text. Throws if the CLI is unavailable or produced no output.
 *
 * `--setting-sources ""` prevents loading `~/.claude/settings.json` (avoids hook recursion).
 * Uses spawnSync so exit code 1 ("Reached max turns") doesn't throw.
 */
export function runClassifier(prompt: string): string {
  const result = spawnSync(
    'claude',
    ['-p', '-', '--model', CLASSIFY_MODEL, '--no-session-persistence',
     '--max-turns', '1', '--output-format', 'json', '--setting-sources', ''],
    { input: prompt, encoding: 'utf-8', timeout: 30_000 }
  );
  const raw = (result.stdout ?? '').trim();
  if (!raw) throw new Error(result.stderr || 'classifier produced no output');
  return raw;
}