# Engram

Engram is a portable semantic memory layer for Claude Code. Every session leaves a trace. Every trace makes the next session smarter.

---

## The Problem

Every Claude Code session starts from zero. You re-explain context. You rediscover patterns. You make decisions you already made three weeks ago because there's no record of them.

Claude Code has CLAUDE.md for rules and skills for workflows — but neither is a *learning* system. They hold what you put in manually. They don't accumulate knowledge from work you've already done.

Engram fills that gap.

---

## How It Works

```
Session opens
  → on-session-start.ts loads pinned memories → injected into the system prompt

You type a prompt
  → on-prompt.ts searches memory → relevant context prepended to your message
  → Claude responds
  → on-stop.ts checks response for learnings → saves automatically
```

Fully automatic in every direction. You just work.

- **Markdown** is the source of truth — human-readable, git-tracked, portable forever
- **node:sqlite** is the storage layer — built into Node 24 LTS, a single `.db` file, no server process, no native compilation
- **all-MiniLM-L6-v2** generates embeddings locally via ONNX — works fully offline after first download
- **Pure JS cosine similarity** replaces sqlite-vec KNN — fast enough at Engram scale, zero native deps

---

## How Claude Uses It

This is the part that surprises people: **Claude never retrieves memory. It never decides to "look something up."** Engram's hooks inject memory as plain text *before* Claude sees the turn — from Claude's perspective it's indistinguishable from anything else already in the prompt.

There are exactly two moments where memory reaches Claude:

**1. Session start — pinned memories.** When a session opens, `on-session-start.ts` writes the pinned set into the **system prompt**. It's in context for the whole session, before you type anything. No search, no threshold — pinned memories always load (for the matching scope).

**2. Every prompt — everything else.** When you submit a prompt, `on-prompt.ts` runs a semantic search *before* Claude reads your message, and prepends the matches as a block:

```
## Relevant context from Engram memory
**JWT refresh token rotation** *(auth)*
Always rotate the refresh token on every use...
---
```

That block arrives attached to your message. By the time Claude generates a response, it's already there.

What this means in practice:

- **It's passive injection, not active retrieval.** The hook does the search; Claude doesn't call a tool or query the DB.
- **Relevance is decided by the hook, not by Claude.** The `distance < 0.75` threshold and the top-5 cap (`on-prompt.ts`) determine what's offered. Claude only ever sees what survived that filter.
- **Claude has no awareness of the rest of the DB.** If a relevant memory scores `distance >= 0.75` on a given prompt, Claude never sees it and has no idea it exists. The pinned set is the only memory guaranteed to be present every turn.
- **Injected ≠ obeyed.** A memory in context is *weighed* during generation if relevant, ignored if not — exactly like any other sentence in the prompt. Memories surfaced this way are background context, not instructions, and reflect what was true when written (verify a path/flag still exists before acting on it).

In short: Engram is **retrieval-augmented continuity** — it stacks the deck of what's in context — not a memory Claude can introspect or search on demand.

### Memories aren't added to sessions — sessions pull them

A common misconception: that saving a memory "attaches" it to relevant sessions. It doesn't. A memory is saved **once**, as a single row, tagged with *where it's allowed to surface*. Future sessions then pull whatever matches — nothing is ever pushed into a session.

**At save time**, Engram records the memory's *reach*, not its destination:

| Field | Determines |
|---|---|
| `memory_tier` | how broad the reach is (user/long = everywhere, shared = repo group, short/provisional = one project) |
| `project_scope` | which project (the git remote of the repo you were in) |
| `scope_group` | which family of repos (shared tier only) |
| `embedding` | semantic relevance |
| `session_id` | provenance only — **not** used to route retrieval |

**At read time**, each session decides what's relevant *to it* via two filters, both required:

1. **Scope match** — does this session's project/group qualify to see this tier?
2. **Semantic match** — is `distance < 0.75` for *this* prompt?

A `short` memory saved in `repo-A` is invisible in a session opened in `repo-B` — wrong scope, no matter how semantically relevant. A global `long` memory still won't appear unless the current prompt is close enough. `session_id` is stored as a breadcrumb of origin only; it plays no role in which future sessions surface the memory.

So: **save = tag the memory with its reach; read = each session pulls what matches its scope and its current prompt.**

---

## Tiered Memory

Engram uses six memory tiers:

| Tier | Scope | Lifespan | When used |
|---|---|---|---|
| **pinned** | Per-project or global | Permanent | Critical context injected at every SessionStart |
| **user** | Global (all projects) | Permanent | User preferences, workflow habits, personal style |
| **shared** | Scope group (related repos) | Permanent | Shared patterns across a set of repos (e.g. all payroll repos) |
| **long** | Global (cross-project) | Permanent | Principles, architectural decisions, hard-won lessons |
| **short** | Per-project (git remote) | Decays over time | Project-specific patterns, in-flight context, local gotchas |
| **provisional** | Per-project | 14 days (if unaccessed) | Auto-saved learnings that need to earn promotion |

Every new auto-saved memory starts as **provisional**. After enough accesses (`ENGRAM_PROMOTE_THRESHOLD`, default 10), it is promoted to **short**. Short-term memories decay in confidence over time; those never accessed again fade out automatically.

```
Response saved → provisional (scoped to project)
  → accessed repeatedly → promoted to short
  → accessed threshold reached → promoted to long (global)

Provisionals never accessed → pruned after 14 days (npm run prune)
```

Pinned memories are the "always-on" tier. They inject at SessionStart via `hooks/on-session-start.ts`, before the first prompt — ideal for stable facts the model should never forget. Unlike every other tier, **pinning is always manual** (`npm run pin -- --id N` or the `pin_memory` MCP tool) — nothing is auto-pinned, because every pin is permanent context cost on every session.

---

## Setup

```bash
git clone https://github.com/gfunkmaster/Engram ~/.engram
cd ~/.engram && npm install
```

On a new machine after cloning:

```bash
npm run reindex   # rebuilds the vector index from your markdown files
```

---

## Usage

### Save a learning

```bash
# From a file
npm run remember -- --topic "auth" --title "JWT refresh token rotation" --tags "auth,jwt" --file output.md

# From stdin
echo "Always validate the refresh token family to prevent reuse attacks" | \
  npm run remember -- --topic "auth" --title "Token family validation"
```

### Search past memory

```bash
npm run search -- "how did we handle JWT auth"
npm run search -- "websocket reconnection strategy" --top 3
```

### Debug retrieval — see exactly what would be injected and why

```bash
npm run why -- "JWT refresh flow"
```

Output shows distance scores, tier badges, project scope, and whether each memory would be injected, filtered, or was superseded.

### Promote short-term memories to long-term

```bash
npm run promote            # dry-run: shows what's eligible (default threshold: 3 accesses)
npm run promote -- --apply # commit the promotions
npm run promote -- --min 5 # custom access threshold
```

### Apply confidence decay to short-term memories

```bash
npm run decay              # dry-run: shows confidence bars and what would be deactivated
npm run decay -- --apply   # commit the decay
npm run decay -- --cutoff 0.05  # custom deactivation cutoff
npm run decay -- --apply --rate 0.005  # override per-memory decay_rate globally
```

**Run frequency and calibration:**

- **Daily cron (recommended):** `0 0 * * * cd /path/to/Engram && npm run decay -- --apply`
- The default `decay_rate = 0.02` is calibrated for daily runs — a memory at 1.0 confidence reaches the 0.10 deactivation cutoff in ~115 days without being accessed.
- **If running weekly:** use a lower rate — pass `--rate 0.005` or manually set `decay_rate` to `0.005` in a memory's frontmatter. At weekly intervals, `0.005` gives a similar 115-day window.
- **Recommended order:** promote first, then decay: `npm run promote -- --apply && npm run decay -- --apply`

### Rebuild the full index

```bash
npm run reindex
```

---

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `reindex.ts` | `npm run reindex` | Rebuild vector index from all markdown files (upsert — unchanged files are skipped) |
| `search.ts` | `npm run search -- "<query>"` | Semantic search over memory |
| `remember.ts` | `npm run remember -- --topic ... --title ...` | Write and immediately index a new memory |
| `why.ts` | `npm run why -- "<query>"` | Debug retrieval pipeline — shows distances, tiers, and filter reasons |
| `explain.ts` | `npm run explain -- "<prompt>"` | Dry-run recall for a prompt: shows concepts extracted, queries run, and which memories would inject |
| `stats.ts` | `npm run stats` | Memory counts by all tiers, top accessed memories, prune and promote candidates |
| `promote.ts` | `npm run promote` | Promote eligible short-term memories to long-term |
| `prune.ts` | `npm run prune` | Promote provisionals at threshold; soft-delete stale ones; hard-delete old inactive rows |
| `decay.ts` | `npm run decay` | Apply confidence decay to short-term memories |
| `pin.ts` | `npm run pin -- --id N` | Pin or unpin a memory; list pins for current project |
| `migrate.ts` | `npm run migrate` | Apply incremental schema migrations to the DB |
| `purge.ts` | `npm run purge -- --id N` | Purge a memory by ID or semantic query |
| `status.ts` | `npm run status` | Show system status (counts, DB size, daemon, env vars) |

---

## File Structure

```
~/.engram/
├── package.json
├── tsconfig.json
├── lib/
│   ├── memory.ts         ← shared primitives (search, save, embed, chunk, multiSearch)
│   ├── migrate.ts        ← schema migration logic
│   ├── utils.ts          ← pure functions (concepts, rerank, prune, classify)
│   └── pin.ts            ← pin/unpin/listPinned DB operations
├── daemon/
│   ├── server.ts         ← HTTP daemon (keeps model warm, port 7700)
│   └── client.ts         ← daemon client with direct fallback
├── mcp/
│   ├── server.ts         ← MCP server (save_memory, pin_memory, explain_recall, …)
│   └── handlers.ts       ← transport-free handler logic (testable)
├── scripts/
│   ├── reindex.ts
│   ├── search.ts
│   ├── remember.ts
│   ├── why.ts
│   ├── explain.ts        ← dry-run recall: concepts, queries, would_inject
│   ├── stats.ts          ← tier counts, top accessed, prune/promote candidates
│   ├── promote.ts
│   ├── prune.ts          ← promote provisionals + soft/hard-delete stale ones
│   ├── pin.ts            ← pin/unpin CLI
│   ├── decay.ts
│   ├── migrate.ts
│   ├── purge.ts
│   └── status.ts
├── hooks/
│   ├── on-session-start.ts  ← SessionStart: inject pinned memories
│   ├── on-prompt.ts         ← UserPromptSubmit: multi-query search + inject
│   └── on-stop.ts           ← Stop: auto-remember + save as provisional
├── tests/
│   ├── memory.test.ts    ← vitest unit tests (pure functions)
│   └── integration.test.ts  ← DB integration tests
└── memory/
    ├── raw/              ← markdown files (git-tracked, source of truth)
    └── memory.db         ← vector index (gitignored, regeneratable)
```

Memory is organized by topic:

```
memory/raw/
├── auth/
├── patterns/
├── decisions/
└── learnings/
```

Each file carries frontmatter that records tier, project scope, session provenance, and confidence:

```markdown
---
title: JWT refresh token rotation
topic: auth
tier: short
project_scope: https://github.com/org/api-service
tags: auth,jwt
date: 2026-05-05
session_id: abc123
---

Always rotate the refresh token on every use. Reusing the same token is a
vector for token theft — if the original is stolen, the legitimate user's
next refresh will fail and alert you.
```

---

## Daemon (Recommended)

### The problem

Every time a hook fires, Node.js loads and the embedding model (a ~90 MB ONNX file) is initialised from disk. This cold-start takes 2–5 seconds on most machines — noticeable latency on every prompt.

### The solution

Run the daemon once. It loads the model into memory and keeps it warm, serving search requests over a local HTTP socket. The cold-start disappears. Subsequent searches are near-instant.

### Start the daemon

```bash
npm run daemon
```

### Verify it's running

```bash
curl http://localhost:7700/health
# → {"status":"ok","pid":12345}
```

The daemon exits automatically after 120 minutes of inactivity (override via `ENGRAM_IDLE_MINUTES`; set to `0` to disable).

### Fallback

If the daemon is not running, the hooks fall back to direct execution automatically — slower (cold-start on every prompt) but still fully functional. No configuration required.

### macOS launchd (auto-start on login)

Save as `~/Library/LaunchAgents/com.engram.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.engram.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npx</string>
    <string>tsx</string>
    <string>/path/to/Engram/daemon/server.ts</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardErrorPath</key>
  <string>/tmp/engram-daemon.log</string>
</dict>
</plist>
```

Load it: `launchctl load ~/Library/LaunchAgents/com.engram.daemon.plist`

### Linux systemd (auto-start on login)

Save as `~/.config/systemd/user/engram-daemon.service`:

```ini
[Unit]
Description=Engram memory daemon
After=network.target

[Service]
ExecStart=/usr/local/bin/npx tsx /path/to/Engram/daemon/server.ts
Restart=on-failure
StandardError=journal

[Install]
WantedBy=default.target
```

Enable: `systemctl --user enable --now engram-daemon`

### Windows Task Scheduler (auto-start on login)

Run this once in an elevated PowerShell prompt:

```powershell
$action  = New-ScheduledTaskAction `
  -Execute "node" `
  -Argument "node_modules\.bin\tsx daemon\server.ts" `
  -WorkingDirectory "$HOME\.engram"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "EngramDaemon" -Action $action -Trigger $trigger -RunLevel Highest
```

Or manually via the GUI: Task Scheduler → Create Basic Task → Trigger: At log on → Action: Start a program → Program: `node` → Arguments: `node_modules\.bin\tsx daemon\server.ts` → Start in: `C:\Users\<user>\.engram`

---

## Security & Privacy

- **Auto-remember API calls**: When auto-remember fires, the last Claude response (up to 2,000 characters) is sent to the Anthropic Haiku API to determine if it is worth saving. No other data is sent.
- **Disable all API calls**: Set `ENGRAM_DISABLE_HAIKU=1` to disable auto-remember entirely. Engram will only save memories you explicitly write with `npm run remember`. No data leaves your machine.
- **Embeddings are local**: The embedding model (all-MiniLM-L6-v2) runs locally via ONNX. No data leaves your machine for search.
- **Storage is local**: The DB (`memory/memory.db`) and markdown files (`memory/raw/`) are local only. They are never uploaded anywhere by Engram.

---

## Environment Variables

All tuneable behaviour can be overridden without editing source.

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(required)* | API key for Haiku auto-remember calls. Set by Claude Code automatically. |
| `ENGRAM_MODEL` | `claude-haiku-4-5-20251001` | Override the model used for auto-remember judgment. Any Anthropic model ID accepted. |
| `ENGRAM_DISABLE_HAIKU` | `0` | Set to `1` to disable all Haiku API calls. Auto-remember is silenced; manual `npm run remember` still works. |
| `ENGRAM_PROMOTE_THRESHOLD` | `10` | Number of accesses before a short-term memory is eligible for promotion to long-term. Lower = more aggressive promotion. |
| `ENGRAM_DECAY_RATE` | *(per-memory, default `0.02`)* | Global decay rate override applied to all short-term memories during `npm run decay`. Calibrated for daily runs. Use `0.005` for weekly. |
| `ENGRAM_PORT` | `7700` | Port the daemon listens on. Must match between server and client. |
| `ENGRAM_IDLE_MINUTES` | `120` | Minutes of inactivity before the daemon exits. Set to `0` to disable. |
| `ENGRAM_DISABLE_CONCEPTS` | `0` | Set to `1` to skip concept extraction in `on-prompt.ts` and use single-query search only. |
| `ENGRAM_USE_HAIKU_CONCEPTS` | `0` | Set to `1` to use Haiku for concept extraction instead of the heuristic extractor (~1s added per prompt). |
| `ENGRAM_ENABLE_RERANK` | `0` | Set to `1` to re-rank top candidates via Haiku before injecting (~1-2s added per prompt). |
| `ENGRAM_MAX_CONCEPTS` | `5` | Maximum number of concepts extracted per prompt in multi-query mode. |

---

## Automatic Mode — Claude Code Hooks

Three hooks make Engram fully automatic. Add all three to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx tsx /path/to/Engram/hooks/on-session-start.ts"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx tsx /path/to/Engram/hooks/on-prompt.ts"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx tsx /path/to/Engram/hooks/on-stop.ts"
          }
        ]
      }
    ]
  }
}
```

### `hooks/on-session-start.ts` — pinned-memory injection (at session start)

1. Resolves the project scope from the session's cwd
2. Loads pinned memories for that scope (plus global pins, NULL scope)
3. Caps to `ENGRAM_PIN_LIMIT` (default 10) and ~20k chars
4. Injects as a system prompt block so Claude sees pinned context from the first turn

Pinned memories are the closest thing Engram has to "always-on" memory — use them for stable facts the model should never forget (preferences, key architecture decisions, recurring gotchas).

### `hooks/on-prompt.ts` — auto-search (on every prompt)

1. Extracts concepts from your prompt (backtick spans, PascalCase, camelCase, ALL_CAPS identifiers)
2. Runs multi-query search: raw prompt + each concept → union results, keep lowest distance per memory
3. Optionally re-ranks top candidates via Haiku (`ENGRAM_ENABLE_RERANK=1`)
4. Injects matching memories (distance < 0.75) as silent context before Claude sees your message
5. Exits in milliseconds if nothing relevant found — never blocks Claude

### `hooks/on-stop.ts` — auto-remember (after every response)

1. Reads Claude's last response from the session transcript
2. Runs a fast signal-phrase check (`"turns out"`, `"root cause"`, `"gotcha"`, etc.)
3. If no signals → exits immediately, zero cost
4. If signals found → sends response to Claude Haiku: *"is this worth saving?"*
5. If yes → checks for duplicates → embeds → saves to `memory/raw/` → indexes as short-term, scoped to the current project

**All three hooks fail silently.** Nothing ever blocks Claude or surfaces errors to you.

### Pinning memories

```bash
npm run pin -- --id 42               # pin memory #42 with auto-assigned order
npm run pin -- --id 42 --order 1     # pin with explicit order (lower = first)
npm run pin -- --unpin --id 42       # unpin
npm run pin -- --list                # list pins for current project
npm run pin -- --list --all          # list pins across all scopes
```

Also exposed via MCP tools `pin_memory`, `unpin_memory`, `list_pinned` so Claude can pin a memory when you say "pin this".

### Why Haiku for the judgment call

Haiku is fast (~1-2s) and costs ~$0.0001 per call. Most responses get filtered by the signal-phrase check and never reach Haiku. For the ones that do, Haiku has the judgment to distinguish a genuine learning from routine output — something no regex can do reliably.

---

## Cross-Project Scope Groups

Memories saved as `shared` tier surface in any project that belongs to the same scope group. Use this for patterns shared across a family of related repos (e.g. all repos in a monorepo ecosystem, or a backend + frontend + infra set).

Scope groups are configured in `engram.config.json` at the root of the Engram directory. This file is gitignored — create it locally on each machine.

```json
{
  "scope_groups": {
    "my-product": [
      "https://github.com/org/backend.git",
      "https://github.com/org/frontend.git",
      "https://github.com/org/infrastructure.git"
    ]
  }
}
```

The key (`"my-product"`) is the group name. Each value is a git remote URL — the same string returned by `git remote get-url origin` in that repo.

When you work in any of those repos and Engram runs a search, `shared`-tier memories whose `scope_group` matches the current repo's group are included in results. To save a memory as shared:

```bash
npm run remember -- --topic "auth" --title "JWT rotation pattern" --tier shared --file output.md
```

Or via MCP: `save_memory` with `tier: "shared"`.

---

## Supersession

When a new memory is semantically close to an existing one (cosine distance < 0.35), Engram supersedes the old memory rather than creating a duplicate. The old entry is marked inactive and linked to the new one. The `why` CLI shows superseded memories in red so you can see the full lineage.

Three distance thresholds govern this:

| Threshold | Distance | Action |
|---|---|---|
| Duplicate | < 0.15 | Skip silently — near-identical already exists |
| Supersede | < 0.35 | Mark old inactive, save updated version |
| Inject | < 0.75 | Include in context injection |

---

## Integration with Claude Code Skills

Skills call Engram at two points in every pipeline:

**At the start (research/analyze skills):**
```bash
npx tsx ~/.engram/scripts/search.ts "$ARGUMENTS" --top 5
```

**At the end (review/deliver skills):**
```bash
npx tsx ~/.engram/scripts/remember.ts \
  --topic "{domain}" \
  --title "{what was learned}" \
  --file ~/.claude/context/output/final.md
```

Over time, Claude arrives at each session pre-loaded with everything it has learned from every previous session in that domain.

---

## Dependencies

```json
{
  "@huggingface/transformers": "^3.0.0",
  "tsx": "^4.7.0"
}
```

Pure TypeScript. No Python. No native modules. SQLite is built into Node 24 via `node:sqlite` — no `better-sqlite3` or `sqlite-vec` prebuilds needed. The `@anthropic-ai/sdk` is only used by `on-stop.ts` for the Haiku judgment call — your existing `ANTHROPIC_API_KEY` from Claude Code covers it.

---

## New Machine Setup

Requires **Node 24+** (latest LTS — `node:sqlite` is stable, no flags needed).

```bash
git clone https://github.com/gfunkmaster/Engram ~/.engram
cd ~/.engram && npm install
npm run reindex
```

No native compilation required — `node:sqlite` is built into Node 24. No prebuilt binaries to download.

The markdown files travel with you via git. The vector index is regenerated on each machine in seconds.

---

## Why "Engram"

In neuroscience, an engram is the physical trace a memory leaves in the brain — the stored residue of a learned experience. That's exactly what this system writes after every session.
