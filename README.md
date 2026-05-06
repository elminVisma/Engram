# Engram

**Claude forgets everything. Engram doesn't.**

Engram is a portable semantic memory layer for Claude Code. Every session leaves a trace. Every trace makes the next session smarter.

---

## The Problem

Every Claude Code session starts from zero. You re-explain context. You rediscover patterns. You make decisions you already made three weeks ago because there's no record of them.

Claude Code has CLAUDE.md for rules and skills for workflows — but neither is a *learning* system. They hold what you put in manually. They don't accumulate knowledge from work you've already done.

Engram fills that gap.

---

## How It Works

```
You type a prompt
  → on-prompt.ts searches memory → relevant context injected silently
  → Claude responds
  → on-stop.ts checks response for learnings → saves automatically
```

Fully automatic in both directions. You just work.

- **Markdown** is the source of truth — human-readable, git-tracked, portable forever
- **node:sqlite** is the storage layer — built into Node 24 LTS, a single `.db` file, no server process, no native compilation
- **all-MiniLM-L6-v2** generates embeddings locally via ONNX — works fully offline after first download
- **Pure JS cosine similarity** replaces sqlite-vec KNN — fast enough at Engram scale, zero native deps

---

## Tiered Memory

Engram keeps two classes of memory:

| Tier | Scope | Lifespan | When used |
|---|---|---|---|
| **Short-term** | Per-project (git remote) | Decays over time | Project-specific patterns, in-flight context, local gotchas |
| **Long-term** | Global (cross-project) | Permanent | Principles, architectural patterns, hard-won lessons |

Every new auto-saved memory starts as **short-term**, tagged to the project it came from. When a memory is accessed repeatedly (default: 3 times), it is promoted to **long-term** and becomes globally available across all projects.

Short-term memories decay in confidence over time. Ones that are never accessed again fade out automatically — keeping memory lean and relevant.

```
Session ends
  → memory saved as short-term, scoped to this project's git remote
  → accessed again in a later session → access_count increments
  → access_count reaches threshold → npm run promote --apply
  → memory becomes long-term, project scope cleared
```

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
| `promote.ts` | `npm run promote` | Promote eligible short-term memories to long-term |
| `decay.ts` | `npm run decay` | Apply confidence decay to short-term memories |
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
│   ├── memory.ts         ← shared primitives (search, save, embed, chunk)
│   └── migrate.ts        ← schema migration logic
├── daemon/
│   ├── server.ts         ← HTTP daemon (keeps model warm, port 7700)
│   └── client.ts         ← daemon client with direct fallback
├── scripts/
│   ├── reindex.ts
│   ├── search.ts
│   ├── remember.ts
│   ├── why.ts
│   ├── promote.ts
│   ├── decay.ts
│   ├── migrate.ts
│   ├── purge.ts
│   └── status.ts
├── hooks/
│   ├── on-prompt.ts      ← UserPromptSubmit: auto-search + inject
│   └── on-stop.ts        ← Stop: auto-remember + save
├── tests/
│   └── memory.test.ts    ← vitest unit tests
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

The daemon exits automatically after 30 minutes of inactivity.

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

---

## Automatic Mode — Claude Code Hooks

Two hooks make Engram fully automatic. Add both to `~/.claude/settings.json`:

```json
{
  "hooks": {
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

### `hooks/on-prompt.ts` — auto-search (on every prompt)

1. Embeds your prompt locally
2. Searches memory — long-term globally, short-term filtered to the current project
3. Injects matches as silent context before Claude sees your message
4. Exits in milliseconds if nothing relevant found

### `hooks/on-stop.ts` — auto-remember (after every response)

1. Reads Claude's last response from the session transcript
2. Runs a fast signal-phrase check (`"turns out"`, `"root cause"`, `"gotcha"`, etc.)
3. If no signals → exits immediately, zero cost
4. If signals found → sends response to Claude Haiku: *"is this worth saving?"*
5. If yes → checks for duplicates → embeds → saves to `memory/raw/` → indexes as short-term, scoped to the current project

**Both hooks fail silently.** Nothing ever blocks Claude or surfaces errors to you.

### Why Haiku for the judgment call

Haiku is fast (~1-2s) and costs ~$0.0001 per call. Most responses get filtered by the signal-phrase check and never reach Haiku. For the ones that do, Haiku has the judgment to distinguish a genuine learning from routine output — something no regex can do reliably.

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
