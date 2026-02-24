# platform/memory -- Design Document

> Date: 2026-02-23
> Status: V3 Implementation

---

## 1. Architecture Overview

The memory module provides persistent, cross-session memory for AI agents in Halo.

**V3 core changes from V2:**

- AI uses native Claude Code tools (Read/Edit/Write) instead of custom MCP tools
- `memory.md` is pre-injected into the trigger message (push-based, not pull-based)
- Only one MCP tool remains: `memory_status` for structural metadata checks
- `memory.md` uses a two-tier structure: `# now` (working memory) + `# History` (timeline)
- Session summaries move to `memory/run/` subfolder
- System pre-inserts timestamp headings in `# History` before each run

---

## 2. memory.md Structure

### 2.1 Two-tier layout: `# now` + `# History`

```markdown
# now

## State | brief one-line summary of current state
- runs_completed: 84
- alerts_sent: 5
- last_result: AirPods ¥1199, no change

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

## Errors
- JD anti-bot: switch to mobile User-Agent header
- Taobao layout changed 2026-01-11: use selector .price-current

# History

## 2026-01-15-1430 | routine check, no change

## 2026-01-15-1400 | MacBook ¥7999↑, alerted user
### Details
- MacBook Air: ¥7499→¥7999
- exceeded previous highest, sent notification

## 2026-01-15-1330 | routine check, no change
...
```

### 2.2 `# now` — Working Memory

The AI's current state. Organized into `##` sections by purpose:

| Section | Purpose | Growth |
|---------|---------|--------|
| `## State \| description` | Counters, current status, last result | Values change, field set stable |
| `## [Entity Name]` | Per-entity tracking (e.g., per product) | Add/remove sections as needed |
| `## Patterns` | Learned rules that improve performance | Accumulates, periodically consolidated |
| `## Errors` | Lessons from past failures | One-liner per resolved issue |

**`## State` must always be first** — it is auto-loaded via snapshot injection.

The `| description` after `## State` is a one-line summary written by the AI.
It appears in the snapshot heading list, giving instant context.

### 2.3 `# History` — Timeline

Chronological log of significant events, newest at the top.

Each entry is a `##` heading with format: `## YYYY-MM-DD-HHmm | summary`

- **Important events** get a `### sub-heading` + detailed content
- **Routine events** are a single heading line

The timestamp in `# History` corresponds directly to run files in `memory/run/`:
- `## 2026-01-15-1400` → `memory/run/2026-01-15-1400-run.md`

**System pre-inserts** the `## YYYY-MM-DD-HHmm` heading at the top of `# History`
before each run. The AI only needs to Edit in the summary (after `|`) and
optionally add detail lines below.

### 2.4 Time format

Unified across the system: **`YYYY-MM-DD-HHmm`** (local time, no colons).

Used in:
- `# History` headings in `memory.md`
- Run file names in `memory/run/`
- Compaction archive file names in `memory/`

---

## 3. Snapshot Injection

### 3.1 Trigger-time injection

Before each run, `buildMemorySnapshot()` reads `memory.md` and the system
injects it into the initial user message. This replaces the V2 pattern where
the AI had to call `memory_read` as its first action.

### 3.2 Three injection variants

| Condition | Injected Content |
|-----------|-----------------|
| No file exists | Path + guidance to create with Write |
| Small file (≤30 lines) | Full content |
| Large file (>30 lines) | `# now` block (full) + `# History` headings (structure only) |

**Key**: `firstSection` in `snapshot.ts` extracts from the first `#`-level heading
to the next `#`-level heading. With `# now` / `# History`, this naturally captures
the entire `# now` block.

The `# History` headings appear in the `### Structure` outline, so the AI can see
the recent timeline without loading full content.

### 3.3 What the AI sees (large file)

```
## Memory

**File**: `/path/to/memory.md`
**Size**: 150 lines, 8.5KB

### Current State (auto-loaded):

# now
## State | AirPods ¥1199 stable, MacBook ¥7999↑
- runs_completed: 84
- alerts_sent: 5
...
## Patterns
- prices lowest on weekday mornings
...

### Structure:
  L1: # now (28 lines) ← loaded above
  L29: # History (120 lines)
    L30: ## 2026-01-15-1430 | routine check (1 lines)
    L31: ## 2026-01-15-1400 | MacBook ¥7999↑ (5 lines)
    ...

**Archive** (`memory/run/`, 42 files):
  - 2026-01-15-1430-run.md
  - 2026-01-15-1400-run.md
  ...
```

---

## 4. Memory File Structure on Disk

```
{spacePath}/apps/{appId}/
  memory.md              -- Active memory (# now + # History)
  memory/
    run/                 -- Per-run session summaries (auto-generated)
      2026-01-15-1430-run.md
      2026-01-15-1400-run.md
      ...
    2026-01-10-0000.md   -- Compaction archives (old memory.md backups)
    ...
```

- **`memory/run/`**: One file per execution, named `YYYY-MM-DD-HHmm-run.md`.
  Contains: trigger type, outcome, duration, tokens, AI output summary.
  AI can read these to recall detailed history of a specific run.

- **`memory/`** (root): Compaction archives. When `memory.md` exceeds 100KB,
  it is renamed to `memory/YYYY-MM-DD-HHmm.md` and a new compact `memory.md`
  is generated by LLM.

---

## 5. AI Read/Write Pattern (V3)

### 5.1 Tools

AI uses **native Claude Code tools** for all memory operations:

| Tool | Memory Use |
|------|-----------|
| Read | Load specific sections of `memory.md`, or files in `memory/run/` |
| Edit | Update individual fields in `# now`, add summary to `# History` |
| Write | First-time creation, or full restructure after consolidation |

One MCP tool remains:
- **`memory_status`** — Returns structural metadata (path, size, headings, archive info).
  No content. Useful for re-checking structure after multiple edits.

### 5.2 Per-run lifecycle

```
Pre-run (system)
  │
  ├─ buildMemorySnapshot()                    ← Read memory.md + archive listing
  ├─ Pre-insert ## YYYY-MM-DD-HHmm           ← Add timestamp heading to # History
  └─ Inject into trigger message              ← AI sees # now + structure on start
  │
AI Run
  │
  ├─ (# now is already in context)            ← No tool call needed
  ├─ Execute task...
  ├─ Edit # now: update State fields          ← Precise field-level updates
  ├─ Edit # History: add summary to heading   ← "## 2026-01-15-1430 | result summary"
  │   └─ Optionally add ### details below
  └─ report_to_user                           ← Send results to user
  │
Post-run (system)
  │
  ├─ saveRunSessionSummary()                  ← Write to memory/run/YYYY-MM-DD-HHmm-run.md
  └─ needsCompaction() check
       ├─ Under 100KB → skip
       └─ Over 100KB → compact()
            ├─ Archive to memory/YYYY-MM-DD-HHmm.md
            ├─ LLM generates compact # now (preserves structure)
            └─ LLM preserves recent # History entries, drops old ones
```

### 5.3 Compaction behavior with new structure

The compaction LLM prompt instructs:
- Preserve `# now` structure (State, Entity, Patterns, Errors sections)
- Distill `# now` fields to current essential values
- Keep only the last ~10 `# History` entries
- Drop older History entries (they exist in `memory/run/` anyway)

---

## 6. Key Design Decisions

### 6.1 Native tools over custom MCP tools (V3)

**Decision**: AI uses Read/Edit/Write instead of `memory_read`/`memory_write`.

**Rationale**: The automation agent has the same toolset as the interactive agent.
Edit enables precise field-level updates (change one value without rewriting
the file), which is impossible with `memory_write(mode="replace")`.
This reduces tokens, improves accuracy, and eliminates a class of bugs where
the AI rewrites stale content.

### 6.2 Push-based injection over pull-based reads (V3)

**Decision**: `# now` is pre-injected into the trigger message.

**Rationale**: V2 AI wasted one tool call every run to read memory.
Pre-injection saves ~3 seconds and guarantees the AI sees current state.

### 6.3 `# now` / `# History` structure (V3)

**Decision**: memory.md has two `#`-level sections.

**Rationale**: Combines two needs:
- Stable working memory (`# now`) — edited in place, structure doesn't change
- Timeline context (`# History`) — append-only, gives AI awareness of recent events

The `#` level split enables `firstSection` extraction in `snapshot.ts` to
naturally capture the entire `# now` block for injection.

### 6.4 System-generated timestamps (V3)

**Decision**: The system pre-inserts `## YYYY-MM-DD-HHmm` at the top of
`# History` before each run.

**Rationale**: Guarantees consistent time format. AI doesn't need to know
or generate timestamps. AI only writes the semantic summary after `|`.

### 6.5 `memory/run/` subfolder (V3)

**Decision**: Session summaries go to `memory/run/` instead of `memory/`.

**Rationale**: Separates two types of archives:
- `memory/run/` = per-execution records (system-generated)
- `memory/` = compaction backups (old memory.md snapshots)

Clean separation allows AI to `Glob("memory/run/*.md")` for execution history.

### 6.6 Compaction threshold: 100KB (unchanged from V2)

**Decision**: File-size based, 100KB threshold.

Post-compaction, the LLM produces a new memory.md that preserves `# now` /
`# History` structure, keeping essential state and recent timeline entries.

### 6.7 Mandatory memory update

**Decision**: The Instructions section of the trigger message includes
"Update memory before reporting" as a requirement, not a suggestion.

**Rationale**: Memory is the core mechanism for long-term agent performance.
Skipping updates degrades future runs. Making it mandatory ensures the AI
always records what it learned.

---

## 7. File Organization (V3)

```
src/main/platform/memory/
  DESIGN.md          -- This file
  types.ts           -- MemoryService interface, scope types, constants
  paths.ts           -- Path resolution for all memory scopes
  permissions.ts     -- Permission matrix enforcement
  file-ops.ts        -- Low-level file I/O (read, write, archive, list)
  snapshot.ts        -- MemorySnapshot builder + memory_status MCP tool
  prompt.ts          -- MEMORY_INSTRUCTIONS (system prompt fragment)
  index.ts           -- initMemory(), MemoryService implementation, exports
  tools.ts           -- Legacy MCP tools (memory_read/write/list) — kept for compatibility

src/main/apps/runtime/
  prompt.ts          -- buildAppSystemPrompt(), buildInitialMessage(), buildMemorySection()
  prompt-chat.ts     -- Chat mode prompt (references native file tools)
  execute.ts         -- Run lifecycle: snapshot → pre-insert timestamp → run → session summary → compaction
```

---

## 8. Permission Matrix (unchanged)

```
                    space-memory   app-memory(A)   app-memory(B)   user-memory
User Session read      YES            NO              NO              YES
User Session write     YES            NO              NO              YES
App A read             YES            YES             NO              YES (read-only)
App A write            YES(append)    YES             NO              NO
App B read             YES            NO              YES             YES (read-only)
App B write            YES(append)    NO              YES             NO
```
