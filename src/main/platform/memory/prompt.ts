/**
 * platform/memory -- Prompt Instructions
 *
 * Generates the system prompt fragment that teaches the AI how to use memory.
 *
 * All callers (automation runs, app chat) use native file tools
 * (Read/Edit/Write) on memory.md directly. Only `memory_status` is
 * available as an MCP tool for structural metadata checks.
 */

/**
 * Generate system prompt instructions for memory usage.
 *
 * @returns Markdown-formatted prompt fragment
 */
export function generatePromptInstructions(): string {
  return MEMORY_INSTRUCTIONS
}

// ============================================================================
// Memory Instructions
// ============================================================================

const MEMORY_INSTRUCTIONS = `
## Memory

You have a persistent \`memory.md\` file that carries state across sessions.
It has two top-level sections: \`# now\` (working memory) and \`# History\` (timeline).
Your \`# now\` block is pre-loaded in the trigger message each run.

### Structure

\`\`\`
# now                          ← working memory (auto-loaded)
## State | one-line summary    ← always first, updated every run
## [Entity Name]               ← per-entity tracking (optional)
## Patterns                    ← learned rules (accumulates)
## Errors                      ← failure lessons (compact)

# History                      ← timeline (newest first)
## YYYY-MM-DD-HHmm | summary  ← one entry per run
### details heading            ← optional, for important events
\`\`\`

**\`# now\`** holds your current state. Use \`- key: value\` format, one field per line.
Each field is one fact. Each line is independently editable.

- **\`## State | description\`** — Counters, current status, last result.
  The \`| description\` is your one-line summary of the current situation.
- **\`## [Entity Name]\`** — Per-entity tracking when monitoring multiple items.
- **\`## Patterns\`** — Learned rules that improve future performance.
- **\`## Errors\`** — What went wrong and the fix that worked.

**\`# History\`** is your timeline. The system pre-inserts a \`## YYYY-MM-DD-HHmm\` heading
at the top before each run. You Edit in the summary after \`|\` and optionally add details.

- **Important events**: add a \`###\` sub-heading with details below the \`##\` timestamp
- **Routine events**: just fill in the summary — one line is enough

### Example: Mature Memory

\`\`\`markdown
# now

## State | 3 items tracked, AirPods ¥1199 stable, MacBook ¥7999↑
- items_tracked: 3
- runs_completed: 84
- alerts_sent: 5

## AirPods Pro (JD.com)
- current_price: ¥1199
- lowest_seen: ¥1099 (2026-01-08)
- last_change: 2026-01-10, ¥1299→¥1199
- trend: stable (5 days)

## MacBook Air M3 (Taobao)
- current_price: ¥7999
- lowest_seen: ¥7499 (2026-01-12)
- last_change: 2026-01-13, ¥7499→¥7999
- trend: rising

## Patterns
- prices are lowest on weekday mornings, highest on weekends
- price drops >10% are usually flash sales, revert within 48h
- user prefers notification only when price drops below previous lowest
- JD product data is in JSON-LD script tag on detail pages

## Errors
- JD anti-bot: switch to mobile User-Agent header
- Taobao layout changed 2026-01-11: use selector .price-current

# History

## 2026-01-15-1430 | routine check, no change

## 2026-01-15-1400 | MacBook ¥7999↑, alerted user
### Price alert
- MacBook Air: ¥7499→¥7999
- exceeded previous highest, sent notification

## 2026-01-15-1330 | routine check, no change
\`\`\`

### When to Update

Update memory **after completing your task, before reporting**. This is required.

Workflow: trigger → do work → compare results with memory → update memory → report.

**\`# now\` updates:**
- **Every run**: update State fields that changed, update the \`| description\`
- **When you learn something new**: add a line to Patterns or Errors
- **When tracking a new entity**: create a new \`##\` section under \`# now\`
- **When a field is obsolete**: remove it with Edit

**\`# History\` updates:**
- The system already inserted a \`## YYYY-MM-DD-HHmm\` heading for this run
- Edit that heading to add your summary: \`## 2026-01-15-1430 | your summary here\`
- For important events, add \`###\` details below the heading
- For routine runs with no changes, a brief summary is sufficient

**Record what helps future runs.** Important discoveries, pattern changes,
and error resolutions deserve detailed recording. Routine unchanged checks
can be a single line.

### How to Update

Use **Edit** for all routine updates:

\`\`\`
Edit(memory.md, "- current_price: ¥1199", "- current_price: ¥1099")
\`\`\`

Update the State description:

\`\`\`
Edit(memory.md,
  "## State | old description",
  "## State | new description")
\`\`\`

Add summary to the pre-inserted History heading:

\`\`\`
Edit(memory.md,
  "## 2026-01-15-1430",
  "## 2026-01-15-1430 | MacBook ¥7999↑, alerted user")
\`\`\`

Use **Write** only for first-time creation or full restructuring.
Use **Read** to load sections not in context.

### Archive Files

Your memory directory has two types of archive files:

- **\`memory/run/\`** — Per-run execution records (one file per run, named \`YYYY-MM-DD-HHmm-run.md\`).
  Each file contains the full details of what happened in that run.
  Use these to recall past events: \`Read("memory/run/2026-01-15-1400-run.md")\`
  The timestamp matches the \`# History\` heading in memory.md.

- **\`memory/\`** (root) — Compaction archives (old versions of memory.md).
  When memory.md grows too large, the system archives it and creates a fresh compact version.
  These are historical snapshots of your working memory at past points in time.

### Growth and Consolidation

**\`# now\`** sections stay compact. Consolidate when a section exceeds ~20 lines:
- Merge related Patterns into general rules
- Remove Patterns that turned out to be wrong
- Remove obsolete Entity sections or fields

**\`# History\`** grows naturally — the system handles compaction when memory.md
exceeds its size threshold. Old History entries are archived automatically.
You do not need to manage History size.
`.trim()
