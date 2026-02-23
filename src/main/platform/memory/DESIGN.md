# platform/memory -- Design Decisions

> Date: 2026-02-22
> Status: V2 Implementation

---

## 1. Architecture Overview

The memory module provides persistent, cross-session memory for AI agents in Halo.
It exposes MCP tools (`memory_read` / `memory_write`) that AI agents call to
read and write markdown-based memory files, plus lifecycle hooks for compaction
and session summary.

**This is a pull-based system**: the AI decides when to read/write memory,
guided by system prompt instructions. We do not auto-inject memory into context.

**V2 additions**: Stratified read modes (headers/section/tail/full), state-document
write semantics (replace-first, not append-first), active compaction with
LLM-generated summaries, and size-aware prompt hints.

---

## 2. Key Design Decisions

### 2.1 memory_read supports multiple modes (V2)

**Decision**: `memory_read` accepts a `mode` parameter:

| Mode | Returns | Token Cost | Use Case |
|---|---|---|---|
| `headers` | Markdown heading lines with line numbers | Very low | Understand memory structure before loading |
| `section` | Content under a matched heading | Per-section | Load only relevant parts |
| `tail` | Last N lines (default 50) | Controllable | Check recent additions |
| `full` | Entire file (default, V1 behavior) | Full file | Small files or need everything |

**Rationale**: AI agents were reading the entire memory.md every run (V1),
wasting tokens on a file that grew linearly. `headers` → `section` is a
two-step read pattern that matches AI cognition (understand structure, then
drill in) and keeps token cost constant regardless of file size.

The `path` parameter still works for reading archive files; when `path` is
specified, `mode` is ignored.

### 2.2 Compaction threshold: file-size only (100KB), now actively invoked

**Decision**: Compaction triggers when `memory.md` exceeds 100KB.

**V2 change**: `execute.ts` now calls `needsCompaction()` + `compact()` after
every run, closing the gap where these functions existed but were never invoked.
The compaction flow:

1. Read current memory.md content
2. Archive it to `memory/YYYY-MM-DD-HHmm.md`
3. Call LLM to generate a concise state summary
4. Write the summary as the new memory.md
5. Fallback: if LLM fails, extract headings + last 100 lines

**Rationale**: LLM-generated compaction produces the highest quality summaries
because it understands context. The fallback ensures compaction still works
when API calls fail. The LLM call uses `@anthropic-ai/sdk` directly (not a
full SDK session) for minimal overhead.

### 2.3 memory.md is a state document, not a log (V2)

**Decision**: Prompt instructions and tool descriptions explicitly guide the AI
to treat memory.md as a **state document**:

- **Write**: patterns, tracking lists, decisions, config
- **Don't write**: execution timestamps, task confirmations, per-run diary entries
- **Replace over append**: when content is stale/duplicate, use `mode="replace"`
  to write a clean version

**Rationale**: V1 AI behavior defaulted to append-only logging, causing
memory.md to grow linearly (e.g., 68KB after 100 runs of a water reminder app).
V2 prompt engineering establishes the state-document mental model, and the
tool descriptions reinforce it with concrete good/bad examples.

### 2.4 Structured markdown headings for section-based reads (V2)

**Decision**: Tool descriptions and prompt instructions guide AI to structure
memory.md with consistent markdown headings (`## State`, `## Patterns`,
`## Config`).

**Rationale**: `mode="headers"` → `mode="section"` only works if the AI
writes structured content. This creates a closed loop: structured writes
enable efficient reads, which reinforces structured writes.

### 2.5 Prompt includes file size hints (V2)

**Decision**: `getPromptInstructions()` now checks file sizes and includes
them in the prompt (e.g., "app (4.2KB)"). Files over 4KB trigger an explicit
hint to use `mode="headers"` first.

**Rationale**: Gives the AI contextual information to choose the right read
strategy without always defaulting to `mode="full"`.

### 2.6 Append-only enforcement for App -> space-memory writes

**Decision**: When an App scope writes to space memory, the `write` method
enforces `mode: 'append'` at the code level. If `mode: 'replace'` is
requested by an App for space-memory scope, the operation throws an error.

**Implementation**: The `createTools` function generates tool definitions
where the `scope` parameter options are pre-filtered based on the caller's
scope. An App only sees `scope: "app"` and `scope: "space"` in its tools.
Additionally, the `write()` method performs a server-side check.

### 2.7 Session summary slug generation: timestamp-based with optional hint

**Decision**: Session summaries use the format `YYYY-MM-DD-HHmm.md` by
default. The `saveSessionSummary` method accepts an optional `slug` parameter.
The memory module itself does NOT call LLMs -- that responsibility belongs
to apps/runtime.

### 2.8 MCP tool format: SDK `tool()` + `createSdkMcpServer()`

**Decision**: Tools are defined using `@anthropic-ai/claude-agent-sdk`'s
`tool()` helper and packaged via `createSdkMcpServer()`, exactly matching
the pattern used by `sdk-mcp-server.ts` for AI Browser tools.

### 2.9 user-memory path: `{haloDir}/user-memory.md`

**Decision**: User-level memory lives at `~/.halo/user-memory.md` (or
`~/.halo-dev/user-memory.md` in dev mode), obtained via `getHaloDir()`.

### 2.10 App memory path: `{spacePath}/apps/{appId}/memory.md`

**Decision**: App private memory is at `{spacePath}/apps/{appId}/memory.md`
with `memory/` subdirectory for archives.

### 2.11 Concurrent write safety

**Decision**: Append operations use `fs.appendFile` which provides POSIX
atomicity guarantees for small writes. Each append is prefixed with a
metadata comment: `<!-- {timestamp} by {source} -->`. Replace operations
use atomic write-via-temp-file pattern (write to `.tmp`, then `rename`).

---

## 3. File Organization

```
src/main/platform/memory/
  DESIGN.md          -- This file
  types.ts           -- MemoryScope, MemoryService interface, MemoryReadMode, tool-related types
  paths.ts           -- Path resolution for all memory scopes
  permissions.ts     -- Permission matrix enforcement
  tools.ts           -- MCP tool definitions (memory_read, memory_write, memory_list)
  file-ops.ts        -- Low-level file I/O (read, readHeadings, readSection, readTail, write, archive)
  prompt.ts          -- getPromptInstructions() generation (V2: size-aware, state-document rules)
  index.ts           -- initMemory(), MemoryService implementation, exports
```

---

## 4. Integration Points

```
apps/runtime/execute.ts
  |-- calls memory.createTools(scope) --> gets MCP server for session
  |-- calls memory.getPromptInstructions(scope) --> gets system prompt fragment
  |-- calls memory.saveSessionSummary(scope, ...) --> session end
  |-- calls memory.needsCompaction(scope, 'app') --> post-run check (V2)
  |-- calls memory.compact(scope, 'app') --> archive + LLM summary (V2)

bootstrap/extended.ts
  |-- calls initMemory() --> returns MemoryService (no deps)

services/agent/send-message.ts
  |-- injects memory MCP server into mcpServers config
```

---

## 5. Permission Matrix Implementation

```
                    space-memory   app-memory(A)   app-memory(B)   user-memory
User Session read      YES            NO              NO              YES
User Session write     YES            NO              NO              YES
App A read             YES            YES             NO              YES (read-only)
App A write            YES(append)    YES             NO              NO
App B read             YES            NO              YES             YES (read-only)
App B write            YES(append)    NO              YES             NO
```

Enforcement layers:
1. **Tool definition**: `createTools(scope)` generates different tool schemas
   per scope, controlling what `scope` values the AI can pass
2. **Runtime check**: `write()` validates permissions before any file I/O
3. **Path isolation**: `resolvePath()` maps scope to filesystem path,
   making cross-app access structurally impossible

---

## 6. V2 Read/Write Lifecycle (Optimal Flow)

```
Run Start
  │
  ├─ memory_read(mode="headers")          ← Low-cost structure scan
  │    │
  │    ├─ File small / no headers → memory_read(mode="full")    ← Fallback
  │    │
  │    └─ Has headers → memory_read(mode="section", section="relevant")
  │         └─ Only loads needed content         ← Precise, token-efficient
  │
  ├─ Execute task...
  │
  └─ memory_write
       │
       ├─ State changed → mode="replace", write clean structured state
       │
       └─ State unchanged → don't write
  │
Run End
  │
  ├─ saveRunSessionSummary()               ← Execution log to memory/ archive
  │
  └─ needsCompaction() check
       │
       ├─ Under 100KB → skip
       │
       └─ Over 100KB → compact()
            ├─ Archive old memory.md
            ├─ LLM generates distilled summary
            └─ Write summary as new memory.md
```
